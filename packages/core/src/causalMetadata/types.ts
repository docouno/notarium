import type { IdentityRecord, RevisionBlob, RevisionInput } from '../knowledgeStore'

export const CAUSAL_BARRIER_KIND = {
  installationGeneration: 'installation-generation',
  spaceLifecycle: 'space-lifecycle',
  note: 'note',
  address: 'address',
  ownerProof: 'owner-proof',
  operation: 'operation',
  blob: 'blob',
  outbox: 'outbox',
} as const

export type CausalBarrierKind = (typeof CAUSAL_BARRIER_KIND)[keyof typeof CAUSAL_BARRIER_KIND]

export type CausalBarrierKey = {
  kind: CausalBarrierKind
  /** Null only for installation-wide keys. */
  space: string | null
  key: string
}

export const RESTORE_OPERATION_PHASE = {
  staged: 'staged',
  prepared: 'prepared',
  physicalPublished: 'physical-published',
  metadataCommitted: 'metadata-committed',
  succeeded: 'succeeded',
  rejected: 'rejected',
  failedRecoverable: 'failed-recoverable',
} as const

export type RestoreOperationPhase =
  (typeof RESTORE_OPERATION_PHASE)[keyof typeof RESTORE_OPERATION_PHASE]

export type RestoreOperationRecord = {
  id: string
  space: string
  noteId: string
  endpoint: string
  /** HMAC/domain-separated values only; raw actor/key never enter persistence. */
  actorDigest: string
  idempotencyDigest: string
  requestFingerprint: string
  stageBinding: string
  phase: RestoreOperationPhase
  sourceRevisionId: string | null
  expectedHeadRevisionId: string | null
  targetPath: string | null
  preparedEvidence: string | null
  physicalReceipt: string | null
  terminalResult: string | null
  failureCode: string | null
  createdAt: string
  updatedAt: string
}

export type RestoreOperationAcceptance = Omit<
  RestoreOperationRecord,
  | 'phase'
  | 'expectedHeadRevisionId'
  | 'physicalReceipt'
  | 'terminalResult'
  | 'failureCode'
  | 'updatedAt'
> & {
  phase?: typeof RESTORE_OPERATION_PHASE.staged
  /** Accepted command evidence needed to resume a crash before prepare. */
  sourceRevisionId: string
  targetPath: string
  preparedEvidence: string
  /** Internal recovery grant: a non-terminal accepted bulk parent may admit its
   * deterministic child while the space is closing. Never accepted from wire. */
  parentOperationId?: string
  /** Notes whose retained source/history must survive until this operation is
   * terminal. A bulk parent pins its frozen roster before any child starts. */
  protectedNoteIds?: readonly string[]
}

export type RestoreOperationAcceptResult =
  | { status: 'accepted'; operation: RestoreOperationRecord }
  | { status: 'replayed'; operation: RestoreOperationRecord }
  | { status: 'idempotency-conflict'; operation: RestoreOperationRecord }

export type RestoreOperationTransition = {
  id: string
  expectedPhases: readonly RestoreOperationPhase[]
  expectedPreparedEvidence?: string | null
  phase: RestoreOperationPhase
  updatedAt: string
  sourceRevisionId?: string | null
  expectedHeadRevisionId?: string | null
  targetPath?: string | null
  preparedEvidence?: string | null
  physicalReceipt?: string | null
  terminalResult?: string | null
  failureCode?: string | null
}

export type RestoreOperationTransitionResult =
  | { status: 'transitioned'; operation: RestoreOperationRecord }
  | { status: 'missing' }
  | { status: 'phase-conflict'; operation: RestoreOperationRecord }

export type RestoreOperationPersistence = {
  init(): Promise<void>
  accept(input: RestoreOperationAcceptance): Promise<RestoreOperationAcceptResult>
  get(id: string): Promise<RestoreOperationRecord | null>
  getByReplay(
    actorDigest: string,
    endpoint: string,
    idempotencyDigest: string,
  ): Promise<RestoreOperationRecord | null>
  transition(input: RestoreOperationTransition): Promise<RestoreOperationTransitionResult>
  /** Every non-terminal operation, stable creation order, for startup recovery. */
  listRecoverable(space?: string): Promise<RestoreOperationRecord[]>
}

