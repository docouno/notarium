import { CREDENTIAL_KEY_STATE } from '../../../credentialKeyring/consts'
import type { SecretKeyringPersistence, SecretKeyringRecord } from '../../types'
import type { PgDriverCtx } from './context'
import { lockSecretKeyring } from './lockOrder'

type SecretKeyringRow = {
  key_id: string
  canary: string
  state: SecretKeyringRecord['state']
  generation: string | number
  created_at: string
  retired_at: string | null
}

const recordOf = (row: SecretKeyringRow): SecretKeyringRecord => ({
  keyId: row.key_id,
  canary: row.canary,
  state: row.state,
  generation: Number(row.generation),
  createdAt: row.created_at,
  retiredAt: row.retired_at,
})

const sameWitness = (left: SecretKeyringRecord, right: SecretKeyringRecord): boolean =>
  left.keyId === right.keyId &&
  left.canary === right.canary &&
  left.generation === right.generation &&
  left.createdAt === right.createdAt &&
  left.retiredAt === right.retiredAt

export const createSecretKeyringFacet = (ctx: PgDriverCtx): SecretKeyringPersistence => ({
  init: () => ctx.ensureInit(),
  list: async () => {
    await ctx.ensureInit()
    const result = await ctx.required.query('SELECT * FROM secret_keyring ORDER BY generation')
    return (result.rows as SecretKeyringRow[]).map(recordOf)
  },
  active: async () => {
    await ctx.ensureInit()
    const result = await ctx.required.query(
      "SELECT * FROM secret_keyring WHERE state = 'active' AND retired_at IS NULL ORDER BY generation",
    )
    return (result.rows as SecretKeyringRow[]).map(recordOf)
  },
  admitReadable: async (record) => {
    await ctx.ensureInit()
    const client = await ctx.required.connect()

    try {
      await client.query('BEGIN')
      await lockSecretKeyring(client)
      const existing = await client.query(
        'SELECT * FROM secret_keyring WHERE key_id = $1 OR generation = $2 ORDER BY generation',
        [record.keyId, record.generation],
      )
      const rows = (existing.rows as SecretKeyringRow[]).map(recordOf)
      const byKey = rows.find((row) => row.keyId === record.keyId)

      if (byKey && sameWitness(byKey, record)) {
        await client.query('COMMIT')
        return { status: 'present', record: byKey }
      }
      if (rows.length > 0) {
        await client.query('COMMIT')
        return { status: 'conflict' }
      }
      const result = await client.query(
        `INSERT INTO secret_keyring
          (key_id, canary, state, generation, created_at, retired_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [
          record.keyId,
          record.canary,
          CREDENTIAL_KEY_STATE.readable,
          record.generation,
          record.createdAt,
          record.retiredAt,
        ],
      )
      await client.query('COMMIT')
      return {
        status: 'inserted',
        record: recordOf(result.rows[0] as SecretKeyringRow),
      }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  },
  projectActive: async ({ keyId, generation }) => {
    await ctx.ensureInit()
    const client = await ctx.required.connect()

    try {
      await client.query('BEGIN')
      await lockSecretKeyring(client)
      const result = await client.query('SELECT * FROM secret_keyring WHERE key_id = $1', [keyId])
      const targetRow = result.rows[0] as SecretKeyringRow | undefined

      if (!targetRow) {
        await client.query('COMMIT')
        return { status: 'missing' }
      }
      const target = recordOf(targetRow)

      if (target.retiredAt) {
        await client.query('COMMIT')
        return { status: 'retired', record: target }
      }
      if (target.generation !== generation) {
        await client.query('COMMIT')
        return { status: 'generation-conflict', record: target }
      }
      await client.query(
        "UPDATE secret_keyring SET state = 'readable' WHERE state = 'active' AND retired_at IS NULL",
      )
      const projected = await client.query(
        "UPDATE secret_keyring SET state = 'active' WHERE key_id = $1 AND retired_at IS NULL RETURNING *",
        [keyId],
      )
      await client.query('COMMIT')
      return {
        status: 'projected',
        record: recordOf(projected.rows[0] as SecretKeyringRow),
      }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  },
  projectRotationActive: async ({ expectedKeyId, keyId, generation }, publishPointer) => {
    await ctx.ensureInit()
    const client = await ctx.required.connect()

    try {
      await client.query('BEGIN')
      await lockSecretKeyring(client)
      const activeResult = await client.query(
        "SELECT key_id FROM secret_keyring WHERE state = 'active' AND retired_at IS NULL",
      )
      const active = activeResult.rows[0] as { key_id: string } | undefined

      if (active?.key_id !== expectedKeyId) {
        await client.query('COMMIT')
        return { status: 'active-changed', activeKeyId: active?.key_id ?? null }
      }
      const result = await client.query('SELECT * FROM secret_keyring WHERE key_id = $1', [keyId])
      const targetRow = result.rows[0] as SecretKeyringRow | undefined

      if (!targetRow) {
        await client.query('COMMIT')
        return { status: 'missing' }
      }
      const target = recordOf(targetRow)

      if (target.retiredAt) {
        await client.query('COMMIT')
        return { status: 'retired', record: target }
      }
      if (target.generation !== generation) {
        await client.query('COMMIT')
        return { status: 'generation-conflict', record: target }
      }
      await publishPointer()
      await client.query(
        "UPDATE secret_keyring SET state = 'readable' WHERE state = 'active' AND retired_at IS NULL",
      )
      const projected = await client.query(
        "UPDATE secret_keyring SET state = 'active' WHERE key_id = $1 AND retired_at IS NULL RETURNING *",
        [keyId],
      )
      await client.query('COMMIT')
      return {
        status: 'projected',
        record: recordOf(projected.rows[0] as SecretKeyringRow),
      }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  },
  replaceNonRetiredWith: async (record) => {
    await ctx.ensureInit()
    const client = await ctx.required.connect()

    try {
      await client.query('BEGIN')
      await lockSecretKeyring(client)
      await client.query('DELETE FROM secret_keyring WHERE retired_at IS NULL')
      await client.query(
        `INSERT INTO secret_keyring
          (key_id, canary, state, generation, created_at, retired_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          record.keyId,
          record.canary,
          CREDENTIAL_KEY_STATE.active,
          record.generation,
          record.createdAt,
          record.retiredAt,
        ],
      )
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  },
})
