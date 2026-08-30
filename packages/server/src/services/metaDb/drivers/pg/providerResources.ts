import type { PoolClient } from 'pg'
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
import type { PgDriverCtx } from './context'
import {
  lockProviderCredentialRows,
  lockProviderResourceRows,
  lockSecretKeyring,
} from './lockOrder'
import { transitionProviderAttachments } from './providerAttachments'

const assertActiveKey = async (
  client: PoolClient,
  ciphertext: CiphertextWrite | null,
  hasHeaders: boolean,
) => {
  if (!hasHeaders) {
    return
  }
  if (!ciphertext) {
    throw providerPersistenceError(
      PROVIDER_PERSISTENCE_ERROR.staleCiphertextKey,
      'encrypted provider headers need an active credential key witness',
    )
  }
  await lockSecretKeyring(client)
  const result = await client.query(
    "SELECT key_id, generation FROM secret_keyring WHERE state = 'active' AND retired_at IS NULL",
  )
  const row = result.rows[0] as { key_id: string; generation: string | number } | undefined

  if (row?.key_id !== ciphertext.keyId || Number(row.generation) !== ciphertext.generation) {
    throw providerPersistenceError(
      PROVIDER_PERSISTENCE_ERROR.staleCiphertextKey,
      'provider headers were not encrypted by the active credential key',
    )
  }
}

