import {
  credentialOfRow,
  type CredentialRow,
  providerResourceOfRow,
  type ProviderResourceRow,
} from '../../rows'
import type { CiphertextWrite, CredentialRecord, CredentialsPersistence } from '../../types'
import { PROVIDER_PERSISTENCE_ERROR, providerPersistenceError } from '../../types'
import type { SqliteDriverCtx } from './context'
import { transitionProviderAttachments } from './providerAttachments'

const assertActiveKey = (ctx: SqliteDriverCtx, ciphertext: CiphertextWrite): void => {
  const active = ctx.required
    .prepare(
      "SELECT key_id, generation FROM secret_keyring WHERE state = 'active' AND retired_at IS NULL",
    )
    .get() as { key_id: string; generation: number } | undefined

  if (active?.key_id !== ciphertext.keyId || active.generation !== ciphertext.generation) {
    throw providerPersistenceError(
      PROVIDER_PERSISTENCE_ERROR.staleCiphertextKey,
      'ciphertext was not produced by the active credential key',
    )
  }
}

const valuesOf = (record: CredentialRecord): Array<string | number | null> => [
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

const referencesFor = (ctx: SqliteDriverCtx, id: string) =>
  (
    ctx.required
      .prepare('SELECT * FROM provider_resources WHERE credential_id = ? ORDER BY name, id')
      .all(id) as ProviderResourceRow[]
  ).map(providerResourceOfRow)

export const createCredentialsFacet = (ctx: SqliteDriverCtx): CredentialsPersistence => ({
  create: async (record, ciphertext) => {
    await ctx.ensureInit()
    const db = ctx.required
    db.exec('BEGIN IMMEDIATE')
    try {
      assertActiveKey(ctx, ciphertext)
      db.prepare(
        `INSERT INTO credentials
          (id, owner, name, kind, secret, origin, injection, disabled_at, rpm, tpm,
           consent_epoch, runtime_epoch)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(...valuesOf(record))
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  },
  mutate: async (input) => {
    await ctx.ensureInit()
    const db = ctx.required
    db.exec('BEGIN IMMEDIATE')
    try {
      const changesSecret = Object.hasOwn(input.changes, 'secret')

      if (changesSecret) {
        if (!input.ciphertext) {
          throw providerPersistenceError(
            PROVIDER_PERSISTENCE_ERROR.staleCiphertextKey,
            'credential secret mutation needs an active key witness',
          )
        }
        assertActiveKey(ctx, input.ciphertext)
      }
      const row = db.prepare('SELECT * FROM credentials WHERE id = ?').get(input.id) as
        CredentialRow | undefined

      if (!row) {
        db.exec('COMMIT')
        return { status: 'missing' }
      }
      const current = credentialOfRow(row)

      if (current.runtimeEpoch !== input.expectedRuntimeEpoch) {
        db.exec('COMMIT')
        return { status: 'conflict', record: current }
      }
      const record: CredentialRecord = {
        ...current,
        ...input.changes,
        secret: changesSecret ? input.changes.secret! : current.secret,
        consentEpoch: current.consentEpoch + (input.consentChanged ? 1 : 0),
        runtimeEpoch: current.runtimeEpoch + (input.runtimeChanged ? 1 : 0),
      }
      const references = referencesFor(ctx, input.id)
      const invalidIds = new Set(input.validateReferences(record, references))
      const invalid = references.filter((reference) => invalidIds.has(reference.id))

      if (invalid.length > 0) {
        db.exec('COMMIT')
        return { status: 'references-invalid', references: invalid }
      }
      db.prepare(
        `UPDATE credentials SET
           owner = ?, name = ?, kind = ?, secret = ?, origin = ?, injection = ?,
           disabled_at = ?, rpm = ?, tpm = ?, consent_epoch = ?, runtime_epoch = ?
         WHERE id = ?`,
      ).run(
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
        record.id,
      )
      if (input.runtimeChanged) {
        db.prepare("UPDATE provider_resources SET last_check = '{}' WHERE credential_id = ?").run(
          input.id,
        )
      }
      if (input.consentChanged) {
        transitionProviderAttachments(
          ctx,
          references.map(({ id }) => id),
        )
      }
      db.exec('COMMIT')
      return { status: 'updated', record }
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  },
  get: async (id) => {
    await ctx.ensureInit()
    const row = ctx.required.prepare('SELECT * FROM credentials WHERE id = ?').get(id) as
      CredentialRow | undefined
    return row ? credentialOfRow(row) : null
  },
  getMany: async (ids) => {
    if (ids.length === 0) {
      return []
    }
    await ctx.ensureInit()
    return (
      ctx.required
        .prepare(
          'SELECT * FROM credentials WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id',
        )
        .all(JSON.stringify([...new Set(ids)])) as CredentialRow[]
    ).map(credentialOfRow)
  },
  pageIdsForOwner: async (owner, input) => {
    await ctx.ensureInit()
    const after = input.after
    const total = ctx.required
      .prepare('SELECT COUNT(*) AS n FROM credentials WHERE owner = ?')
      .get(owner) as { n: number }
    const rows = ctx.required
      .prepare(
        `SELECT id FROM credentials
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
  list: async () => {
    await ctx.ensureInit()
    return (
      ctx.required
        .prepare('SELECT * FROM credentials ORDER BY owner, name, id')
        .all() as CredentialRow[]
    ).map(credentialOfRow)
  },
  listForOwner: async (owner) => {
    await ctx.ensureInit()
    return (
      ctx.required
        .prepare('SELECT * FROM credentials WHERE owner = ? ORDER BY name, id')
        .all(owner) as CredentialRow[]
    ).map(credentialOfRow)
  },
  references: async (id) => {
    await ctx.ensureInit()
    return referencesFor(ctx, id)
  },
  deleteIfUnreferenced: async (id) => {
    await ctx.ensureInit()
    const db = ctx.required
    db.exec('BEGIN IMMEDIATE')
    try {
      const exists = db.prepare('SELECT 1 FROM credentials WHERE id = ?').get(id)

      if (!exists) {
        db.exec('COMMIT')
        return { status: 'missing' }
      }
      const references = referencesFor(ctx, id)

      if (references.length > 0) {
        db.exec('COMMIT')
        return { status: 'referenced', references }
      }
      db.prepare('DELETE FROM credentials WHERE id = ?').run(id)
      db.exec('COMMIT')
      return { status: 'deleted' }
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  },
})