export type RestoreTerminalIdentityExpectation = {
  addressRevision: number
  filePath: string
  deletedAt: string | null
}

export type RestoreTerminalResult = {
  noteId: string
  filePath: string
  revisionId: string
  versionToken: string
}

/** One indivisible metadata-side completion after strict physical publication.
 * Every redundant value is deliberate: the transaction binds the caller's
 * immutable evidence back to the accepted operation before advancing any
 * causal head. */
export type RestoreTerminalCommit = {
  operationId: string
  sourceRevisionId: string
  expectedHeadRevisionId: string
  targetPath: string
  preparedEvidence: string
  physicalReceipt: string
  expectedIdentity: RestoreTerminalIdentityExpectation
  identity: IdentityRecord
  revision: RevisionInput
  content: RevisionBlob
  proof: Omit<OwnerProofAdoption, 'noteId' | 'space' | 'addressRevision' | 'updatedAt'>
  result: Omit<RestoreTerminalResult, 'revisionId'>
  outboxKind: string
  committedAt: string
}

export const RESTORE_TERMINAL_CONFLICT = {
  operationMissing: 'operation-missing',
  operationPhase: 'operation-phase',
  operationEvidence: 'operation-evidence',
  lifecycle: 'lifecycle',
  revisionHead: 'revision-head',
  identity: 'identity',
  targetOccupied: 'target-occupied',
  proof: 'proof',
  receipt: 'receipt',
} as const

export type RestoreTerminalConflict =
  (typeof RESTORE_TERMINAL_CONFLICT)[keyof typeof RESTORE_TERMINAL_CONFLICT]

export type RestoreTerminalCommitResult =
  | {
      status: 'committed' | 'replayed'
      operation: RestoreOperationRecord
      result: RestoreTerminalResult
    }
  | {
      status: 'conflict'
      conflict: RestoreTerminalConflict
      operation: RestoreOperationRecord | null
    }

export type RestoreTerminalFinalize = {
  operationId: string
  preparedEvidence: string
  physicalReceipt: string
  outboxKind: string
  finalizedAt: string
}

export type RestoreTerminalPersistence = {
  init(): Promise<void>
  commit(input: RestoreTerminalCommit): Promise<RestoreTerminalCommitResult>
  /** Publish the wake-up only after the caller has rebound the durable physical
   * receipt to the current public pathname. Replay is idempotent. */
  finalize(input: RestoreTerminalFinalize): Promise<RestoreTerminalCommitResult>
}

export const SPACE_LIFECYCLE_PHASE = {
  active: 'active',
  closing: 'closing',
  archived: 'archived',
  purgeIntent: 'purge-intent',
  metadataCleaned: 'metadata-cleaned',
  physicalCleaned: 'physical-cleaned',
  purged: 'purged',
} as const

export type SpaceLifecyclePhase = (typeof SPACE_LIFECYCLE_PHASE)[keyof typeof SPACE_LIFECYCLE_PHASE]

export type SpaceLifecycleRecord = {
  space: string
  phase: SpaceLifecyclePhase
  generation: number
  cleanupManifest: string | null
  changedAt: string
  changedBy: string | null
}

export type SpaceLifecycleTransitionResult =
  | { status: 'transitioned'; lifecycle: SpaceLifecycleRecord }
  | { status: 'missing' }
  | { status: 'phase-conflict'; lifecycle: SpaceLifecycleRecord }

export type SpaceLifecyclePersistence = {
  init(): Promise<void>
  ensure(
    space: string,
    phase: typeof SPACE_LIFECYCLE_PHASE.active | typeof SPACE_LIFECYCLE_PHASE.archived,
    now: string,
  ): Promise<SpaceLifecycleRecord>
  get(space: string): Promise<SpaceLifecycleRecord | null>
  transition(input: {
    space: string
    expectedPhases: readonly SpaceLifecyclePhase[]
    phase: SpaceLifecyclePhase
    changedAt: string
    changedBy?: string | null
    cleanupManifest?: string | null
  }): Promise<SpaceLifecycleTransitionResult>
  listUnfinished(): Promise<SpaceLifecycleRecord[]>
}

