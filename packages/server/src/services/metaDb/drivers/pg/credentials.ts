import type { PoolClient } from 'pg'

import {
  credentialOfRow,
  type CredentialRow,
  providerResourceOfRow,
  type ProviderResourceRow,
} from '../../rows'
import type { CiphertextWrite, CredentialRecord, CredentialsPersistence } from '../../types'
import { PROVIDER_PERSISTENCE_ERROR, providerPersistenceError } from '../../types'
import type { PgDriverCtx } from './context'
import {
  lockProviderCredentialRows,
  lockProviderResourceRows,
  lockSecretKeyring,
} from './lockOrder'
import { transitionProviderAttachments } from './providerAttachments'

const assertActiveKey = async (client: PoolClient, ciphertext: CiphertextWrite) => {
  await lockSecretKeyring(client)
  const result = await client.query(
    "SELECT key_id, generation FROM secret_keyring WHERE state = 'active' AND retired_at IS NULL",
  )
  const row = result.rows[0] as { key_id: string; generation: string | number } | undefined

  if (row?.key_id !== ciphertext.keyId || Number(row.generation) !== ciphertext.generation) {
    throw providerPersistenceError(
      PROVIDER_PERSISTENCE_ERROR.staleCiphertextKey,
      'ciphertext was not produced by the active credential key',
    )
  }
}

const valuesOf = (record: CredentialRecord): unknown[] => [
  record.id,
  record.owner,
  record.name,
  record.kind,
  record.secret,
  record.origin,
  JSON.stringify(record.injection),
  record.disabledAt,
  record.rpm,
  record.tpm,
  record.consentEpoch,
  record.runtimeEpoch,
]

const referencesFor = async (client: PoolClient, id: string) => {
  const result = await client.query(
    'SELECT * FROM provider_resources WHERE credential_id = $1 ORDER BY name, id',
    [id],
  )
  return (result.rows as ProviderResourceRow[]).map(providerResourceOfRow)
}

export const createCredentialsFacet = (ctx: PgDriverCtx): CredentialsPersistence => ({
  create: async (record, ciphertext) => {
    await ctx.ensureInit()
    const client = await ctx.required.connect()

    try {
      await client.query('BEGIN')
      await assertActiveKey(client, ciphertext)
      await lockProviderCredentialRows(client, [record.id])
      await client.query(
        `INSERT INTO credentials
          (id, owner, name, kind, secret, origin, injection, disabled_at, rpm, tpm,
           consent_epoch, runtime_epoch)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
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
  mutate: async (input) => {
    await ctx.ensureInit()
    const client = await ctx.required.connect()

    try {
      await client.query('BEGIN')
      const changesSecret = Object.hasOwn(input.changes, 'secret')

      if (changesSecret) {
        if (!input.ciphertext) {
          throw providerPersistenceError(
            PROVIDER_PERSISTENCE_ERROR.staleCiphertextKey,
            'credential secret mutation needs an active key witness',
          )
        }
        await assertActiveKey(client, input.ciphertext)
      }
      await lockProviderCredentialRows(client, [input.id])
      const currentResult = await client.query('SELECT * FROM credentials WHERE id = $1', [
        input.id,
      ])
      const row = currentResult.rows[0] as CredentialRow | undefined

      if (!row) {
        await client.query('COMMIT')
        return { status: 'missing' }
      }
      const current = credentialOfRow(row)

      if (current.runtimeEpoch !== input.expectedRuntimeEpoch) {
        await client.query('COMMIT')
        return { status: 'conflict', record: current }
      }
      const record: CredentialRecord = {
        ...current,
        ...input.changes,
        secret: changesSecret ? input.changes.secret! : current.secret,
        consentEpoch: current.consentEpoch + (input.consentChanged ? 1 : 0),
        runtimeEpoch: current.runtimeEpoch + (input.runtimeChanged ? 1 : 0),
      }
      const references = await referencesFor(client, input.id)
      const invalidIds = new Set(input.validateReferences(record, references))
      const invalid = references.filter((reference) => invalidIds.has(reference.id))

      if (invalid.length > 0) {
        await client.query('COMMIT')
        return { status: 'references-invalid', references: invalid }
      }
      await client.query(
        `UPDATE credentials SET
           owner = $2, name = $3, kind = $4, secret = $5, origin = $6, injection = $7,
           disabled_at = $8, rpm = $9, tpm = $10, consent_epoch = $11, runtime_epoch = $12
         WHERE id = $1`,
        valuesOf(record),
      )
      if (input.runtimeChanged || input.consentChanged) {
        const referenceIds = references.map((reference) => reference.id)
        await lockProviderResourceRows(client, referenceIds)

        if (input.runtimeChanged && referenceIds.length > 0) {
          await client.query("UPDATE provider_resources SET last_check = '{}' WHERE id = ANY($1)", [
            referenceIds,
          ])
        }
        if (input.consentChanged) {
          await transitionProviderAttachments(client, referenceIds)
        }
      }
      await client.query('COMMIT')
      return { status: 'updated', record }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  },
  get: async (id) => {
    await ctx.ensureInit()
    const result = await ctx.required.query('SELECT * FROM credentials WHERE id = $1', [id])
    const row = result.rows[0] as CredentialRow | undefined
    return row ? credentialOfRow(row) : null
  },
  getMany: async (ids) => {
    if (ids.length === 0) {
      return []
    }
    await ctx.ensureInit()
    const result = await ctx.required.query(
      'SELECT * FROM credentials WHERE id = ANY($1::text[]) ORDER BY id',
      [[...new Set(ids)]],
    )
    return (result.rows as CredentialRow[]).map(credentialOfRow)
  },
  pageIdsForOwner: async (owner, input) => {
    await ctx.ensureInit()
    const after = input.after
    const [total, page] = await Promise.all([
      ctx.required.query('SELECT COUNT(*) AS n FROM credentials WHERE owner = $1', [owner]),
      ctx.required.query(
        `SELECT id FROM credentials
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
  list: async () => {
    await ctx.ensureInit()
    const result = await ctx.required.query('SELECT * FROM credentials ORDER BY owner, name, id')
    return (result.rows as CredentialRow[]).map(credentialOfRow)
  },
  listForOwner: async (owner) => {
    await ctx.ensureInit()
    const result = await ctx.required.query(
      'SELECT * FROM credentials WHERE owner = $1 ORDER BY name, id',
      [owner],
    )
    return (result.rows as CredentialRow[]).map(credentialOfRow)
  },
  references: async (id) => {
    await ctx.ensureInit()
    const result = await ctx.required.query(
      'SELECT * FROM provider_resources WHERE credential_id = $1 ORDER BY name, id',
      [id],
    )
    return (result.rows as ProviderResourceRow[]).map(providerResourceOfRow)
  },
  deleteIfUnreferenced: async (id) => {
    await ctx.ensureInit()
    const client = await ctx.required.connect()

    try {
      await client.query('BEGIN')
      await lockProviderCredentialRows(client, [id])
      const exists = await client.query('SELECT 1 FROM credentials WHERE id = $1', [id])

      if (exists.rowCount === 0) {
        await client.query('COMMIT')
        return { status: 'missing' }
      }
      const references = await referencesFor(client, id)

      if (references.length > 0) {
        await client.query('COMMIT')
        return { status: 'referenced', references }
      }
      await client.query('DELETE FROM credentials WHERE id = $1', [id])
      await client.query('COMMIT')
      return { status: 'deleted' }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  },
})
