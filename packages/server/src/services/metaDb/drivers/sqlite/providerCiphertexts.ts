import {
  providerCiphertextKeyId,
  type ProviderCredentialCiphertexts,
  type ProviderResourceCiphertexts,
  providerUnreadablePlan,
  readableProviderHeaders,
} from '../../providerCiphertexts'
import { PROVIDER_PERSISTENCE_ERROR, providerPersistenceError } from '../../types'
import type {
  CiphertextWrite,
  ProviderCiphertextCarrier,
  ProviderCiphertextCounts,
  ProviderCiphertextsPersistence,
} from '../../types'
import type { SqliteDriverCtx } from './context'

type CredentialCiphertextRow = { id: string; owner: string; secret: string }
type ResourceCiphertextRow = {
  id: string
  owner: string
  credential_id: string | null
  headers: string
}

const resourceCiphertextsOfRow = (row: ResourceCiphertextRow): ProviderResourceCiphertexts => ({
  id: row.id,
  owner: row.owner,
  credentialId: row.credential_id,
  headers: JSON.parse(row.headers) as Record<string, string>,
})

/** Recovery needs carrier ownership and references, not the resource's potentially
 *  512-model management DTO. Keep the disaster path linear in the actual secrets. */
const inventory = (
  ctx: SqliteDriverCtx,
): {
  credentials: ProviderCredentialCiphertexts[]
  resources: ProviderResourceCiphertexts[]
} => ({
  credentials: ctx.required
    .prepare('SELECT id, owner, secret FROM credentials ORDER BY id')
    .all() as CredentialCiphertextRow[],
  resources: (
    ctx.required
      .prepare('SELECT id, owner, credential_id, headers FROM provider_resources ORDER BY id')
      .all() as ResourceCiphertextRow[]
  ).map(resourceCiphertextsOfRow),
})

const sourceIds = (keyIds: ReadonlySet<string>): string => JSON.stringify([...keyIds].sort())

const countReferences = (
  ctx: SqliteDriverCtx,
  keyIds: ReadonlySet<string>,
): ProviderCiphertextCounts => {
  const ids = sourceIds(keyIds)
  const credentials = ctx.required
    .prepare(
      `SELECT COUNT(*) AS n FROM credentials
        WHERE substr(secret, 1, 3) = 'v1.' AND substr(secret, 31, 1) = '.'
          AND substr(secret, 4, 27) IN (SELECT value FROM json_each(?))`,
    )
    .get(ids) as { n: number }
  const headers = ctx.required
    .prepare(
      `SELECT COUNT(*) AS n
         FROM provider_resources AS resource, json_each(resource.headers) AS header
        WHERE substr(header.value, 1, 3) = 'v1.' AND substr(header.value, 31, 1) = '.'
          AND substr(header.value, 4, 27) IN (SELECT value FROM json_each(?))`,
    )
    .get(ids) as { n: number }

  return { credentials: credentials.n, headers: headers.n }
}

const ciphertextBatch = (
  ctx: SqliteDriverCtx,
  keyIds: ReadonlySet<string>,
  limit: number,
): ProviderCiphertextCarrier[] => {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error('provider ciphertext batch limit must be a positive safe integer')
  }
  const ids = sourceIds(keyIds)
  const credentials = ctx.required
    .prepare(
      `SELECT id AS record_id, secret AS ciphertext FROM credentials
        WHERE substr(secret, 1, 3) = 'v1.' AND substr(secret, 31, 1) = '.'
          AND substr(secret, 4, 27) IN (SELECT value FROM json_each(?))
        ORDER BY id LIMIT ?`,
    )
    .all(ids, limit) as Array<{ record_id: string; ciphertext: string }>
  const carriers: ProviderCiphertextCarrier[] = credentials.map((row) => ({
    kind: 'credential',
    recordId: row.record_id,
    field: 'secret',
    ciphertext: row.ciphertext,
  }))
  const remaining = limit - carriers.length

  if (remaining === 0) {
    return carriers
  }
  const headers = ctx.required
    .prepare(
      `SELECT resource.id AS record_id, header.key AS field, header.value AS ciphertext
         FROM provider_resources AS resource, json_each(resource.headers) AS header
        WHERE substr(header.value, 1, 3) = 'v1.' AND substr(header.value, 31, 1) = '.'
          AND substr(header.value, 4, 27) IN (SELECT value FROM json_each(?))
        ORDER BY resource.id, header.key LIMIT ?`,
    )
    .all(ids, remaining) as Array<{ record_id: string; field: string; ciphertext: string }>

  return carriers.concat(
    headers.map((row) => ({
      kind: 'header' as const,
      recordId: row.record_id,
      field: row.field,
      ciphertext: row.ciphertext,
    })),
  )
}

const assertActiveKey = (ctx: SqliteDriverCtx, active: CiphertextWrite): void => {
  const row = ctx.required
    .prepare(
      "SELECT key_id, generation FROM secret_keyring WHERE state = 'active' AND retired_at IS NULL",
    )
    .get() as { key_id: string; generation: number } | undefined

  if (row?.key_id !== active.keyId || row.generation !== active.generation) {
    throw providerPersistenceError(
      PROVIDER_PERSISTENCE_ERROR.staleCiphertextKey,
      'credential key changed during provider ciphertext maintenance',
    )
  }
}

