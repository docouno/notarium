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
import type { PgDriverCtx } from './context'
import {
  lockProviderCredentialRange,
  lockProviderResourceRange,
  lockSecretKeyring,
} from './lockOrder'

type CredentialCiphertextRow = { id: string; owner: string; secret: string }
type ResourceCiphertextRow = {
  id: string
  owner: string
  credential_id: string | null
  headers: string
}

const inventory = async (
  query: PgDriverCtx['required']['query'],
): Promise<{
  credentials: ProviderCredentialCiphertexts[]
  resources: ProviderResourceCiphertexts[]
}> => {
  const [credentials, resources] = await Promise.all([
    query('SELECT id, owner, secret FROM credentials ORDER BY id'),
    query('SELECT id, owner, credential_id, headers FROM provider_resources ORDER BY id'),
  ])
  return {
    credentials: credentials.rows as CredentialCiphertextRow[],
    resources: (resources.rows as ResourceCiphertextRow[]).map((row) => ({
      id: row.id,
      owner: row.owner,
      credentialId: row.credential_id,
      headers: JSON.parse(row.headers) as Record<string, string>,
    })),
  }
}

const countReferences = async (
  query: PgDriverCtx['required']['query'],
  keyIds: ReadonlySet<string>,
): Promise<ProviderCiphertextCounts> => {
  const ids = [...keyIds].sort()
  const [credentials, headers] = await Promise.all([
    query(
      `SELECT COUNT(*) AS n FROM credentials
        WHERE left(secret, 3) = 'v1.' AND substring(secret FROM 31 FOR 1) = '.'
          AND substring(secret FROM 4 FOR 27) = ANY($1::text[])`,
      [ids],
    ),
    query(
      `SELECT COUNT(*) AS n
         FROM provider_resources AS resource
         CROSS JOIN LATERAL jsonb_each_text(resource.headers::jsonb) AS header
        WHERE left(header.value, 3) = 'v1.' AND substring(header.value FROM 31 FOR 1) = '.'
          AND substring(header.value FROM 4 FOR 27) = ANY($1::text[])`,
      [ids],
    ),
  ])

  return {
    credentials: Number((credentials.rows[0] as { n: string | number }).n),
    headers: Number((headers.rows[0] as { n: string | number }).n),
  }
}

const ciphertextBatch = async (
  query: PgDriverCtx['required']['query'],
  keyIds: ReadonlySet<string>,
  limit: number,
): Promise<ProviderCiphertextCarrier[]> => {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error('provider ciphertext batch limit must be a positive safe integer')
  }
  const ids = [...keyIds].sort()
  const credentials = await query(
    `SELECT id AS record_id, secret AS ciphertext FROM credentials
      WHERE left(secret, 3) = 'v1.' AND substring(secret FROM 31 FOR 1) = '.'
        AND substring(secret FROM 4 FOR 27) = ANY($1::text[])
      ORDER BY id LIMIT $2`,
    [ids, limit],
  )
  const carriers: ProviderCiphertextCarrier[] = (
    credentials.rows as Array<{ record_id: string; ciphertext: string }>
  ).map((row) => ({
    kind: 'credential',
    recordId: row.record_id,
    field: 'secret',
    ciphertext: row.ciphertext,
  }))
  const remaining = limit - carriers.length

  if (remaining === 0) {
    return carriers
  }
  const headers = await query(
    `SELECT resource.id AS record_id, header.key AS field, header.value AS ciphertext
       FROM provider_resources AS resource
       CROSS JOIN LATERAL jsonb_each_text(resource.headers::jsonb) AS header
      WHERE left(header.value, 3) = 'v1.' AND substring(header.value FROM 31 FOR 1) = '.'
        AND substring(header.value FROM 4 FOR 27) = ANY($1::text[])
      ORDER BY resource.id, header.key LIMIT $2`,
    [ids, remaining],
  )

  return carriers.concat(
    (headers.rows as Array<{ record_id: string; field: string; ciphertext: string }>).map(
      (row) => ({
        kind: 'header' as const,
        recordId: row.record_id,
        field: row.field,
        ciphertext: row.ciphertext,
      }),
    ),
  )
}

