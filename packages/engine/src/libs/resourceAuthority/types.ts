import type {
  FileClaim,
  FileClaimedRemoval,
  FileObservation,
  FilePackagePublication,
  FileProofTransition,
  FileResourceExport,
  FileResourceObservation,
  FileResourcePublication,
  FileStat,
  FileStoreAssembly,
  FileStrictPublication,
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
  /** The fence's own drain lease, not application work. It overlaps every key, so
   *  it is the one lease whose presence must NOT read as "somebody is admitted
   *  here" — while it is held the authority is closed and empty by definition. */
  lifecycle?: boolean
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

/** The base inventory the authority itself needs: enumerate a placement, read a
 *  manifest, and tell a directory from a file. Deliberately three operations and
 *  not the whole port — the authority owns physical bytes and admission, so it
 *  has no business reaching a directory move or a note write. */
export type ResourceAuthorityFileView = {
  scan(): Promise<FileStat[]>
  read(path: string): Promise<string | null>
  dirExists(path: string): Promise<boolean>
}

/** Which physical-byte guarantees this adapter declared. Each one is checked on
 *  its own, because each degrades on its own: an adapter can observe without
 *  being able to publish, and publish single resources without being able to
 *  install a package. */
export type ResourceAuthorityFileCapabilities = {
  resourceExport?: FileResourceExport
  resourceObservation?: FileResourceObservation
  resourcePublication?: FileResourcePublication
  claimedRemoval?: FileClaimedRemoval
  packagePublication?: FilePackagePublication
  strictPublication?: FileStrictPublication
}

export type ResourceAuthorityAdapter = {
  id: string
  prefix: string
  files: ResourceAuthorityFileView
  capabilities: ResourceAuthorityFileCapabilities
  /** Physical root used only for composition validation. */
  physicalRoot?: string
}

/** Project one adapter assembly onto one authority adapter — the counterpart of
 *  `engineMountOf`, and the reason neither consumer ever holds the aggregate. */
export const resourceAuthorityAdapterOf = (
  identity: { id: string; prefix: string; physicalRoot?: string },
  assembly: FileStoreAssembly,
): ResourceAuthorityAdapter => ({
  id: identity.id,
  prefix: identity.prefix,
  ...(identity.physicalRoot === undefined ? {} : { physicalRoot: identity.physicalRoot }),
  // The base port itself, narrowed by the field's TYPE rather than by a wrapper:
  // the authority cannot name an operation outside the view, and one adapter
  // still shares the single lock/recovery context of its root.
  files: assembly.base,
  capabilities: {
    ...(assembly.capabilities.resourceExport
      ? { resourceExport: assembly.capabilities.resourceExport }
      : {}),
    ...(assembly.capabilities.resourceObservation
      ? { resourceObservation: assembly.capabilities.resourceObservation }
      : {}),
    ...(assembly.capabilities.resourcePublication
      ? { resourcePublication: assembly.capabilities.resourcePublication }
      : {}),
    ...(assembly.capabilities.claimedRemoval
      ? { claimedRemoval: assembly.capabilities.claimedRemoval }
      : {}),
    ...(assembly.capabilities.packagePublication
      ? { packagePublication: assembly.capabilities.packagePublication }
      : {}),
    ...(assembly.capabilities.strictPublication
      ? { strictPublication: assembly.capabilities.strictPublication }
      : {}),
  },
})

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

/** One placement's package publication, handed out only where the adapter can
 *  actually perform the whole protocol. Its EXISTENCE is the availability
 *  answer, so a caller asks composition once and never probes a method.
 *
 *  The claim never leaves this object: routing, the strict absent observation it
 *  is derived from, the placement-wide manifest-name check and the commit are
 *  one admitted decision. Split across a caller, another writer could take the
 *  name between the check and the publication that acts on it. */
export type PackagePublicationView = {
  publishIfAbsent(
    request: Omit<ResourcePackagePublicationRequest, 'expectedRoot'>,
  ): Promise<ResourcePublicationResult>
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
