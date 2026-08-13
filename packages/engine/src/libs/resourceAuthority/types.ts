import type {
  FileClaim,
  FileObservation,
  FileProofTransition,
  FileStore,
  FileStrictStageHeader,
} from '../files'

export type AdmissionMode = 'shared' | 'exclusive'
export type AdmissionScope = 'resource' | 'package'

export type AdmissionRequest = {
  scope: AdmissionScope
  mode: AdmissionMode
  owner: string
  /** Resource path for resource leases; package root for package leases. */
  path: string
  /** Package hierarchy a resource belongs to. Defaults to the resource itself. */
  packagePath?: string
  deadlineMs?: number
  signal?: AbortSignal
}

export type AdmissionLease = {
  readonly id: string
  readonly scope: AdmissionScope
  readonly mode: AdmissionMode
  readonly owner: string
  readonly path: string
  readonly packagePath: string
  readonly deadlineAt: number | null
  readonly signal: AbortSignal
  /** Request cooperative cancellation. An active lease remains a blocker until
   * its owner settles, so cancellation can never create unsafe overlap. */
  cancel(reason?: unknown): void
  /** Release the hierarchy exactly once. */
  settle(): void
}

export type AdmissionDiagnostic = {
  id: string
  state: 'waiting' | 'active' | 'cancelling'
  scope: AdmissionScope
  mode: AdmissionMode
  owner: string
  path: string
  packagePath: string
  deadlineAt: number | null
}

export type ResourceAuthorityAdapter = {
  id: string
  prefix: string
  files: FileStore
  /** Physical root used only for composition validation. */
  physicalRoot?: string
}

export type ResourceObservation = FileObservation & {
  spaceId: string
  path: string
  adapterId: string
  observationId: string
}

export type StableLinkedObservation = {
  source: ResourceObservation & { kind: 'present' }
  target: ResourceObservation & { kind: 'present' }
}

export type ResourcePublicationRequest =
  | {
      kind: 'put'
      path: string
      content: Uint8Array
      expected: FileClaim
      packagePath?: string
    }
  | {
      kind: 'move-put'
      sourcePath: string
      targetPath: string
      content: Uint8Array
      expectedSource: FileClaim & { kind: 'present' }
      expectedTarget: FileClaim & { kind: 'absent' }
      packagePath?: string
    }

export type ResourcePackagePublicationRequest = {
  rootPath: string
  files: ReadonlyArray<{ path: string; content: Uint8Array }>
  expectedRoot: FileClaim & { kind: 'absent' }
}

export type ResourceProofTransition = Omit<FileProofTransition, 'path'> & { path: string }

export type MutationReceipt = {
  id: string
  spaceId: string
  adapterId: string
  observationId: string
  semanticEventTime: string
  /** Publication receipts correlate one live mutation with metadata/watcher
   * adoption. Strict restart recovery has its own durable staged protocol. */
  restartDurable: false
  candidateHash: string
  transitions: ResourceProofTransition[]
}

export type ResourcePublicationResult =
  { status: 'conflict' } | { status: 'published'; receipt: MutationReceipt }

export type ResourceStrictStageRequest = {
  operationId: string
  binding: string
  path: string
  content: Uint8Array
  expected: FileClaim
  packagePath?: string
}

export type ResourceStrictStageRef = {
  operationId: string
  binding: string
  path: string
  packagePath?: string
}

export type ResourceStrictStageHeader = Omit<FileStrictStageHeader, 'path'> & {
  spaceId: string
  adapterId: string
  path: string
}

export type StrictMutationReceipt = {
  operationId: string
  binding: string
  spaceId: string
  adapterId: string
  observationId: string
  semanticEventTime: string
  restartDurable: true
  candidateHash: string
  transitions: ResourceProofTransition[]
}

export type ResourceStrictStageState =
  | { status: 'missing' }
  | {
      status: 'staged' | 'publishing'
      stage: ResourceStrictStageHeader
    }
  | {
      status: 'published'
      stage: ResourceStrictStageHeader
      receipt: StrictMutationReceipt
    }
  | {
      status: 'failed-recoverable'
      stage: ResourceStrictStageHeader
      reason: string
      recoveryPaths: string[]
    }

export type ResourceStrictStageResult =
  | {
      status: 'accepted'
      created: boolean
      state: Exclude<ResourceStrictStageState, { status: 'missing' }>
    }
  | { status: 'idempotency-conflict' }

export type ResourceStrictPublicationResult =
  | { status: 'conflict'; stage: ResourceStrictStageHeader }
  | { status: 'published'; receipt: StrictMutationReceipt }
  | {
      status: 'failed-recoverable'
      stage: ResourceStrictStageHeader
      reason: string
      recoveryPaths: string[]
    }

export type ResourceRootInput = {
  spaceId: string
  adapterId: string
  root: string
}

export type CanonicalResourceRoot = ResourceRootInput & {
  canonicalRoot: string
}

export const sameFileClaim = (left: FileClaim, right: FileClaim): boolean =>
  left.kind === right.kind && left.value === right.value
