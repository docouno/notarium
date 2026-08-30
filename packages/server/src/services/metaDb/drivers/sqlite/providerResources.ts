import { DEFAULT_CREDENTIAL_HEADER } from '@notarium/contract'
import {
  credentialOfRow,
  type CredentialRow,
  providerResourceOfRow,
  type ProviderResourceRow,
} from '../../rows'
import type {
  CiphertextWrite,
  CredentialRecord,
  ProviderResourceRecord,
  ProviderResourcesPersistence,
} from '../../types'
import { PROVIDER_PERSISTENCE_ERROR, providerPersistenceError } from '../../types'
import { mergedProviderModels } from '../providerModels'
import type { SqliteDriverCtx } from './context'
import { transitionProviderAttachments } from './providerAttachments'

const activeKey = (
  ctx: SqliteDriverCtx,
  ciphertext: CiphertextWrite | null,
  hasHeaders: boolean,
): void => {
  if (!hasHeaders) {
    return
  }
  if (!ciphertext) {
    throw providerPersistenceError(
      PROVIDER_PERSISTENCE_ERROR.staleCiphertextKey,
      'encrypted provider headers need an active credential key witness',
    )
  }
  const row = ctx.required
    .prepare(
      "SELECT key_id, generation FROM secret_keyring WHERE state = 'active' AND retired_at IS NULL",
    )
    .get() as { key_id: string; generation: number } | undefined

  if (row?.key_id !== ciphertext.keyId || row.generation !== ciphertext.generation) {
    throw providerPersistenceError(
      PROVIDER_PERSISTENCE_ERROR.staleCiphertextKey,
      'provider headers were not encrypted by the active credential key',
    )
  }
}

const credentialFor = (
  ctx: SqliteDriverCtx,
  record: ProviderResourceRecord,
): CredentialRecord | null => {
  if (!record.credentialId) {
    return null
  }
  const row = ctx.required
    .prepare('SELECT * FROM credentials WHERE id = ?')
    .get(record.credentialId) as CredentialRow | undefined

  if (!row) {
    throw providerPersistenceError(
      PROVIDER_PERSISTENCE_ERROR.credentialNotOwned,
      'provider credential is unavailable',
    )
  }
  const credential = credentialOfRow(row)

  if (credential.owner !== record.owner) {
    throw providerPersistenceError(
      PROVIDER_PERSISTENCE_ERROR.credentialNotOwned,
      'provider resource may reference only its owner credential',
    )
  }
  if (credential.origin !== new URL(record.baseUrl).origin) {
    throw providerPersistenceError(
      PROVIDER_PERSISTENCE_ERROR.credentialOriginMismatch,
      'provider resource and credential origins differ',
    )
  }
  const injectionHeader =
    credential.injection.header || DEFAULT_CREDENTIAL_HEADER[credential.kind][record.wire]

  if (Object.hasOwn(record.headers, injectionHeader)) {
    throw providerPersistenceError(
      PROVIDER_PERSISTENCE_ERROR.credentialInjectionCollision,
      'provider header collides with credential injection',
    )
  }

  return credential
}

const insertValues = (record: ProviderResourceRecord): Array<string | number | null> => [
  record.id,
  record.owner,
  record.name,
  record.wire,
  record.baseUrl,
  JSON.stringify(record.headers),
  record.allowPrivateNetwork ? 1 : 0,
  JSON.stringify(record.purposes),
  JSON.stringify(record.models),
  record.defaultModel,
  record.credentialId,
  record.consentEpoch,
  record.runtimeEpoch,
  record.disabledAt,
  JSON.stringify(record.lastCheck),
  record.firstByteTimeoutMs,
  record.callTimeoutMs,
]

const EFFECTIVE_CANDIDATE = `
  FROM provider_resources AS resource
  WHERE (resource.owner = ? OR EXISTS (
    SELECT 1 FROM provider_attachments AS attachment
     WHERE attachment.resource_id = resource.id
       AND attachment.target_space IN (SELECT value FROM json_each(?))
       AND attachment.state IN ('active', 'awaiting-reconsent')
  ))`

