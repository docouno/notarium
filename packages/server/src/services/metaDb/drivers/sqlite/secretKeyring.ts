import { CREDENTIAL_KEY_STATE } from '../../../credentialKeyring/consts'
import type { SecretKeyringPersistence, SecretKeyringRecord } from '../../types'
import type { SqliteDriverCtx } from './context'

type SecretKeyringRow = {
  key_id: string
  canary: string
  state: SecretKeyringRecord['state']
  generation: number
  created_at: string
  retired_at: string | null
}

const recordOf = (row: SecretKeyringRow): SecretKeyringRecord => ({
  keyId: row.key_id,
  canary: row.canary,
  state: row.state,
  generation: row.generation,
  createdAt: row.created_at,
  retiredAt: row.retired_at,
})

const find = (ctx: SqliteDriverCtx, keyId: string): SecretKeyringRecord | null => {
  const row = ctx.required.prepare('SELECT * FROM secret_keyring WHERE key_id = ?').get(keyId) as
    SecretKeyringRow | undefined
  return row ? recordOf(row) : null
}

const insert = (ctx: SqliteDriverCtx, record: SecretKeyringRecord, state = record.state): void => {
  ctx.required
    .prepare(
      `INSERT INTO secret_keyring
        (key_id, canary, state, generation, created_at, retired_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(record.keyId, record.canary, state, record.generation, record.createdAt, record.retiredAt)
}

const sameWitness = (left: SecretKeyringRecord, right: SecretKeyringRecord): boolean =>
  left.keyId === right.keyId &&
  left.canary === right.canary &&
  left.generation === right.generation &&
  left.createdAt === right.createdAt &&
  left.retiredAt === right.retiredAt

export const createSecretKeyringFacet = (ctx: SqliteDriverCtx): SecretKeyringPersistence => ({
  init: () => ctx.ensureInit(),
  list: async () => {
    await ctx.ensureInit()
    return (
      ctx.required
        .prepare('SELECT * FROM secret_keyring ORDER BY generation')
        .all() as SecretKeyringRow[]
    ).map(recordOf)
  },
  active: async () => {
    await ctx.ensureInit()
    return (
      ctx.required
        .prepare(
          "SELECT * FROM secret_keyring WHERE state = 'active' AND retired_at IS NULL ORDER BY generation",
        )
        .all() as SecretKeyringRow[]
    ).map(recordOf)
  },
  admitReadable: async (record) => {
    await ctx.ensureInit()
    const db = ctx.required
    db.exec('BEGIN IMMEDIATE')
    try {
      const byKey = find(ctx, record.keyId)
      const generationRow = db
        .prepare('SELECT * FROM secret_keyring WHERE generation = ?')
        .get(record.generation) as SecretKeyringRow | undefined

      if (byKey && sameWitness(byKey, record)) {
        db.exec('COMMIT')
        return { status: 'present', record: byKey }
      }
      if (byKey || generationRow) {
        db.exec('COMMIT')
        return { status: 'conflict' }
      }
      insert(ctx, { ...record, state: CREDENTIAL_KEY_STATE.readable })
      const inserted = find(ctx, record.keyId)!
      db.exec('COMMIT')
      return { status: 'inserted', record: inserted }
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  },
  projectActive: async ({ keyId, generation }) => {
    await ctx.ensureInit()
    const db = ctx.required
    db.exec('BEGIN IMMEDIATE')
    try {
      const target = find(ctx, keyId)

      if (!target) {
        db.exec('COMMIT')
        return { status: 'missing' }
      }
      if (target.retiredAt) {
        db.exec('COMMIT')
        return { status: 'retired', record: target }
      }
      if (target.generation !== generation) {
        db.exec('COMMIT')
        return { status: 'generation-conflict', record: target }
      }
      db.prepare(
        "UPDATE secret_keyring SET state = 'readable' WHERE state = 'active' AND retired_at IS NULL",
      ).run()
      db.prepare(
        "UPDATE secret_keyring SET state = 'active' WHERE key_id = ? AND retired_at IS NULL",
      ).run(keyId)
      const projected = find(ctx, keyId)!
      db.exec('COMMIT')
      return { status: 'projected', record: projected }
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  },
  projectRotationActive: async ({ expectedKeyId, keyId, generation }, publishPointer) => {
    await ctx.ensureInit()
    const db = ctx.required
    db.exec('BEGIN IMMEDIATE')
    try {
      const active = db
        .prepare("SELECT key_id FROM secret_keyring WHERE state = 'active' AND retired_at IS NULL")
        .get() as { key_id: string } | undefined

      if (active?.key_id !== expectedKeyId) {
        db.exec('COMMIT')
        return { status: 'active-changed', activeKeyId: active?.key_id ?? null }
      }
      const target = find(ctx, keyId)

      if (!target) {
        db.exec('COMMIT')
        return { status: 'missing' }
      }
      if (target.retiredAt) {
        db.exec('COMMIT')
        return { status: 'retired', record: target }
      }
      if (target.generation !== generation) {
        db.exec('COMMIT')
        return { status: 'generation-conflict', record: target }
      }
      await publishPointer()
      db.prepare(
        "UPDATE secret_keyring SET state = 'readable' WHERE state = 'active' AND retired_at IS NULL",
      ).run()
      db.prepare(
        "UPDATE secret_keyring SET state = 'active' WHERE key_id = ? AND retired_at IS NULL",
      ).run(keyId)
      const projected = find(ctx, keyId)!
      db.exec('COMMIT')
      return { status: 'projected', record: projected }
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  },
  replaceNonRetiredWith: async (record) => {
    await ctx.ensureInit()
    const db = ctx.required
    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare('DELETE FROM secret_keyring WHERE retired_at IS NULL').run()
      insert(ctx, { ...record, state: CREDENTIAL_KEY_STATE.active }, CREDENTIAL_KEY_STATE.active)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  },
})