const assertActiveKey = async (
  client: Parameters<typeof lockSecretKeyring>[0],
  active: CiphertextWrite,
): Promise<void> => {
  await lockSecretKeyring(client)
  const result = await client.query(
    "SELECT key_id, generation FROM secret_keyring WHERE state = 'active' AND retired_at IS NULL",
  )
  const row = result.rows[0] as { key_id: string; generation: string | number } | undefined

  if (row?.key_id !== active.keyId || Number(row.generation) !== active.generation) {
    throw providerPersistenceError(
      PROVIDER_PERSISTENCE_ERROR.staleCiphertextKey,
      'credential key changed during provider ciphertext maintenance',
    )
  }
}

export const createProviderCiphertextsFacet = (
  ctx: PgDriverCtx,
): ProviderCiphertextsPersistence => ({
  hasCiphertext: async () => {
    await ctx.ensureInit()
    const result = await ctx.required.query(
      `SELECT EXISTS(SELECT 1 FROM credentials LIMIT 1)
           OR EXISTS(
             SELECT 1 FROM provider_resources
              WHERE headers::jsonb <> '{}'::jsonb LIMIT 1
           ) AS found`,
    )
    return Boolean((result.rows[0] as { found: boolean }).found)
  },
  previewUnreadable: async (readableKeyIds) => {
    await ctx.ensureInit()
    const world = await inventory(ctx.required.query.bind(ctx.required))
    return providerUnreadablePlan(world.credentials, world.resources, readableKeyIds)
  },
  purgeUnreadable: async (readableKeyIds, changedAt) => {
    await ctx.ensureInit()
    const client = await ctx.required.connect()

    try {
      await client.query('BEGIN')
      await lockSecretKeyring(client)
      await lockProviderCredentialRange(client)
      await lockProviderResourceRange(client)
      const world = await inventory(client.query.bind(client))
      const plan = providerUnreadablePlan(world.credentials, world.resources, readableKeyIds)
      const badCredentials = new Set(
        plan.affected
          .filter((impact) => impact.kind === 'credential')
          .map((impact) => impact.recordId),
      )
      const badHeaders = new Set(
        plan.affected.filter((impact) => impact.kind === 'header').map((impact) => impact.recordId),
      )
      const changed = world.resources.filter(
        (resource) =>
          badHeaders.has(resource.id) || badCredentials.has(resource.credentialId ?? ''),
      )

      if (changed.length > 0) {
        const result = await client.query(
          `UPDATE provider_resources AS resource
              SET headers = changed.headers, credential_id = changed.credential_id,
                  disabled_at = $4, runtime_epoch = resource.runtime_epoch + 1,
                  last_check = '{}'
             FROM UNNEST($1::text[], $2::text[], $3::text[])
               AS changed(id, headers, credential_id)
            WHERE resource.id = changed.id`,
          [
            changed.map(({ id }) => id),
            changed.map((resource) =>
              JSON.stringify(readableProviderHeaders(resource, readableKeyIds)),
            ),
            changed.map((resource) =>
              badCredentials.has(resource.credentialId ?? '') ? null : resource.credentialId,
            ),
            changedAt,
          ],
        )

        if (result.rowCount !== changed.length) {
          throw new Error('provider resource disappeared during unreadable-secret purge')
        }
      }
      if (badCredentials.size > 0) {
        await client.query('DELETE FROM credentials WHERE id = ANY($1::text[])', [
          [...badCredentials].sort(),
        ])
      }
      await client.query('COMMIT')
      return plan
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  },
  countReferences: async (keyIds) => {
    await ctx.ensureInit()
    return countReferences(ctx.required.query.bind(ctx.required), keyIds)
  },
  rewrapBatch: async ({ active, sourceKeyIds, limit, rewrap }) => {
    await ctx.ensureInit()
    const client = await ctx.required.connect()

    try {
      await client.query('BEGIN')
      await assertActiveKey(client, active)
      await lockProviderCredentialRange(client)
      await lockProviderResourceRange(client)
      const carriers = await ciphertextBatch(client.query.bind(client), sourceKeyIds, limit)
      const rewrapped = { credentials: 0, headers: 0 }
      const credentialChanges: Array<{ id: string; before: string; after: string }> = []
      const headerChanges = new Map<
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
          credentialChanges.push({
            id: carrier.recordId,
            before: carrier.ciphertext,
            after: ciphertext,
          })
          rewrapped.credentials += 1
          continue
        }
        const changes = headerChanges.get(carrier.recordId) ?? []
        changes.push({ field: carrier.field, before: carrier.ciphertext, after: ciphertext })
        headerChanges.set(carrier.recordId, changes)
        rewrapped.headers += 1
      }

      if (credentialChanges.length > 0) {
        const updated = await client.query(
          `UPDATE credentials AS credential SET secret = changed.after
             FROM UNNEST($1::text[], $2::text[], $3::text[])
               AS changed(id, before, after)
            WHERE credential.id = changed.id AND credential.secret = changed.before
            RETURNING credential.id`,
          [
            credentialChanges.map(({ id }) => id),
            credentialChanges.map(({ before }) => before),
            credentialChanges.map(({ after }) => after),
          ],
        )

        if (updated.rowCount !== credentialChanges.length) {
          throw new Error('credential changed during serialized batch rewrap')
        }
      }
      if (headerChanges.size > 0) {
        const resourceIds = [...headerChanges.keys()].sort()
        const stored = await client.query(
          'SELECT id, headers FROM provider_resources WHERE id = ANY($1::text[]) ORDER BY id',
          [resourceIds],
        )

        if (stored.rowCount !== resourceIds.length) {
          throw new Error('provider resource disappeared during serialized rewrap')
        }
        const rows = stored.rows as Array<{ id: string; headers: string }>
        const before: string[] = []
        const after: string[] = []

        for (const row of rows) {
          const headers = JSON.parse(row.headers) as Record<string, string>

          for (const change of headerChanges.get(row.id)!) {
            if (headers[change.field] !== change.before) {
              throw new Error(`provider header changed during serialized rewrap: ${row.id}`)
            }
            headers[change.field] = change.after
          }
          before.push(row.headers)
          after.push(JSON.stringify(headers))
        }
        const updated = await client.query(
          `UPDATE provider_resources AS resource SET headers = changed.after
             FROM UNNEST($1::text[], $2::text[], $3::text[])
               AS changed(id, before, after)
            WHERE resource.id = changed.id AND resource.headers = changed.before
            RETURNING resource.id`,
          [resourceIds, before, after],
        )

        if (updated.rowCount !== resourceIds.length) {
          throw new Error('provider resource changed during serialized batch rewrap')
        }
      }
      await client.query('COMMIT')
      return { rewrapped }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  },
  retireKeys: async ({ active, sourceKeyIds, retiredAt }) => {
    await ctx.ensureInit()
    const client = await ctx.required.connect()

    try {
      await client.query('BEGIN')
      await assertActiveKey(client, active)
      const references = await countReferences(client.query.bind(client), sourceKeyIds)

      if (references.credentials > 0 || references.headers > 0) {
        await client.query('COMMIT')
        return { status: 'references-remain', references }
      }
      const keyIds = [...sourceKeyIds].sort()

      if (keyIds.includes(active.keyId)) {
        throw new Error('the active credential key cannot be retired')
      }
      const result = await client.query(
        `UPDATE secret_keyring SET retired_at = $2
          WHERE key_id = ANY($1::text[]) AND state = 'readable' AND retired_at IS NULL
          RETURNING key_id`,
        [keyIds, retiredAt],
      )
      await client.query('COMMIT')
      return {
        status: 'retired',
        references,
        retiredKeyIds: (result.rows as Array<{ key_id: string }>).map((row) => row.key_id).sort(),
      }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  },
})
