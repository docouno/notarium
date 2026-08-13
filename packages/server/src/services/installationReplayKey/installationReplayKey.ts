import { createHmac } from 'node:crypto'

import {
  INSTALLATION_GENERATION_PHASE,
  type InstallationGenerationPersistence,
  type InstallationGenerationRecord,
} from '@notarium/core'

import { type ActiveReplayKey, type ReplayKeyMaterial, type ReplayKeyring } from './replayKeyring'

export const REPLAY_KEY_TOPOLOGY = {
  canonicalLocal: 'canonical-local',
  externalShared: 'external-shared',
} as const

export type ReplayKeyTopology = (typeof REPLAY_KEY_TOPOLOGY)[keyof typeof REPLAY_KEY_TOPOLOGY]

export type InstallationReplayKeyOptions = {
  persistence: InstallationGenerationPersistence
  keyring: ReplayKeyring
  topology: ReplayKeyTopology
  now?: () => Date
}

const MAX_RECOVERY_STEPS = 16

const witnessError = (message: string): Error =>
  new Error(`installation replay-key witness mismatch: ${message}`)

const sameActive = (
  key: ActiveReplayKey,
  record: Pick<InstallationGenerationRecord, 'generation' | 'activeKeyId' | 'activeHash'>,
): boolean =>
  key.generation === record.generation &&
  key.keyId === record.activeKeyId &&
  key.hash === record.activeHash

export class InstallationReplayKey {
  private readonly persistence: InstallationGenerationPersistence
  private readonly keyring: ReplayKeyring
  private readonly topology: ReplayKeyTopology
  private readonly now: () => Date
  private cached: ActiveReplayKey | null = null

  constructor(options: InstallationReplayKeyOptions) {
    this.persistence = options.persistence
    this.keyring = options.keyring
    this.topology = options.topology
    this.now = options.now ?? (() => new Date())
  }

  async bootstrap(): Promise<ActiveReplayKey> {
    await this.persistence.init()
    await this.keyring.init()
    await this.keyring.assertWritable()
    await this.persistence.recoverExpiredBackupFreeze(this.now().toISOString())

    for (let step = 0; step < MAX_RECOVERY_STEPS; step += 1) {
      const record = await this.persistence.current()

      if (!record) {
        await this.keyring.assertNoUnwitnessedState()
        const started = await this.startReplacement(null, null)

        if (!started) {
          continue
        }
        continue
      }
      if (record.phase === INSTALLATION_GENERATION_PHASE.activeInstalled) {
        const active = await this.tryReadStable(record)

        if (active) {
          this.cached = active
          return active
        }
        if (
          this.topology === REPLAY_KEY_TOPOLOGY.canonicalLocal &&
          (await this.keyring.isCompletelyLost())
        ) {
          const started = await this.startReplacement(record, null)

          if (!started) {
            continue
          }
          continue
        }
        throw witnessError(
          this.topology === REPLAY_KEY_TOPOLOGY.externalShared
            ? `stable generation ${record.generation} is missing from the shared keyring; stop every server and run admin recover-replay-key`
            : `stable generation ${record.generation} has corrupt or mismatched keyring state`,
        )
      }
      const recovered = await this.recoverReplacement(record)

      if (!recovered) {
        continue
      }
    }

    throw new Error('installation replay-key recovery did not converge')
  }

  async rotate(): Promise<ActiveReplayKey> {
    const active = await this.bootstrap()
    const expected = await this.persistence.current()

    if (
      !expected ||
      expected.phase !== INSTALLATION_GENERATION_PHASE.activeInstalled ||
      !sameActive(active, expected)
    ) {
      throw witnessError('stable generation changed while rotation was admitted')
    }
    await this.startReplacement(expected, active)
    return this.bootstrap()
  }

  async recoverMissingExternal(input: { expectedKeyId: string; apply: boolean }): Promise<{
    generation: number
    previousKeyId: string
    applied: boolean
    activeKeyId?: string
  }> {
    if (this.topology !== REPLAY_KEY_TOPOLOGY.externalShared) {
      throw new Error('offline replay-key recovery is only valid for external-meta topology')
    }
    await this.persistence.init()
    const record = await this.persistence.current()

    if (
      !record ||
      record.phase !== INSTALLATION_GENERATION_PHASE.activeInstalled ||
      !record.activeKeyId
    ) {
      throw witnessError('offline recovery requires one stable installation generation')
    }
    if (record.activeKeyId !== input.expectedKeyId) {
      throw witnessError(
        `expected key id ${input.expectedKeyId}, database names ${record.activeKeyId}`,
      )
    }
    if (!(await this.keyring.isCompletelyLost())) {
      throw witnessError(
        'offline recovery requires a completely missing keyring, not present state',
      )
    }
    if (!input.apply) {
      return { generation: record.generation, previousKeyId: record.activeKeyId, applied: false }
    }
    const started = await this.startReplacement(record, null)

    if (!started) {
      throw witnessError('installation generation changed during offline recovery')
    }
    const active = await this.bootstrap()
    return {
      generation: active.generation,
      previousKeyId: record.activeKeyId,
      activeKeyId: active.keyId,
      applied: true,
    }
  }

  async digest(domain: string, value: string): Promise<string> {
    return (await this.digestBundle([{ domain, value }]))[0]
  }

  /** Sign related operation-identity fields from one witnessed generation. */
  async digestBundle(inputs: readonly { domain: string; value: string }[]): Promise<string[]> {
    const active = await this.stableForSigning()
    return inputs.map((input) => this.digestWith(active, input.domain, input.value))
  }

