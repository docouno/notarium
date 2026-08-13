import {
  type BackupGenerationBundle,
  type BackupGenerationFreezeRecord,
  INSTALLATION_GENERATION_PHASE,
  type InstallationGenerationPersistence,
  type InstallationGenerationRecord,
} from '../types'

const sameGeneration = (
  left: InstallationGenerationRecord | null,
  right: InstallationGenerationRecord | null,
): boolean =>
  left?.generation === right?.generation &&
  left?.phase === right?.phase &&
  left?.activeKeyId === right?.activeKeyId &&
  left?.activeHash === right?.activeHash &&
  left?.candidateKeyId === right?.candidateKeyId &&
  left?.candidateHash === right?.candidateHash &&
  left?.changedAt === right?.changedAt

const sameBundle = (
  record: InstallationGenerationRecord,
  expected: BackupGenerationBundle,
): boolean =>
  record.generation === expected.generation &&
  record.activeKeyId === expected.keyId &&
  record.activeHash === expected.activeHash &&
  record.candidateKeyId === expected.candidateKeyId &&
  record.candidateHash === expected.candidateHash

export class InMemoryInstallationGenerationPersistence implements InstallationGenerationPersistence {
  private record: InstallationGenerationRecord | null = null
  private freeze: BackupGenerationFreezeRecord | null = null

  async init(): Promise<void> {}

  async current(): Promise<InstallationGenerationRecord | null> {
    return this.record ? { ...this.record } : null
  }

  async compareAndSet(input: {
    expected: InstallationGenerationRecord | null
    record: InstallationGenerationRecord
  }) {
    if (this.freeze && this.freeze.expiresAt > input.record.changedAt) {
      return { status: 'backup-frozen', freeze: { ...this.freeze } } as const
    }
    if (!sameGeneration(this.record, input.expected)) {
      return {
        status: 'generation-conflict',
        record: this.record ? { ...this.record } : null,
      } as const
    }
    if (
      input.record.phase === INSTALLATION_GENERATION_PHASE.activeInstalled &&
      (input.record.activeKeyId == null || input.record.activeHash == null)
    ) {
      throw new Error('an installed generation requires an active key hash')
    }
    this.record = { ...input.record }
    return { status: 'installed', record: { ...this.record } } as const
  }

  async acquireBackupFreeze(input: { owner: string; now: string; expiresAt: string }) {
    if (!this.record) {
      return { status: 'missing-generation' } as const
    }
    if (
      this.record.phase !== INSTALLATION_GENERATION_PHASE.activeInstalled ||
      !this.record.activeKeyId ||
      !this.record.activeHash
    ) {
      return { status: 'unstable-generation', record: { ...this.record } } as const
    }
    if (this.freeze && this.freeze.expiresAt > input.now && this.freeze.owner !== input.owner) {
      return { status: 'busy', freeze: { ...this.freeze } } as const
    }
    this.freeze = {
      owner: input.owner,
      generation: this.record.generation,
      keyId: this.record.activeKeyId,
      activeHash: this.record.activeHash,
      candidateKeyId: this.record.candidateKeyId,
      candidateHash: this.record.candidateHash,
      acquiredAt: input.now,
      heartbeatAt: input.now,
      expiresAt: input.expiresAt,
    }
    return { status: 'acquired', freeze: { ...this.freeze } } as const
  }

  async renewBackupFreeze(input: {
    owner: string
    expected: BackupGenerationBundle
    now: string
    expiresAt: string
  }) {
    if (!this.freeze || this.freeze.owner !== input.owner || this.freeze.expiresAt <= input.now) {
      return { status: 'lost' } as const
    }
    if (!this.record || !sameBundle(this.record, input.expected)) {
      return {
        status: 'generation-changed',
        record: this.record ? { ...this.record } : null,
      } as const
    }
    this.freeze = { ...this.freeze, heartbeatAt: input.now, expiresAt: input.expiresAt }
    return { status: 'renewed', freeze: { ...this.freeze } } as const
  }

  async releaseBackupFreeze(owner: string): Promise<void> {
    if (this.freeze?.owner === owner) {
      this.freeze = null
    }
  }

  async recoverExpiredBackupFreeze(now: string): Promise<boolean> {
    if (!this.freeze || this.freeze.expiresAt > now) {
      return false
    }
    this.freeze = null
    return true
  }
}