export const createProviderCiphertextsFacet = (
  ctx: SqliteDriverCtx,
): ProviderCiphertextsPersistence => ({
  hasCiphertext: async () => {
    await ctx.ensureInit()
    const row = ctx.required
      .prepare(
        `SELECT EXISTS(SELECT 1 FROM credentials LIMIT 1)
             OR EXISTS(
               SELECT 1 FROM provider_resources AS resource,
                 json_each(resource.headers) AS header LIMIT 1
             ) AS found`,
      )
      .get() as { found: number }
    return row.found === 1
  },
  previewUnreadable: async (readableKeyIds) => {
    await ctx.ensureInit()
    const world = inventory(ctx)
    return providerUnreadablePlan(world.credentials, world.resources, readableKeyIds)
  },
  purgeUnreadable: async (readableKeyIds, changedAt) => {
    await ctx.ensureInit()
    const db = ctx.required
    db.exec('BEGIN IMMEDIATE')
    try {
      const world = inventory(ctx)
      const plan = providerUnreadablePlan(world.credentials, world.resources, readableKeyIds)
      const badCredentials = new Set(
        plan.affected
          .filter((impact) => impact.kind === 'credential')
          .map((impact) => impact.recordId),
      )
      const badHeaders = new Set(
        plan.affected.filter((impact) => impact.kind === 'header').map((impact) => impact.recordId),
      )
      const update = db.prepare(
        `UPDATE provider_resources SET headers = ?, credential_id = ?, disabled_at = ?,
           runtime_epoch = runtime_epoch + 1, last_check = '{}'
         WHERE id = ?`,
      )

      for (const resource of world.resources) {
        if (!badHeaders.has(resource.id) && !badCredentials.has(resource.credentialId ?? '')) {
          continue
        }
        update.run(
          JSON.stringify(readableProviderHeaders(resource, readableKeyIds)),
          badCredentials.has(resource.credentialId ?? '') ? null : resource.credentialId,
          changedAt,
          resource.id,
        )
      }
      const remove = db.prepare('DELETE FROM credentials WHERE id = ?')

      for (const id of [...badCredentials].sort()) {
        remove.run(id)
      }
      db.exec('COMMIT')
      return plan
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  },
  countReferences: async (keyIds) => {
    await ctx.ensureInit()
    return countReferences(ctx, keyIds)
  },
  rewrapBatch: async ({ active, sourceKeyIds, limit, rewrap }) => {
    await ctx.ensureInit()
    const db = ctx.required
    db.exec('BEGIN IMMEDIATE')
    try {
      assertActiveKey(ctx, active)
      const carriers = ciphertextBatch(ctx, sourceKeyIds, limit)
      const rewrapped = { credentials: 0, headers: 0 }
      const credentialUpdate = db.prepare(
        'UPDATE credentials SET secret = ? WHERE id = ? AND secret = ?',
      )
      const changedHeaders = new Map<
        string,
        Array<{ field: string; before: string; after: string }>
      >()

      for (const carrier of carriers) {
        const ciphertext = await rewrap(carrier)

        if (providerCiphertextKeyId(ciphertext) !== active.keyId) {
          throw providerPersistenceError(
            PROVIDER_PERSISTENCE_ERROR.staleCiphertextKey,
            'rewrapped provider ciphertext does not use the active credential key',
          )
        }
        if (carrier.kind === 'credential') {
          if (
            credentialUpdate.run(ciphertext, carrier.recordId, carrier.ciphertext).changes !== 1
          ) {
            throw new Error(`credential changed during serialized rewrap: ${carrier.recordId}`)
          }
          rewrapped.credentials += 1
          continue
        }
        const changes = changedHeaders.get(carrier.recordId) ?? []
        changes.push({ field: carrier.field, before: carrier.ciphertext, after: ciphertext })
        changedHeaders.set(carrier.recordId, changes)
        rewrapped.headers += 1
      }
      const resourceUpdate = db.prepare(
        'UPDATE provider_resources SET headers = ? WHERE id = ? AND headers = ?',
      )

      if (changedHeaders.size > 0) {
        const rows = db
          .prepare(
            `SELECT id, headers FROM provider_resources
              WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id`,
          )
          .all(JSON.stringify([...changedHeaders.keys()].sort())) as Array<{
          id: string
          headers: string
        }>

        if (rows.length !== changedHeaders.size) {
          throw new Error('provider resource disappeared during serialized rewrap')
        }
        for (const row of rows) {
          const headers = JSON.parse(row.headers) as Record<string, string>

          for (const change of changedHeaders.get(row.id)!) {
            if (headers[change.field] !== change.before) {
              throw new Error(`provider header changed during serialized rewrap: ${row.id}`)
            }
            headers[change.field] = change.after
          }
          if (resourceUpdate.run(JSON.stringify(headers), row.id, row.headers).changes !== 1) {
            throw new Error(`provider resource changed during serialized rewrap: ${row.id}`)
          }
        }
      }
      db.exec('COMMIT')
      return { rewrapped }
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  },
  retireKeys: async ({ active, sourceKeyIds, retiredAt }) => {
    await ctx.ensureInit()
    const db = ctx.required
    db.exec('BEGIN IMMEDIATE')
    try {
      assertActiveKey(ctx, active)
      const references = countReferences(ctx, sourceKeyIds)

      if (references.credentials > 0 || references.headers > 0) {
        db.exec('COMMIT')
        return { status: 'references-remain', references }
      }
      const retiredKeyIds: string[] = []
      const retire = db.prepare(
        "UPDATE secret_keyring SET retired_at = ? WHERE key_id = ? AND state = 'readable' AND retired_at IS NULL",
      )

      for (const keyId of [...sourceKeyIds].sort()) {
        if (keyId === active.keyId) {
          throw new Error('the active credential key cannot be retired')
        }
        if (retire.run(retiredAt, keyId).changes > 0) {
          retiredKeyIds.push(keyId)
        }
      }
      db.exec('COMMIT')
      return { status: 'retired', references, retiredKeyIds }
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  },
})