  /** Replay lookup spans retained generations; only {@link digest} signs new
   *  operation identity with the active generation. */
  async digestCandidates(domain: string, value: string): Promise<string[]> {
    return (await this.digestCandidateBundles([{ domain, value }])).map((bundle) => bundle[0])
  }

  /** Replay lookup bundles keep actor, idempotency key and payload fingerprint
   * on the same retained generation even if rotation is happening nearby. */
  async digestCandidateBundles(
    inputs: readonly { domain: string; value: string }[],
  ): Promise<string[][]> {
    const active = await this.stableForSigning()
    const retained = await this.keyring.listKeys()
    const ordered = [active, ...retained.filter((key) => key.keyId !== active.keyId)]
    return ordered.map((key) =>
      inputs.map((input) => this.digestWith(key, input.domain, input.value)),
    )
  }

  private digestWith(key: ReplayKeyMaterial, domain: string, value: string): string {
    if (!domain || domain.includes('\0')) {
      throw new Error('replay digest domain must be non-empty and cannot contain NUL')
    }
    const digest = createHmac('sha256', key.secret)
      .update('notarium-replay-v1\0')
      .update(domain)
      .update('\0')
      .update(value)
      .digest('hex')
    return `hmac-sha256:${key.keyId}:${digest}`
  }

  private async stableForSigning(): Promise<ActiveReplayKey> {
    if (this.cached) {
      const record = await this.persistence.current()

      if (
        record?.phase === INSTALLATION_GENERATION_PHASE.activeInstalled &&
        sameActive(this.cached, record)
      ) {
        return this.cached
      }
    }

    return this.bootstrap()
  }

  private async tryReadStable(
    record: InstallationGenerationRecord,
  ): Promise<ActiveReplayKey | null> {
    try {
      const active = await this.keyring.readActive()
      return active && sameActive(active, record) ? active : null
    } catch (error) {
      if (this.topology === REPLAY_KEY_TOPOLOGY.externalShared) {
        throw witnessError((error as Error).message)
      }

      return null
    }
  }

  private async readCandidate(record: InstallationGenerationRecord): Promise<ReplayKeyMaterial> {
    if (!record.candidateKeyId || !record.candidateHash) {
      throw witnessError(`generation ${record.generation} has no complete candidate witness`)
    }
    const candidate = await this.keyring.readKey(record.candidateKeyId)

    if (!candidate || candidate.hash !== record.candidateHash) {
      throw witnessError(`candidate ${record.candidateKeyId} is missing or mismatched`)
    }

    return candidate
  }

  private async startReplacement(
    expected: InstallationGenerationRecord | null,
    active: ActiveReplayKey | null,
  ): Promise<boolean> {
    const candidate = await this.keyring.createCandidate()
    const record: InstallationGenerationRecord = {
      generation: (expected?.generation ?? 0) + 1,
      phase: INSTALLATION_GENERATION_PHASE.candidateReady,
      activeKeyId: active?.keyId ?? null,
      activeHash: active?.hash ?? null,
      candidateKeyId: candidate.keyId,
      candidateHash: candidate.hash,
      changedAt: this.now().toISOString(),
    }
    const result = await this.persistence.compareAndSet({ expected, record })

    if (result.status === 'backup-frozen') {
      throw new Error(
        `installation replay-key transition is frozen by backup ${result.freeze.owner}`,
      )
    }

    return result.status === 'installed'
  }

  private async recoverReplacement(record: InstallationGenerationRecord): Promise<boolean> {
    const candidate = await this.readCandidate(record)
    const active = await this.keyring.readActive()

    if (record.phase === INSTALLATION_GENERATION_PHASE.candidateReady) {
      if (!record.activeKeyId && active) {
        throw witnessError('candidate-ready generation has an unwitnessed active pointer')
      }
      if (
        record.activeKeyId &&
        record.activeHash &&
        (!active || active.keyId !== record.activeKeyId || active.hash !== record.activeHash)
      ) {
        throw witnessError('previous active key changed before candidate publication')
      }
      const publishing: InstallationGenerationRecord = {
        ...record,
        phase: INSTALLATION_GENERATION_PHASE.publishingActive,
        changedAt: this.now().toISOString(),
      }
      const result = await this.persistence.compareAndSet({ expected: record, record: publishing })

      if (result.status === 'backup-frozen') {
        throw new Error(
          `installation replay-key transition is frozen by backup ${result.freeze.owner}`,
        )
      }

      return result.status === 'installed'
    }
    const candidateAlreadyActive =
      active?.generation === record.generation &&
      active.keyId === candidate.keyId &&
      active.hash === candidate.hash

    if (!candidateAlreadyActive) {
      if (!record.activeKeyId && active) {
        throw witnessError('publishing generation has an unrelated active pointer')
      }
      if (
        record.activeKeyId &&
        record.activeHash &&
        (!active || active.keyId !== record.activeKeyId || active.hash !== record.activeHash)
      ) {
        throw witnessError('active key is neither the previous nor the published candidate')
      }
      await this.keyring.installActive(record.generation, candidate)
    }
    const installed: InstallationGenerationRecord = {
      generation: record.generation,
      phase: INSTALLATION_GENERATION_PHASE.activeInstalled,
      activeKeyId: candidate.keyId,
      activeHash: candidate.hash,
      candidateKeyId: null,
      candidateHash: null,
      changedAt: this.now().toISOString(),
    }
    const result = await this.persistence.compareAndSet({ expected: record, record: installed })

    if (result.status === 'backup-frozen') {
      throw new Error(
        `installation replay-key transition is frozen by backup ${result.freeze.owner}`,
      )
    }

    return result.status === 'installed'
  }
}
