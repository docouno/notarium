import {
  CAUSAL_BARRIER_KIND,
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
import { lockCausalBarriers } from './causalBarriers'
import type { PgDriverCtx } from './context'
import { lockBackupGenerationFreezeRow, lockInstallationGenerationRow } from './lockOrder'

export const createInstallationGenerationFacet = (
  ctx: PgDriverCtx,
): InstallationGenerationPersistence => ({
  init: () => ctx.ensureInit(),
  current: async () => {
    await ctx.ensureInit()
    const result = await ctx.required.query(
      'SELECT * FROM installation_generation WHERE singleton = 1',
    )
    const row = result.rows[0] as InstallationGenerationRow | undefined
    return row ? installationGenerationOfRow(row) : null
  },
  compareAndSet: async ({ expected, record }) => {
    await ctx.ensureInit()
    const client = await ctx.required.connect()

    try {
      await client.query('BEGIN')
      await lockCausalBarriers(client, [
        {
          kind: CAUSAL_BARRIER_KIND.installationGeneration,
          space: null,
          key: 'active',
        },
      ])
      const freezeRow = await lockBackupGenerationFreezeRow<BackupGenerationFreezeRow>(client)
      const freeze = freezeRow ? backupGenerationFreezeOfRow(freezeRow) : null

      if (freeze && freeze.expiresAt > record.changedAt) {
        await client.query('COMMIT')
        return { status: 'backup-frozen', freeze }
      }
      const row = await lockInstallationGenerationRow<InstallationGenerationRow>(client)
      const before = row ? installationGenerationOfRow(row) : null

      if (!sameInstallationGeneration(before, expected)) {
        await client.query('COMMIT')
        return { status: 'generation-conflict', record: before }
      }
      await client.query(
        `INSERT INTO installation_generation
          (singleton, generation, phase, active_key_id, active_hash,
           candidate_key_id, candidate_hash, changed_at)
         VALUES (1, $1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (singleton) DO UPDATE SET
           generation = EXCLUDED.generation,
           phase = EXCLUDED.phase,
           active_key_id = EXCLUDED.active_key_id,
           active_hash = EXCLUDED.active_hash,
           candidate_key_id = EXCLUDED.candidate_key_id,
           candidate_hash = EXCLUDED.candidate_hash,
           changed_at = EXCLUDED.changed_at`,
        [
          record.generation,
          record.phase,
          record.activeKeyId,
          record.activeHash,
          record.candidateKeyId,
          record.candidateHash,
          record.changedAt,
        ],
      )
      await client.query('COMMIT')
      return { status: 'installed', record: { ...record } }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  },
  acquireBackupFreeze: async ({ owner, now, expiresAt }) => {
    await ctx.ensureInit()
    const client = await ctx.required.connect()

    try {
      await client.query('BEGIN')
      await lockCausalBarriers(client, [
        { kind: CAUSAL_BARRIER_KIND.installationGeneration, space: null, key: 'active' },
      ])
      const generationRow = await lockInstallationGenerationRow<InstallationGenerationRow>(client)
      const record = generationRow ? installationGenerationOfRow(generationRow) : null

      if (!record) {
        await client.query('COMMIT')
        return { status: 'missing-generation' }
      }
      if (
        record.phase !== INSTALLATION_GENERATION_PHASE.activeInstalled ||
        !record.activeKeyId ||
        !record.activeHash
      ) {
        await client.query('COMMIT')
        return { status: 'unstable-generation', record }
      }
      const freezeRow = await lockBackupGenerationFreezeRow<BackupGenerationFreezeRow>(client)
      const existing = freezeRow ? backupGenerationFreezeOfRow(freezeRow) : null

      if (existing && existing.expiresAt > now && existing.owner !== owner) {
        await client.query('COMMIT')
        return { status: 'busy', freeze: existing }
      }
      const result = await client.query(
        `INSERT INTO backup_generation_freeze
          (singleton, owner, generation, key_id, active_hash, candidate_key_id,
           candidate_hash, acquired_at, heartbeat_at, expires_at)
         VALUES (1, $1, $2, $3, $4, $5, $6, $7, $7, $8)
         ON CONFLICT (singleton) DO UPDATE SET
           owner = EXCLUDED.owner,
           generation = EXCLUDED.generation,
           key_id = EXCLUDED.key_id,
           active_hash = EXCLUDED.active_hash,
           candidate_key_id = EXCLUDED.candidate_key_id,
           candidate_hash = EXCLUDED.candidate_hash,
           acquired_at = EXCLUDED.acquired_at,
           heartbeat_at = EXCLUDED.heartbeat_at,
           expires_at = EXCLUDED.expires_at
         RETURNING *`,
        [
          owner,
          record.generation,
          record.activeKeyId,
          record.activeHash,
          record.candidateKeyId,
          record.candidateHash,
          now,
          expiresAt,
        ],
      )
      await client.query('COMMIT')
      return {
        status: 'acquired',
        freeze: backupGenerationFreezeOfRow(result.rows[0] as BackupGenerationFreezeRow),
      }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  },
  renewBackupFreeze: async ({ owner, expected, now, expiresAt }) => {
    await ctx.ensureInit()
    const client = await ctx.required.connect()

    try {
      await client.query('BEGIN')
      await lockCausalBarriers(client, [
        { kind: CAUSAL_BARRIER_KIND.installationGeneration, space: null, key: 'active' },
      ])
      const freezeRow = await lockBackupGenerationFreezeRow<BackupGenerationFreezeRow>(client)
      const freeze = freezeRow ? backupGenerationFreezeOfRow(freezeRow) : null

      if (!freeze || freeze.owner !== owner || freeze.expiresAt <= now) {
        await client.query('COMMIT')
        return { status: 'lost' }
      }
      const generationRow = await lockInstallationGenerationRow<InstallationGenerationRow>(client)
      const record = generationRow ? installationGenerationOfRow(generationRow) : null

      if (
        !record ||
        record.generation !== expected.generation ||
        record.activeKeyId !== expected.keyId ||
        record.activeHash !== expected.activeHash ||
        record.candidateKeyId !== expected.candidateKeyId ||
        record.candidateHash !== expected.candidateHash
      ) {
        await client.query('COMMIT')
        return { status: 'generation-changed', record }
      }
      const renewed = await client.query(
        `UPDATE backup_generation_freeze
            SET heartbeat_at = $1, expires_at = $2
          WHERE singleton = 1 AND owner = $3
          RETURNING *`,
        [now, expiresAt, owner],
      )
      await client.query('COMMIT')
      return {
        status: 'renewed',
        freeze: backupGenerationFreezeOfRow(renewed.rows[0] as BackupGenerationFreezeRow),
      }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  },
  releaseBackupFreeze: async (owner) => {
    await ctx.ensureInit()
    await ctx.required.query(
      'DELETE FROM backup_generation_freeze WHERE singleton = 1 AND owner = $1',
      [owner],
    )
  },
  recoverExpiredBackupFreeze: async (now) => {
    await ctx.ensureInit()
    const result = await ctx.required.query(
      'DELETE FROM backup_generation_freeze WHERE singleton = 1 AND expires_at <= $1',
      [now],
    )
    return (result.rowCount ?? 0) > 0
  },
})
