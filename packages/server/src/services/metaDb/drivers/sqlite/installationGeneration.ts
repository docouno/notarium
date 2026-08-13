import {
  INSTALLATION_GENERATION_PHASE,
  type InstallationGenerationPersistence,
} from '@notarium/core'

import {
  backupGenerationFreezeOfRow,
  type BackupGenerationFreezeRow,
  installationGenerationOfRow,
  type InstallationGenerationRow,
  sameInstallationGeneration,
} from '../../causalRows'
import type { SqliteDriverCtx } from './context'

const current = (ctx: SqliteDriverCtx) => {
  const row = ctx.required
    .prepare('SELECT * FROM installation_generation WHERE singleton = 1')
    .get() as InstallationGenerationRow | undefined
  return row ? installationGenerationOfRow(row) : null
}

const currentFreeze = (ctx: SqliteDriverCtx) => {
  const row = ctx.required
    .prepare('SELECT * FROM backup_generation_freeze WHERE singleton = 1')
    .get() as BackupGenerationFreezeRow | undefined
  return row ? backupGenerationFreezeOfRow(row) : null
}

export const createInstallationGenerationFacet = (
  ctx: SqliteDriverCtx,
): InstallationGenerationPersistence => ({
  init: () => ctx.ensureInit(),
  current: async () => {
    await ctx.ensureInit()
    return current(ctx)
  },
  compareAndSet: async ({ expected, record }) => {
    await ctx.ensureInit()
    const db = ctx.required
    db.exec('BEGIN IMMEDIATE')
    try {
      const freeze = currentFreeze(ctx)

      if (freeze && freeze.expiresAt > record.changedAt) {
        db.exec('COMMIT')
        return { status: 'backup-frozen', freeze }
      }
      const before = current(ctx)

      if (!sameInstallationGeneration(before, expected)) {
        db.exec('COMMIT')
        return { status: 'generation-conflict', record: before }
      }
      db.prepare(
        `INSERT INTO installation_generation
          (singleton, generation, phase, active_key_id, active_hash,
           candidate_key_id, candidate_hash, changed_at)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(singleton) DO UPDATE SET
           generation = excluded.generation,
           phase = excluded.phase,
           active_key_id = excluded.active_key_id,
           active_hash = excluded.active_hash,
           candidate_key_id = excluded.candidate_key_id,
           candidate_hash = excluded.candidate_hash,
           changed_at = excluded.changed_at`,
      ).run(
        record.generation,
        record.phase,
        record.activeKeyId,
        record.activeHash,
        record.candidateKeyId,
        record.candidateHash,
        record.changedAt,
      )
      db.exec('COMMIT')
      return { status: 'installed', record: { ...record } }
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  },
  acquireBackupFreeze: async ({ owner, now, expiresAt }) => {
    await ctx.ensureInit()
    const db = ctx.required
    db.exec('BEGIN IMMEDIATE')
    try {
      const record = current(ctx)

      if (!record) {
        db.exec('COMMIT')
        return { status: 'missing-generation' }
      }
      if (
        record.phase !== INSTALLATION_GENERATION_PHASE.activeInstalled ||
        !record.activeKeyId ||
        !record.activeHash
      ) {
        db.exec('COMMIT')
        return { status: 'unstable-generation', record }
      }
      const existing = currentFreeze(ctx)

      if (existing && existing.expiresAt > now && existing.owner !== owner) {
        db.exec('COMMIT')
        return { status: 'busy', freeze: existing }
      }
      db.prepare(
        `INSERT INTO backup_generation_freeze
          (singleton, owner, generation, key_id, active_hash, candidate_key_id,
           candidate_hash, acquired_at, heartbeat_at, expires_at)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(singleton) DO UPDATE SET
           owner = excluded.owner,
           generation = excluded.generation,
           key_id = excluded.key_id,
           active_hash = excluded.active_hash,
           candidate_key_id = excluded.candidate_key_id,
           candidate_hash = excluded.candidate_hash,
           acquired_at = excluded.acquired_at,
           heartbeat_at = excluded.heartbeat_at,
           expires_at = excluded.expires_at`,
      ).run(
        owner,
        record.generation,
        record.activeKeyId,
        record.activeHash,
        record.candidateKeyId,
        record.candidateHash,
        now,
        now,
        expiresAt,
      )
      const freeze = currentFreeze(ctx)!
      db.exec('COMMIT')
      return { status: 'acquired', freeze }
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  },
  renewBackupFreeze: async ({ owner, expected, now, expiresAt }) => {
    await ctx.ensureInit()
    const db = ctx.required
    db.exec('BEGIN IMMEDIATE')
    try {
      const freeze = currentFreeze(ctx)

      if (!freeze || freeze.owner !== owner || freeze.expiresAt <= now) {
        db.exec('COMMIT')
        return { status: 'lost' }
      }
      const record = current(ctx)

      if (
        !record ||
        record.generation !== expected.generation ||
        record.activeKeyId !== expected.keyId ||
        record.activeHash !== expected.activeHash ||
        record.candidateKeyId !== expected.candidateKeyId ||
        record.candidateHash !== expected.candidateHash
      ) {
        db.exec('COMMIT')
        return { status: 'generation-changed', record }
      }
      db.prepare(
        `UPDATE backup_generation_freeze
            SET heartbeat_at = ?, expires_at = ?
          WHERE singleton = 1 AND owner = ?`,
      ).run(now, expiresAt, owner)
      const renewed = currentFreeze(ctx)!
      db.exec('COMMIT')
      return { status: 'renewed', freeze: renewed }
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  },
  releaseBackupFreeze: async (owner) => {
    await ctx.ensureInit()
    ctx.required
      .prepare('DELETE FROM backup_generation_freeze WHERE singleton = 1 AND owner = ?')
      .run(owner)
  },
  recoverExpiredBackupFreeze: async (now) => {
    await ctx.ensureInit()
    const result = ctx.required
      .prepare('DELETE FROM backup_generation_freeze WHERE singleton = 1 AND expires_at <= ?')
      .run(now)
    return result.changes > 0
  },
})