const credentialFor = async (
  client: PoolClient,
  record: ProviderResourceRecord,
): Promise<CredentialRecord | null> => {
  if (!record.credentialId) {
    return null
  }
  const result = await client.query('SELECT * FROM credentials WHERE id = $1', [
    record.credentialId,
  ])
  const row = result.rows[0] as CredentialRow | undefined

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

const valuesOf = (record: ProviderResourceRecord): unknown[] => [
  record.id,
  record.owner,
  record.name,
  record.wire,
  record.baseUrl,
  JSON.stringify(record.headers),
  record.allowPrivateNetwork,
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
  WHERE (resource.owner = $1 OR EXISTS (
    SELECT 1 FROM provider_attachments AS attachment
     WHERE attachment.resource_id = resource.id
       AND attachment.target_space = ANY($2::text[])
       AND attachment.state IN ('active', 'awaiting-reconsent')
  ))`

export const createProviderResourcesFacet = (ctx: PgDriverCtx): ProviderResourcesPersistence => ({
  create: async (record, ciphertext) => {
    await ctx.ensureInit()
    const client = await ctx.required.connect()

    try {
      await client.query('BEGIN')
      await assertActiveKey(client, ciphertext, Object.keys(record.headers).length > 0)
      await lockProviderCredentialRows(client, record.credentialId ? [record.credentialId] : [])
      await lockProviderResourceRows(client, [record.id])
      await credentialFor(client, record)
      await client.query(
        `INSERT INTO provider_resources
          (id, owner, name, wire, base_url, headers, allow_private_network, purposes,
           models, default_model, credential_id, consent_epoch, runtime_epoch, disabled_at,
           last_check, first_byte_timeout_ms, call_timeout_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
                 $15, $16, $17)`,
        valuesOf(record),
      )
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
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
    const client = await ctx.required.connect()

    try {
      await client.query('BEGIN')
      await assertActiveKey(client, ciphertext, Object.keys(record.headers).length > 0)
      await lockProviderCredentialRows(
        client,
        [expectedCredentialId, record.credentialId].filter((id): id is string => id !== null),
      )
      await lockProviderResourceRows(client, [record.id])
      const currentResult = await client.query('SELECT * FROM provider_resources WHERE id = $1', [
        record.id,
      ])
      const currentRow = currentResult.rows[0] as ProviderResourceRow | undefined

      if (!currentRow) {
        await client.query('COMMIT')
        return { status: 'missing' }
      }
      const current = providerResourceOfRow(currentRow)

      if (
        current.runtimeEpoch !== expectedRuntimeEpoch ||
        current.credentialId !== expectedCredentialId
      ) {
        await client.query('COMMIT')
        return { status: 'conflict', record: current }
      }
      await credentialFor(client, record)
      const stored = {
        ...record,
        models: preserveModels ? current.models : record.models,
        lastCheck:
          record.runtimeEpoch === expectedRuntimeEpoch ? current.lastCheck : record.lastCheck,
      }
      const result = await client.query(
        `UPDATE provider_resources SET
           owner = $2, name = $3, wire = $4, base_url = $5, headers = $6,
           allow_private_network = $7, purposes = $8, models = $9, default_model = $10,
           credential_id = $11, consent_epoch = $12, runtime_epoch = $13,
           disabled_at = $14, last_check = $15, first_byte_timeout_ms = $16,
           call_timeout_ms = $17
         WHERE id = $1 AND runtime_epoch = $18
         RETURNING *`,
        [...valuesOf(stored), expectedRuntimeEpoch],
      )

      if (stored.consentEpoch !== current.consentEpoch) {
        await transitionProviderAttachments(client, [record.id])
      }
      await client.query('COMMIT')
      return {
        status: 'replaced',
        record: providerResourceOfRow(result.rows[0] as ProviderResourceRow),
      }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  },
  get: async (id) => {
    await ctx.ensureInit()
    const result = await ctx.required.query('SELECT * FROM provider_resources WHERE id = $1', [id])
    const row = result.rows[0] as ProviderResourceRow | undefined
    return row ? providerResourceOfRow(row) : null
  },
  getMany: async (ids) => {
    if (ids.length === 0) {
      return []
    }
    await ctx.ensureInit()
    const result = await ctx.required.query(
      'SELECT * FROM provider_resources WHERE id = ANY($1::text[]) ORDER BY id',
      [[...new Set(ids)]],
    )
    return (result.rows as ProviderResourceRow[]).map(providerResourceOfRow)
  },
  pageIdsForOwner: async (owner, input) => {
    await ctx.ensureInit()
    const after = input.after
    const [total, page] = await Promise.all([
      ctx.required.query('SELECT COUNT(*) AS n FROM provider_resources WHERE owner = $1', [owner]),
      ctx.required.query(
        `SELECT id FROM provider_resources
          WHERE owner = $1
            AND ($2::text IS NULL OR
              (name COLLATE "C", id COLLATE "C") >
              (($2::text) COLLATE "C", ($3::text) COLLATE "C"))
          ORDER BY name COLLATE "C", id COLLATE "C" LIMIT $4`,
        [owner, after?.sort ?? null, after?.id ?? '', Math.max(1, Math.min(input.limit, 1_000))],
      ),
    ])

    return {
      ids: (page.rows as Array<{ id: string }>).map(({ id }) => id),
      total: Number((total.rows[0] as { n: string | number }).n),
    }
  },
  pageEffectiveIds: async (owner, spaces, input) => {
    await ctx.ensureInit()
    const after = input.after
    const targetSpaces = [...new Set(spaces)]
    const [total, page] = await Promise.all([
      ctx.required.query(`SELECT COUNT(*) AS n ${EFFECTIVE_CANDIDATE}`, [owner, targetSpaces]),
      ctx.required.query(
        `SELECT resource.id ${EFFECTIVE_CANDIDATE}
          AND ($3::text IS NULL OR
            (resource.name COLLATE "C", resource.id COLLATE "C") >
            (($3::text) COLLATE "C", ($4::text) COLLATE "C"))
          ORDER BY resource.name COLLATE "C", resource.id COLLATE "C" LIMIT $5`,
        [
          owner,
          targetSpaces,
          after?.sort ?? null,
          after?.id ?? '',
          Math.max(1, Math.min(input.limit, 1_000)),
        ],
      ),
    ])

    return {
      ids: (page.rows as Array<{ id: string }>).map(({ id }) => id),
      total: Number((total.rows[0] as { n: string | number }).n),
    }
  },
  scanEffectivePage: async (owner, spaces, input) => {
    await ctx.ensureInit()
    const after = input.after
    const targetSpaces = [...new Set(spaces)]
    const limit = Math.max(1, Math.min(input.limit, 1_000))
    const result = await ctx.required.query(
      `SELECT resource.name AS sort, resource.id ${EFFECTIVE_CANDIDATE}
        AND ($3::text IS NULL OR
          (resource.name COLLATE "C", resource.id COLLATE "C") >
          (($3::text) COLLATE "C", ($4::text) COLLATE "C"))
        ORDER BY resource.name COLLATE "C", resource.id COLLATE "C" LIMIT $5`,
      [owner, targetSpaces, after?.sort ?? null, after?.id ?? '', limit + 1],
    )
    const rows = result.rows as Array<{ sort: string; id: string }>

    return { positions: rows.slice(0, limit), hasMore: rows.length > limit }
  },
  list: async () => {
    await ctx.ensureInit()
    const result = await ctx.required.query(
      'SELECT * FROM provider_resources ORDER BY owner, name, id',
    )
    return (result.rows as ProviderResourceRow[]).map(providerResourceOfRow)
  },
  listForOwner: async (owner) => {
    await ctx.ensureInit()
    const result = await ctx.required.query(
      'SELECT * FROM provider_resources WHERE owner = $1 ORDER BY name, id',
      [owner],
    )
    return (result.rows as ProviderResourceRow[]).map(providerResourceOfRow)
  },
  delete: async (id) => {
    await ctx.ensureInit()
    const client = await ctx.required.connect()

    try {
      await client.query('BEGIN')
      await lockProviderResourceRows(client, [id])
      await client.query('DELETE FROM provider_resources WHERE id = $1', [id])
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  },
  materializeModel: async (id, model) => {
    await ctx.ensureInit()
    const client = await ctx.required.connect()

    try {
      await client.query('BEGIN')
      await lockProviderResourceRows(client, [id])
      const result = await client.query('SELECT * FROM provider_resources WHERE id = $1', [id])
      const row = result.rows[0] as ProviderResourceRow | undefined

      if (!row) {
        await client.query('COMMIT')
        return null
      }
      const record = providerResourceOfRow(row)
      const models = mergedProviderModels(record.models, model)
      await client.query('UPDATE provider_resources SET models = $2 WHERE id = $1', [
        id,
        JSON.stringify(models),
      ])
      await client.query('COMMIT')
      return { ...record, models }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  },
  recordLastCheck: async (input) => {
    await ctx.ensureInit()
    const client = await ctx.required.connect()

    try {
      await client.query('BEGIN')
      await lockProviderCredentialRows(
        client,
        input.expectedCredentialId ? [input.expectedCredentialId] : [],
      )
      await lockProviderResourceRows(client, [input.resourceId])
      const credentialResult = input.expectedCredentialId
        ? await client.query('SELECT * FROM credentials WHERE id = $1', [
            input.expectedCredentialId,
          ])
        : null
      const result = await client.query('SELECT * FROM provider_resources WHERE id = $1', [
        input.resourceId,
      ])
      const row = result.rows[0] as ProviderResourceRow | undefined

      if (!row) {
        await client.query('COMMIT')
        return { status: 'missing' }
      }
      const record = providerResourceOfRow(row)
      const credentialRow = credentialResult?.rows[0] as CredentialRow | undefined
      const credential = credentialRow ? credentialOfRow(credentialRow) : null

      if (
        record.runtimeEpoch !== input.expectedRuntimeEpoch ||
        record.credentialId !== input.expectedCredentialId ||
        (credential?.runtimeEpoch ?? null) !== input.expectedCredentialRuntimeEpoch
      ) {
        await client.query('COMMIT')
        return { status: 'stale', record }
      }
      const lastCheck = { ...record.lastCheck, [input.purpose]: input.lastCheck }
      const models = input.model ? mergedProviderModels(record.models, input.model) : record.models
      await client.query(
        'UPDATE provider_resources SET last_check = $2, models = $3 WHERE id = $1',
        [input.resourceId, JSON.stringify(lastCheck), JSON.stringify(models)],
      )
      await client.query('COMMIT')
      return { status: 'recorded', record: { ...record, lastCheck, models } }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  },
})