export type CausalOutboxRecord = {
  id: string
  space: string
  generation: number
  kind: string
  operationId: string | null
  resourceId: string
  createdAt: string
  acknowledgedAt: string | null
}

export type CausalOutboxPersistence = {
  init(): Promise<void>
  append(input: Omit<CausalOutboxRecord, 'id' | 'acknowledgedAt'>): Promise<CausalOutboxRecord>
  pending(subscriberId: string, limit: number): Promise<CausalOutboxRecord[]>
  acknowledge(subscriberId: string, ids: readonly string[], at: string): Promise<void>
}

export type OwnerProofBindingRecord = {
  noteId: string
  space: string
  addressRevision: number
  proofRevision: number
  sourceHash: string
  proofJson: string
  receiptId: string
  updatedAt: string
}

export type OwnerProofAdoption = Omit<OwnerProofBindingRecord, 'proofRevision'> & {
  expectedProofRevision: number | null
}

export type OwnerProofAdoptionResult =
  | { status: 'adopted'; binding: OwnerProofBindingRecord }
  | { status: 'replayed'; binding: OwnerProofBindingRecord }
  | { status: 'missing-address' }
  | { status: 'address-conflict'; addressRevision: number }
  | { status: 'proof-conflict'; binding: OwnerProofBindingRecord | null }
  | { status: 'receipt-conflict'; binding: OwnerProofBindingRecord }

export type OwnerProofPersistence = {
  init(): Promise<void>
  get(noteId: string): Promise<OwnerProofBindingRecord | null>
  getByReceipt(space: string, receiptId: string): Promise<OwnerProofBindingRecord | null>
  adopt(input: OwnerProofAdoption): Promise<OwnerProofAdoptionResult>
}

export const INSTALLATION_GENERATION_PHASE = {
  candidateReady: 'candidate-ready',
  publishingActive: 'publishing-active',
  activeInstalled: 'active-installed',
} as const

export type InstallationGenerationPhase =
  (typeof INSTALLATION_GENERATION_PHASE)[keyof typeof INSTALLATION_GENERATION_PHASE]

export type InstallationGenerationRecord = {
  generation: number
  phase: InstallationGenerationPhase
  activeKeyId: string | null
  activeHash: string | null
  candidateKeyId: string | null
  candidateHash: string | null
  changedAt: string
}

export type BackupGenerationFreezeRecord = {
  owner: string
  generation: number
  keyId: string
  activeHash: string
  candidateKeyId: string | null
  candidateHash: string | null
  acquiredAt: string
  heartbeatAt: string
  expiresAt: string
}

export type BackupGenerationBundle = Pick<
  BackupGenerationFreezeRecord,
  'generation' | 'keyId' | 'activeHash' | 'candidateKeyId' | 'candidateHash'
>

export type InstallationGenerationPersistence = {
  init(): Promise<void>
  current(): Promise<InstallationGenerationRecord | null>
  compareAndSet(input: {
    expected: InstallationGenerationRecord | null
    record: InstallationGenerationRecord
  }): Promise<
    | { status: 'installed'; record: InstallationGenerationRecord }
    | { status: 'generation-conflict'; record: InstallationGenerationRecord | null }
    | { status: 'backup-frozen'; freeze: BackupGenerationFreezeRecord }
  >
  acquireBackupFreeze(input: {
    owner: string
    now: string
    expiresAt: string
  }): Promise<
    | { status: 'acquired'; freeze: BackupGenerationFreezeRecord }
    | { status: 'missing-generation' }
    | { status: 'unstable-generation'; record: InstallationGenerationRecord }
    | { status: 'busy'; freeze: BackupGenerationFreezeRecord }
  >
  renewBackupFreeze(input: {
    owner: string
    expected: BackupGenerationBundle
    now: string
    expiresAt: string
  }): Promise<
    | { status: 'renewed'; freeze: BackupGenerationFreezeRecord }
    | { status: 'lost' }
    | { status: 'generation-changed'; record: InstallationGenerationRecord | null }
  >
  releaseBackupFreeze(owner: string): Promise<void>
  recoverExpiredBackupFreeze(now: string): Promise<boolean>
}