export const createProviderResourcesFacet = (
  ctx: SqliteDriverCtx,
): ProviderResourcesPersistence => ({
  create: async (record, ciphertext) => {
    await ctx.ensureInit()
    const db = ctx.required
    db.exec('BEGIN IMMEDIATE')
    try {
      activeKey(ctx, ciphertext, Object.keys(record.headers).length > 0)
      credentialFor(ctx, record)
      db.prepare(
        `INSERT INTO provider_resources
          (id, owner, name, wire, base_url, headers, allow_private_network, purposes,
           models, default_model, credential_id, consent_epoch, runtime_epoch, disabled_at,
           last_check, first_byte_timeout_ms, call_timeout_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(...insertValues(record))
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  },
  replaceIfRuntimeEpoch: async (
    record,
    ciphertext,
    expectedRuntimeEpoch,
    expectedCredentialId,
    preserveModels = false,
  ) => {
    await ctx.ensureInit()
    const db = ctx.required
    db.exec('BEGIN IMMEDIATE')
    try {
      activeKey(ctx, ciphertext, Object.keys(record.headers).length > 0)
      const currentRow = db
        .prepare('SELECT * FROM provider_resources WHERE id = ?')
        .get(record.id) as ProviderResourceRow | undefined

      if (!currentRow) {
        db.exec('COMMIT')
        return { status: 'missing' }
      }
      const current = providerResourceOfRow(currentRow)

      if (
        current.runtimeEpoch !== expectedRuntimeEpoch ||
        current.credentialId !== expectedCredentialId
      ) {
        db.exec('COMMIT')
        return { status: 'conflict', record: current }
      }
      credentialFor(ctx, record)
      const stored = {
        ...record,
        models: preserveModels ? current.models : record.models,
        lastCheck:
          record.runtimeEpoch === expectedRuntimeEpoch ? current.lastCheck : record.lastCheck,
      }
      db.prepare(
        `UPDATE provider_resources SET
           owner = ?, name = ?, wire = ?, base_url = ?, headers = ?,
           allow_private_network = ?, purposes = ?, models = ?, default_model = ?,
           credential_id = ?, consent_epoch = ?, runtime_epoch = ?, disabled_at = ?,
           last_check = ?, first_byte_timeout_ms = ?, call_timeout_ms = ?
         WHERE id = ? AND runtime_epoch = ?`,
      ).run(...insertValues(stored).slice(1), record.id, expectedRuntimeEpoch)
      if (stored.consentEpoch !== current.consentEpoch) {
        transitionProviderAttachments(ctx, [record.id])
      }
      const storedRow = db
        .prepare('SELECT * FROM provider_resources WHERE id = ?')
        .get(record.id) as ProviderResourceRow
      db.exec('COMMIT')
      return { status: 'replaced', record: providerResourceOfRow(storedRow) }
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  },
  get: async (id) => {
    await ctx.ensureInit()
    const row = ctx.required.prepare('SELECT * FROM provider_resources WHERE id = ?').get(id) as
      ProviderResourceRow | undefined
    return row ? providerResourceOfRow(row) : null
  },
  getMany: async (ids) => {
    if (ids.length === 0) {
      return []
    }
    await ctx.ensureInit()
    return (
      ctx.required
        .prepare(
          'SELECT * FROM provider_resources WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id',
        )
        .all(JSON.stringify([...new Set(ids)])) as ProviderResourceRow[]
    ).map(providerResourceOfRow)
  },
  pageIdsForOwner: async (owner, input) => {
    await ctx.ensureInit()
    const after = input.after
    const total = ctx.required
      .prepare('SELECT COUNT(*) AS n FROM provider_resources WHERE owner = ?')
      .get(owner) as { n: number }
    const rows = ctx.required
      .prepare(
        `SELECT id FROM provider_resources
          WHERE owner = ?
            AND (? IS NULL OR name COLLATE BINARY > ? OR
              (name COLLATE BINARY = ? AND id COLLATE BINARY > ?))
          ORDER BY name COLLATE BINARY, id COLLATE BINARY LIMIT ?`,
      )
      .all(
        owner,
        after?.sort ?? null,
        after?.sort ?? '',
        after?.sort ?? '',
        after?.id ?? '',
        Math.max(1, Math.min(input.limit, 1_000)),
      ) as Array<{ id: string }>

    return { ids: rows.map(({ id }) => id), total: total.n }
  },
  pageEffectiveIds: async (owner, spaces, input) => {
    await ctx.ensureInit()
    const after = input.after
    const targetSpaces = JSON.stringify([...new Set(spaces)])
    const total = ctx.required
      .prepare(`SELECT COUNT(*) AS n ${EFFECTIVE_CANDIDATE}`)
      .get(owner, targetSpaces) as { n: number }
    const rows = ctx.required
      .prepare(
        `SELECT resource.id ${EFFECTIVE_CANDIDATE}
          AND (? IS NULL OR resource.name COLLATE BINARY > ? OR
            (resource.name COLLATE BINARY = ? AND resource.id COLLATE BINARY > ?))
          ORDER BY resource.name COLLATE BINARY, resource.id COLLATE BINARY LIMIT ?`,
      )
      .all(
        owner,
        targetSpaces,
        after?.sort ?? null,
        after?.sort ?? '',
        after?.sort ?? '',
        after?.id ?? '',
        Math.max(1, Math.min(input.limit, 1_000)),
      ) as Array<{ id: string }>

    return { ids: rows.map(({ id }) => id), total: total.n }
  },
  scanEffectivePage: async (owner, spaces, input) => {
    await ctx.ensureInit()
    const after = input.after
    const targetSpaces = JSON.stringify([...new Set(spaces)])
    const limit = Math.max(1, Math.min(input.limit, 1_000))
    const rows = ctx.required
      .prepare(
        `SELECT resource.name AS sort, resource.id ${EFFECTIVE_CANDIDATE}
          AND (? IS NULL OR resource.name COLLATE BINARY > ? OR
            (resource.name COLLATE BINARY = ? AND resource.id COLLATE BINARY > ?))
          ORDER BY resource.name COLLATE BINARY, resource.id COLLATE BINARY LIMIT ?`,
      )
      .all(
        owner,
        targetSpaces,
        after?.sort ?? null,
        after?.sort ?? '',
        after?.sort ?? '',
        after?.id ?? '',
        limit + 1,
      ) as Array<{ sort: string; id: string }>

    return { positions: rows.slice(0, limit), hasMore: rows.length > limit }
  },
  list: async () => {
    await ctx.ensureInit()
    return (
      ctx.required
        .prepare('SELECT * FROM provider_resources ORDER BY owner, name, id')
        .all() as ProviderResourceRow[]
    ).map(providerResourceOfRow)
  },
  listForOwner: async (owner) => {
    await ctx.ensureInit()
    return (
      ctx.required
        .prepare('SELECT * FROM provider_resources WHERE owner = ? ORDER BY name, id')
        .all(owner) as ProviderResourceRow[]
    ).map(providerResourceOfRow)
  },
  delete: async (id) => {
    await ctx.ensureInit()
    ctx.required.prepare('DELETE FROM provider_resources WHERE id = ?').run(id)
  },
  materializeModel: async (id, model) => {
    await ctx.ensureInit()
    const db = ctx.required
    db.exec('BEGIN IMMEDIATE')
    try {
      const row = db.prepare('SELECT * FROM provider_resources WHERE id = ?').get(id) as
        ProviderResourceRow | undefined

      if (!row) {
        db.exec('COMMIT')
        return null
      }
      const record = providerResourceOfRow(row)
      const models = mergedProviderModels(record.models, model)
      db.prepare('UPDATE provider_resources SET models = ? WHERE id = ?').run(
        JSON.stringify(models),
        id,
      )
      db.exec('COMMIT')
      return { ...record, models }
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  },
  recordLastCheck: async (input) => {
    await ctx.ensureInit()
    const db = ctx.required
    db.exec('BEGIN IMMEDIATE')
    try {
      const credentialRow = input.expectedCredentialId
        ? (db.prepare('SELECT * FROM credentials WHERE id = ?').get(input.expectedCredentialId) as
            CredentialRow | undefined)
        : undefined
      const row = db
        .prepare('SELECT * FROM provider_resources WHERE id = ?')
        .get(input.resourceId) as ProviderResourceRow | undefined

      if (!row) {
        db.exec('COMMIT')
        return { status: 'missing' }
      }
      const record = providerResourceOfRow(row)
      const credential = credentialRow ? credentialOfRow(credentialRow) : null

      if (
        record.runtimeEpoch !== input.expectedRuntimeEpoch ||
        record.credentialId !== input.expectedCredentialId ||
        (credential?.runtimeEpoch ?? null) !== input.expectedCredentialRuntimeEpoch
      ) {
        db.exec('COMMIT')
        return { status: 'stale', record }
      }
      const lastCheck = { ...record.lastCheck, [input.purpose]: input.lastCheck }
      const models = input.model ? mergedProviderModels(record.models, input.model) : record.models
      db.prepare('UPDATE provider_resources SET last_check = ?, models = ? WHERE id = ?').run(
        JSON.stringify(lastCheck),
        JSON.stringify(models),
        input.resourceId,
      )
      db.exec('COMMIT')
      return { status: 'recorded', record: { ...record, lastCheck, models } }
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  },
})
