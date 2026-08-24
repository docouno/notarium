import {
  analyzeDocumentState,
  basenameOf,
  directoryOf,
  DOCUMENT_ROLE,
  DOCUMENT_STATE_FORMAT,
  isSkillPackageRootPath,
  sha256Hex,
  skillPackagePathOf,
  skillPlacementPathOf,
} from '@notarium/core'

import type {
  FileClaim,
  FileObservation,
  FilePackagePublicationRequest,
  FileProofTransition,
  FilePublicationRequest,
  FilePublicationResult,
  FileStrictMutationReceipt,
  FileStrictPublicationResult,
  FileStrictStageHeader,
  FileStrictStageRequest,
  FileStrictStageResult,
  FileStrictStageState,
} from '../files'
import {
  adaptersInSnapshot,
  snapshotInTrustedInput,
  snapshotResourceAuthorityAdapters,
  type TrustedResourceAuthorityAdapterSnapshotInput,
} from './adapterSnapshot'
import { ResourceAdmission } from './admission'
import { assertCanonicalResourceRoot, preflightResourceRoots } from './roots'
import {
  type AdmissionDiagnostic,
  type AdmissionLease,
  type AdmissionMode,
  type CanonicalResourceRoot,
  type MutationReceipt,
  type PackagePublicationView,
  type ResourceAuthorityAdapter,
  type ResourceObservation,
  type ResourcePackagePublicationRequest,
  type ResourcePublicationRequest,
  type ResourcePublicationResult,
  type ResourceStrictPublicationResult,
  type ResourceStrictStageHeader,
  type ResourceStrictStageRef,
  type ResourceStrictStageRequest,
  type ResourceStrictStageResult,
  type ResourceStrictStageState,
  sameFileClaim,
  type StableLinkedObservation,
  type StrictMutationReceipt,
} from './types'

/** The one file a skill package is addressed by. `isSkillPackageRootPath` is the
 * canonical predicate over it; this is the same name spelled once for the two
 * places below that have to CONSTRUCT the address rather than test one. */
const SKILL_MANIFEST_FILENAME = 'SKILL.md'

type RoutedResource = {
  adapter: ResourceAuthorityAdapter
  relativePath: string
}

let nextObservationId = 1
let nextReceiptId = 1

const normalizePath = (path: string): string => {
  if (!path || path.startsWith('/') || path.endsWith('/') || path.includes('\\')) {
    throw new Error(`resource path is not canonical: ${path}`)
  }
  const segments = path.split('/')

  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(`resource path is not canonical: ${path}`)
  }

  return path
}

const snapshotClaim = <T extends FileClaim>(claim: T): T =>
  ({ kind: claim.kind, value: claim.value }) as T

const snapshotObservation = (observation: FileObservation): FileObservation => {
  if (observation.kind === 'present') {
    return {
      kind: 'present',
      bytes: Uint8Array.from(observation.bytes),
      claim: snapshotClaim(observation.claim),
      mtimeMs: observation.mtimeMs,
    }
  }
  if (observation.kind === 'absent') {
    return {
      kind: 'absent',
      claim: snapshotClaim(observation.claim),
      mtimeMs: null,
    }
  }
  if (observation.kind === 'occupied') {
    return {
      kind: 'occupied',
      claim: snapshotClaim(observation.claim),
      entryType: observation.entryType,
      mtimeMs: observation.mtimeMs,
    }
  }

  return { kind: 'unavailable', reason: observation.reason, mtimeMs: null }
}

const snapshotProofTransition = (transition: FileProofTransition): FileProofTransition => ({
  path: transition.path,
  before: snapshotClaim(transition.before),
  after: snapshotClaim(transition.after),
  mtimeMs: transition.mtimeMs,
})

const snapshotPublicationResult = (result: FilePublicationResult): FilePublicationResult =>
  result.status === 'conflict'
    ? { status: 'conflict' }
    : {
        status: 'published',
        candidateHash: result.candidateHash,
        transitions: result.transitions.map(snapshotProofTransition),
      }

const snapshotStrictHeader = (stage: FileStrictStageHeader): FileStrictStageHeader => ({
  operationId: stage.operationId,
  binding: stage.binding,
  path: stage.path,
  expected: snapshotClaim(stage.expected),
  candidateHash: stage.candidateHash,
})

const snapshotStrictReceipt = (receipt: FileStrictMutationReceipt): FileStrictMutationReceipt => ({
  operationId: receipt.operationId,
  binding: receipt.binding,
  observationId: receipt.observationId,
  semanticEventTime: receipt.semanticEventTime,
  restartDurable: receipt.restartDurable,
  candidateHash: receipt.candidateHash,
  transitions: receipt.transitions.map(snapshotProofTransition),
})

type PresentStrictStageState = Exclude<FileStrictStageState, { status: 'missing' }>

const snapshotPresentStrictState = (state: PresentStrictStageState): PresentStrictStageState => {
  const stage = snapshotStrictHeader(state.stage)

  if (state.status === 'published') {
    return { status: 'published', stage, receipt: snapshotStrictReceipt(state.receipt) }
  }
  if (state.status === 'failed-recoverable') {
    return {
      status: 'failed-recoverable',
      stage,
      reason: state.reason,
      recoveryPaths: [...state.recoveryPaths],
    }
  }

  return { status: state.status, stage }
}

const snapshotStrictState = (state: FileStrictStageState): FileStrictStageState =>
  state.status === 'missing' ? { status: 'missing' } : snapshotPresentStrictState(state)

const snapshotStrictStageResult = (result: FileStrictStageResult): FileStrictStageResult =>
  result.status === 'idempotency-conflict'
    ? { status: 'idempotency-conflict' }
    : {
        status: 'accepted',
        created: result.created,
        state: snapshotPresentStrictState(result.state),
      }

const snapshotStrictPublicationResult = (
  result: FileStrictPublicationResult,
): FileStrictPublicationResult => {
  if (result.status === 'published') {
    return { status: 'published', receipt: snapshotStrictReceipt(result.receipt) }
  }
  const stage = snapshotStrictHeader(result.stage)

  return result.status === 'conflict'
    ? { status: 'conflict', stage }
    : {
        status: 'failed-recoverable',
        stage,
        reason: result.reason,
        recoveryPaths: [...result.recoveryPaths],
      }
}

const publicationSubmission = (
  request: ResourcePublicationRequest,
  relativePaths: readonly string[],
): FilePublicationRequest =>
  request.kind === 'put'
    ? {
        kind: 'put',
        path: relativePaths[0],
        content: Uint8Array.from(request.content),
        expected: snapshotClaim(request.expected),
      }
    : {
        kind: 'move-put',
        sourcePath: relativePaths[0],
        targetPath: relativePaths[1],
        content: Uint8Array.from(request.content),
        expectedSource: snapshotClaim(request.expectedSource),
        expectedTarget: snapshotClaim(request.expectedTarget),
      }

const packagePublicationSubmission = (
  rootPath: string,
  files: ReadonlyArray<{ path: string; content: Uint8Array }>,
  expectedRoot: FileClaim & { kind: 'absent' },
): FilePackagePublicationRequest => ({
  rootPath,
  files: files.map((file) => ({ path: file.path, content: Uint8Array.from(file.content) })),
  expectedRoot: snapshotClaim(expectedRoot),
})

const strictStageSubmission = (
  request: ResourceStrictStageRequest,
  relativePath: string,
): FileStrictStageRequest => ({
  operationId: request.operationId,
  binding: request.binding,
  path: relativePath,
  content: Uint8Array.from(request.content),
  expected: snapshotClaim(request.expected),
})

const snapshotPublicationRequest = (
  request: ResourcePublicationRequest,
): ResourcePublicationRequest => {
  const packagePath = request.packagePath ? normalizePath(request.packagePath) : undefined

  return request.kind === 'put'
    ? {
        kind: 'put',
        path: normalizePath(request.path),
        content: Uint8Array.from(request.content),
        expected: snapshotClaim(request.expected),
        ...(packagePath ? { packagePath } : {}),
      }
    : {
        kind: 'move-put',
        sourcePath: normalizePath(request.sourcePath),
        targetPath: normalizePath(request.targetPath),
        content: Uint8Array.from(request.content),
        expectedSource: snapshotClaim(request.expectedSource),
        expectedTarget: snapshotClaim(request.expectedTarget),
        ...(packagePath ? { packagePath } : {}),
      }
}

const snapshotStrictStageRequest = (
  request: ResourceStrictStageRequest,
): ResourceStrictStageRequest => ({
  operationId: request.operationId,
  binding: request.binding,
  path: normalizePath(request.path),
  content: Uint8Array.from(request.content),
  expected: snapshotClaim(request.expected),
  ...(request.packagePath ? { packagePath: normalizePath(request.packagePath) } : {}),
})

const snapshotStrictStageRef = (request: ResourceStrictStageRef): ResourceStrictStageRef => ({
  operationId: request.operationId,
  binding: request.binding,
  path: normalizePath(request.path),
  ...(request.packagePath ? { packagePath: normalizePath(request.packagePath) } : {}),
})

const containsPrefix = (prefix: string, path: string): boolean =>
  !prefix || path === prefix || path.startsWith(`${prefix}/`)

type ProofTransitionExpectation = {
  path: string
  before: FileClaim | FileClaim['kind']
  afterKind: FileClaim['kind']
}

const hasExactProofTransitionSet = (
  transitions: readonly FileProofTransition[],
  expected: readonly ProofTransitionExpectation[],
): boolean => {
  if (transitions.length !== expected.length) {
    return false
  }
  const remaining = new Map(expected.map((transition) => [transition.path, transition]))

  if (remaining.size !== expected.length) {
    return false
  }

  for (const transition of transitions) {
    const expectation = remaining.get(transition.path)

    if (
      !expectation ||
      (typeof expectation.before === 'string'
        ? transition.before.kind !== expectation.before
        : !sameFileClaim(transition.before, expectation.before)) ||
      transition.after.kind !== expectation.afterKind
    ) {
      return false
    }
    remaining.delete(transition.path)
  }

  return remaining.size === 0
}

export class SpaceResourceAuthority {
  readonly spaceId: string
  private readonly adapters: readonly ResourceAuthorityAdapter[]
  private readonly admission = new ResourceAdmission()
  private readonly roots: CanonicalResourceRoot[]
  private accepting = true
  private closePromise: Promise<void> | null = null

  constructor(spaceId: string, adapters: readonly ResourceAuthorityAdapter[])
  constructor(
    spaceId: string,
    input: readonly ResourceAuthorityAdapter[] | TrustedResourceAuthorityAdapterSnapshotInput,
  ) {
    const trustedSnapshot = snapshotInTrustedInput(input)
    const snapshot =
      trustedSnapshot ??
      snapshotResourceAuthorityAdapters(input as readonly ResourceAuthorityAdapter[])
    const snapshots = adaptersInSnapshot(snapshot)

    if (!spaceId.trim()) {
      throw new Error('resource authority requires a space id')
    }
    if (!snapshots.length) {
      throw new Error('resource authority requires at least one adapter')
    }
    if (new Set(snapshots.map((adapter) => adapter.id)).size !== snapshots.length) {
      throw new Error('resource authority adapter ids must be unique')
    }
    if (new Set(snapshots.map((adapter) => adapter.prefix)).size !== snapshots.length) {
      throw new Error('resource authority adapter prefixes must be unique')
    }
    this.spaceId = spaceId
    this.adapters = Object.freeze(
      [...snapshots].sort((left, right) => right.prefix.length - left.prefix.length),
    )
    this.roots = preflightResourceRoots(
      snapshots.flatMap((adapter) =>
        adapter.physicalRoot
          ? [{ spaceId, adapterId: adapter.id, root: adapter.physicalRoot }]
          : [],
      ),
    )
  }

  diagnostics(): AdmissionDiagnostic[] {
    return this.admission.diagnostics()
  }

  /** Stop fresh physical work and wait until every request admitted before the
   * lifecycle fence has settled. The closed state survives the drain; restore
   * must reopen it explicitly. A failed bounded wait remains fail-closed and can
   * be retried without admitting work in between. */
  closeAdmission(options?: { owner?: string; deadlineMs?: number }): Promise<void> {
    this.accepting = false

    if (!this.closePromise) {
      const attempt = this.admission
        .admit({
          scope: 'package',
          mode: 'exclusive',
          owner: options?.owner ?? 'space-lifecycle-close',
          path: '',
          lifecycle: true,
          ...(options?.deadlineMs != null ? { deadlineMs: options.deadlineMs } : {}),
        })
        .then((lease) => lease.settle())
      this.closePromise = attempt
      const clear = (): void => {
        if (this.closePromise === attempt) {
          this.closePromise = null
        }
      }
      void attempt.then(clear, clear)
    }

    return this.closePromise
  }

  reopenAdmission(): void {
    if (this.closePromise) {
      throw new Error('resource admission is still closing')
    }
    this.accepting = true
  }

  async admitResource(
    path: string,
    mode: AdmissionMode,
    owner: string,
    options?: {
      packagePath?: string
      deadlineMs?: number
      signal?: AbortSignal
      allowDuringClosure?: boolean
    },
  ): Promise<AdmissionLease> {
    this.assertAdmissible(options?.allowDuringClosure)

    return this.admission.admit({
      scope: 'resource',
      mode,
      owner,
      path: normalizePath(path),
      ...(options?.packagePath ? { packagePath: normalizePath(options.packagePath) } : {}),
      ...(options?.deadlineMs != null ? { deadlineMs: options.deadlineMs } : {}),
      ...(options?.signal ? { signal: options.signal } : {}),
    })
  }

  async admitPackage(
    packagePath: string,
    mode: AdmissionMode,
    owner: string,
    options?: { deadlineMs?: number; signal?: AbortSignal; allowDuringClosure?: boolean },
  ): Promise<AdmissionLease> {
    this.assertAdmissible(options?.allowDuringClosure)

    return this.admission.admit({
      scope: 'package',
      mode,
      owner,
      path: normalizePath(packagePath),
      ...(options?.deadlineMs != null ? { deadlineMs: options.deadlineMs } : {}),
      ...(options?.signal ? { signal: options.signal } : {}),
    })
  }

  /** Placement-wide skill admission. Unlike a package lease, this deliberately
   * accepts the empty adapter-relative root: Personal/Space packages share that
   * placement and must serialize name check + publication across different ids. */
  async admitSkillPlacement(
    resourcePath: string,
    mode: AdmissionMode,
    owner: string,
    options?: { deadlineMs?: number; signal?: AbortSignal; allowDuringClosure?: boolean },
  ): Promise<AdmissionLease> {
    this.assertAdmissible(options?.allowDuringClosure)
    const path = normalizePath(resourcePath)
    const { adapter, relativePath } = this.route(path)
    const placement = skillPlacementPathOf(relativePath)

    if (placement == null) {
      throw new Error(`resource is not in a canonical skill placement: ${path}`)
    }
    // Admission paths are deliberately flat here. A physical mount root is an
    // ancestor of every project package, but name uniqueness is independent per
    // placement: a Personal/Space mutation must not stall an unrelated project.
    // The empty lifecycle package still overlaps every key and closes the whole
    // authority as before.
    const placementPath = `.__skill-placement/${this.adapters.indexOf(adapter)}/${encodeURIComponent(
      placement || '@root',
    )}`

    return this.admission.admit({
      scope: 'package',
      mode,
      owner,
      path: placementPath,
      ...(options?.deadlineMs != null ? { deadlineMs: options.deadlineMs } : {}),
      ...(options?.signal ? { signal: options.signal } : {}),
    })
  }

  /** Validate one candidate root against file truth while the caller owns the
   * placement lease. The manifest index is derived, so no DB registry becomes a
   * second source of truth. */
  async assertSkillManifestNameAvailableAdmitted(
    resourcePath: string,
    content: Uint8Array,
  ): Promise<void> {
    this.assertAdmitted()
    const path = normalizePath(resourcePath)
    const { adapter, relativePath } = this.route(path)

    if (!isSkillPackageRootPath(relativePath)) {
      return
    }
    const packagePath = skillPackagePathOf(relativePath)!
    const placement = skillPlacementPathOf(relativePath)!
    const directoryName = basenameOf(packagePath)
    const candidate = analyzeDocumentState({
      source: Uint8Array.from(content),
      role: DOCUMENT_ROLE.skillRoot,
      skillDirectoryName: directoryName,
    })
    const name = candidate.projection?.skill?.name

    if (candidate.format !== DOCUMENT_STATE_FORMAT.skill || !name) {
      throw Object.assign(new Error('invalid Agent Skill manifest'), {
        code: 'INVALID_SKILL_MANIFEST',
      })
    }
    const directTarget = placement ? `${placement}/${name}` : name

    if (directTarget !== packagePath && (await adapter.files.dirExists(directTarget))) {
      throw Object.assign(new Error(`skill name "${name}" already exists in this placement`), {
        code: 'SKILL_NAME_CONFLICT',
      })
    }

    for (const entry of await adapter.files.scan()) {
      if (
        entry.path === relativePath ||
        !isSkillPackageRootPath(entry.path) ||
        skillPlacementPathOf(entry.path) !== placement
      ) {
        continue
      }
      const siblingPackage = skillPackagePathOf(entry.path)!
      const raw = await adapter.files.read(entry.path)

      if (raw == null) {
        continue
      }
      const sibling = analyzeDocumentState({
        source: new TextEncoder().encode(raw),
        role: DOCUMENT_ROLE.skillRoot,
        skillDirectoryName: basenameOf(siblingPackage),
      })

      if (sibling.projection?.skill?.name === name) {
        throw Object.assign(new Error(`skill name "${name}" already exists in this placement`), {
          code: 'SKILL_NAME_CONFLICT',
        })
      }
    }
  }

  /** Buffered reads release admission only after cloning the immutable sample. */
  async observe(
    path: string,
    options?: {
      owner?: string
      packagePath?: string
      deadlineMs?: number
      signal?: AbortSignal
      maxBytes?: number
      allowDuringClosure?: boolean
    },
  ): Promise<ResourceObservation> {
    const canonicalPath = normalizePath(path)
    const owner = options?.owner ?? 'observe'
    const packagePath = options?.packagePath
    const deadlineMs = options?.deadlineMs
    const signal = options?.signal
    const maxBytes = options?.maxBytes
    const allowDuringClosure = options?.allowDuringClosure

    if (maxBytes != null && (!Number.isSafeInteger(maxBytes) || maxBytes < 0)) {
      throw new Error('observation maxBytes must be a non-negative safe integer')
    }
    const lease = await this.admitResource(canonicalPath, 'shared', owner, {
      ...(packagePath ? { packagePath } : {}),
      ...(deadlineMs != null ? { deadlineMs } : {}),
      // AbortSignal is the intentional live control channel; scalar options are
      // captured above so caller mutation cannot retarget admitted work.
      ...(signal ? { signal } : {}),
      ...(allowDuringClosure ? { allowDuringClosure: true } : {}),
    })

    try {
      return await this.observeAdmitted(canonicalPath, maxBytes)
    } finally {
      lease.settle()
    }
  }

  /** Classify an auxiliary against a skill root without ever combining bytes
   * from two source versions: A(source) → target → B(source), under package
   * admission. The caller validates the target manifest from this exact sample. */
  async observeLinked(
    sourcePath: string,
    targetPath: string,
    validateTarget: (target: ResourceObservation & { kind: 'present' }) => boolean,
    options?: { owner?: string; deadlineMs?: number; signal?: AbortSignal },
  ): Promise<StableLinkedObservation | null> {
    const source = normalizePath(sourcePath)
    const target = normalizePath(targetPath)
    const packagePath = directoryOf(target) || basenameOf(target)
    const packageLease = await this.admitPackage(
      packagePath,
      'shared',
      options?.owner ?? 'observe-linked',
      options,
    )

    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const first = await this.observe(source, { packagePath, owner: 'observe-linked-source' })
        const targetObservation = await this.observe(target, {
          packagePath,
          owner: 'observe-linked-target',
        })
        const second = await this.observe(source, { packagePath, owner: 'observe-linked-source' })

        if (
          first.kind === 'present' &&
          second.kind === 'present' &&
          sameFileClaim(first.claim, second.claim)
        ) {
          return targetObservation.kind === 'present' && validateTarget(targetObservation)
            ? { source: second, target: targetObservation }
            : null
        }
      }
      throw Object.assign(new Error('linked resource did not produce a stable observation'), {
        code: 'UNSTABLE_OBSERVATION',
      })
    } finally {
      packageLease.settle()
    }
  }

  /** The caller already owns the enclosing placement/package admission. Keep
   * the same A-target-B stability proof without recursively acquiring a lease. */
  async observeLinkedAdmitted(
    sourcePath: string,
    targetPath: string,
    validateTarget: (target: ResourceObservation & { kind: 'present' }) => boolean,
  ): Promise<StableLinkedObservation | null> {
    this.assertAdmitted()
    const source = normalizePath(sourcePath)
    const target = normalizePath(targetPath)

    for (let attempt = 0; attempt < 3; attempt++) {
      const first = await this.observeAdmitted(source)
      const targetObservation = await this.observeAdmitted(target)
      const second = await this.observeAdmitted(source)

      if (
        first.kind === 'present' &&
        second.kind === 'present' &&
        sameFileClaim(first.claim, second.claim)
      ) {
        return targetObservation.kind === 'present' && validateTarget(targetObservation)
          ? { source: second, target: targetObservation }
          : null
      }
    }
    throw Object.assign(new Error('linked resource did not produce a stable observation'), {
      code: 'UNSTABLE_OBSERVATION',
    })
  }

  /** A lazy adapter export keeps its root-package lease until the consumer
   * drains, returns or throws from the iterator. The adapter may stream files;
   * releasing after iterator creation would make admission purely ceremonial. */
  async *exportAdapter(
    prefix: string,
    options?: { owner?: string; deadlineMs?: number; signal?: AbortSignal },
  ): AsyncIterable<{ path: string; content: Uint8Array }> {
    this.assertRootsStable()
    const canonicalPrefix = normalizePath(prefix)
    const adapter = this.adapters.find((candidate) => candidate.prefix === canonicalPrefix)

    if (!adapter) {
      throw new Error(`no resource adapter is rooted at ${canonicalPrefix}`)
    }
    if (!adapter.capabilities.resourceExport) {
      throw Object.assign(new Error(`adapter ${adapter.id} cannot export resources`), {
        code: 'EXPORT_UNAVAILABLE',
      })
    }
    const lease = await this.admitPackage(
      canonicalPrefix,
      'shared',
      options?.owner ?? 'export',
      options,
    )

    try {
      for await (const entry of adapter.capabilities.resourceExport.exportFiles()) {
        const path = normalizePath(`${canonicalPrefix}/${entry.path}`)

        yield { path, content: Uint8Array.from(entry.content) }
      }
    } finally {
      lease.settle()
    }
  }

  async publish(
    request: ResourcePublicationRequest,
    options?: { owner?: string; deadlineMs?: number; signal?: AbortSignal },
  ): Promise<ResourcePublicationResult> {
    const snapshot = snapshotPublicationRequest(request)
    const paths =
      snapshot.kind === 'put' ? [snapshot.path] : [snapshot.sourcePath, snapshot.targetPath]
    const packagePath = snapshot.packagePath
    const owner = options?.owner ?? 'publish'
    const deadlineMs = options?.deadlineMs
    const signal = options?.signal
    const packageLease = packagePath
      ? await this.admitPackage(packagePath, 'shared', owner, {
          ...(deadlineMs != null ? { deadlineMs } : {}),
          ...(signal ? { signal } : {}),
        })
      : undefined
    const resourceLeases: AdmissionLease[] = []

    try {
      for (const path of [...new Set(paths)].sort()) {
        resourceLeases.push(
          await this.admitResource(path, 'exclusive', owner, {
            ...(packagePath ? { packagePath } : {}),
            ...(deadlineMs != null ? { deadlineMs } : {}),
            ...(signal ? { signal } : {}),
          }),
        )
      }

      return await this.publishAdmitted(snapshot)
    } finally {
      for (const lease of resourceLeases.reverse()) {
        lease.settle()
      }
      packageLease?.settle()
    }
  }

  /** Exact publication for a caller that already owns an enclosing exclusive
   * package/placement lease. */
  async publishAdmitted(request: ResourcePublicationRequest): Promise<ResourcePublicationResult> {
    this.assertAdmitted()
    const snapshot = snapshotPublicationRequest(request)
    const paths =
      snapshot.kind === 'put' ? [snapshot.path] : [snapshot.sourcePath, snapshot.targetPath]
    const routed = paths.map((path) => ({ path, ...this.route(path) }))
    const adapter = routed[0].adapter

    if (routed.some((entry) => entry.adapter !== adapter)) {
      throw new Error('one publication cannot cross resource adapters')
    }
    if (!adapter.capabilities.resourcePublication) {
      throw Object.assign(new Error(`adapter ${adapter.id} cannot publish with proof`), {
        code: 'PUBLICATION_UNAVAILABLE',
      })
    }
    const candidateHash = await sha256Hex(snapshot.content)
    const result = snapshotPublicationResult(
      await adapter.capabilities.resourcePublication.publish(
        publicationSubmission(
          snapshot,
          routed.map((entry) => entry.relativePath),
        ),
      ),
    )

    if (result.status === 'conflict') {
      return result
    }
    if (result.candidateHash !== candidateHash) {
      throw new Error(`adapter ${adapter.id} returned an invalid publication candidate hash`)
    }
    const expectedTransitions: ProofTransitionExpectation[] =
      snapshot.kind === 'put'
        ? [
            {
              path: routed[0].relativePath,
              before: snapshot.expected,
              afterKind: 'present',
            },
          ]
        : [
            {
              path: routed[0].relativePath,
              before: snapshot.expectedSource,
              afterKind: 'absent',
            },
            {
              path: routed[1].relativePath,
              before: snapshot.expectedTarget,
              afterKind: 'present',
            },
          ]

    if (!hasExactProofTransitionSet(result.transitions, expectedTransitions)) {
      throw new Error(`adapter ${adapter.id} returned an invalid publication proof set`)
    }
    const receiptId = `${this.spaceId}:receipt-${nextReceiptId++}`
    const receipt: MutationReceipt = {
      id: receiptId,
      spaceId: this.spaceId,
      adapterId: adapter.id,
      observationId: `${receiptId}:observation`,
      semanticEventTime: new Date().toISOString(),
      restartDurable: false,
      candidateHash,
      transitions: result.transitions.map((transition) => {
        const entry = routed.find((candidate) => candidate.relativePath === transition.path)

        if (!entry) {
          throw new Error(`adapter ${adapter.id} returned a transition outside its request`)
        }

        return {
          path: entry.path,
          before: snapshotClaim(transition.before),
          after: snapshotClaim(transition.after),
          mtimeMs: transition.mtimeMs,
        }
      }),
    }

    return { status: 'published', receipt }
  }

  /** Raw aggregate commit under the placement lease owned by
   * `packagePublicationFor`. Keeping it private makes the manifest-name check an
   * unavoidable part of every authority package publication. */
  private async commitPackageIfAbsentAdmitted(
    request: ResourcePackagePublicationRequest,
  ): Promise<ResourcePublicationResult> {
    this.assertAdmitted()
    const rootPath = normalizePath(request.rootPath)
    const expectedRoot = snapshotClaim(request.expectedRoot)
    const files = request.files.map((file) => ({
      path: normalizePath(`${rootPath}/${file.path}`),
      relativeToPackage: file.path,
      content: Uint8Array.from(file.content),
    }))
    const routed = [rootPath, ...files.map((file) => file.path)].map((path) => ({
      path,
      ...this.route(path),
    }))
    const adapter = routed[0].adapter

    if (routed.some((entry) => entry.adapter !== adapter)) {
      throw new Error('one package publication cannot cross resource adapters')
    }
    if (!adapter.capabilities.packagePublication) {
      throw Object.assign(new Error(`adapter ${adapter.id} cannot publish packages with proof`), {
        code: 'PACKAGE_PUBLICATION_UNAVAILABLE',
      })
    }
    const result = snapshotPublicationResult(
      await adapter.capabilities.packagePublication.publishPackageIfAbsent(
        packagePublicationSubmission(
          routed[0].relativePath,
          files.map((file) => ({ path: file.relativeToPackage, content: file.content })),
          expectedRoot,
        ),
      ),
    )

    if (result.status === 'conflict') {
      return result
    }
    const expectedTransitions: ProofTransitionExpectation[] = routed.map((entry, index) => ({
      path: entry.relativePath,
      before: index === 0 ? expectedRoot : 'absent',
      afterKind: 'present',
    }))

    if (!hasExactProofTransitionSet(result.transitions, expectedTransitions)) {
      throw new Error(`adapter ${adapter.id} returned an invalid package proof set`)
    }
    const receiptId = `${this.spaceId}:receipt-${nextReceiptId++}`
    const receipt: MutationReceipt = {
      id: receiptId,
      spaceId: this.spaceId,
      adapterId: adapter.id,
      observationId: `${receiptId}:observation`,
      semanticEventTime: new Date().toISOString(),
      restartDurable: false,
      candidateHash: result.candidateHash,
      transitions: result.transitions.map((transition) => {
        const entry = routed.find((candidate) => candidate.relativePath === transition.path)

        if (!entry) {
          throw new Error(`adapter ${adapter.id} returned a transition outside its package`)
        }

        return {
          path: entry.path,
          before: snapshotClaim(transition.before),
          after: snapshotClaim(transition.after),
          mtimeMs: transition.mtimeMs,
        }
      }),
    }

    return { status: 'published', receipt }
  }

  /** The whole package publication for one placement, or `null` where this
   * deployment cannot perform it. Composition asks ONCE, before it mints a
   * space, prepares a root or stages a byte — which is what makes "unavailable
   * here" answerable without a filesystem probe and without a half-written
   * package to explain afterwards.
   *
   * Prerequisites are three independent facts, and a partial set is unavailable:
   * the aggregate commit itself, the strict observation its absent claim comes
   * from, and the base inventory the placement-wide name check walks. */
  packagePublicationFor(placementPath: string, owner: string): PackagePublicationView | null {
    this.assertRootsStable()
    const canonicalPlacement = placementPath ? normalizePath(placementPath) : ''
    const adapter = this.adapters.find((candidate) =>
      containsPrefix(candidate.prefix, canonicalPlacement),
    )

    if (!adapter) {
      throw new Error(`no resource adapter owns placement ${canonicalPlacement}`)
    }
    const adapterPlacement = adapter.prefix
      ? canonicalPlacement.slice(adapter.prefix.length).replace(/^\//, '')
      : canonicalPlacement

    if (!adapter.capabilities.packagePublication || !adapter.capabilities.resourceObservation) {
      return null
    }

    return {
      publishIfAbsent: async (request) => {
        const rootPath = normalizePath(request.rootPath)
        const files = request.files.map((file) => ({
          path: normalizePath(file.path),
          content: Uint8Array.from(file.content),
        }))

        if (new Set(files.map((file) => file.path)).size !== files.length) {
          throw new Error('package publication requires unique resource paths')
        }
        const snapshot = { rootPath, files }
        const manifest = snapshot.files.find((file) => file.path === SKILL_MANIFEST_FILENAME)

        if (!manifest) {
          throw Object.assign(new Error('a skill package must carry a manifest'), {
            code: 'INVALID_SKILL_MANIFEST',
          })
        }
        const manifestPath = `${snapshot.rootPath}/${SKILL_MANIFEST_FILENAME}`
        const routedManifest = this.route(manifestPath)

        if (routedManifest.adapter !== adapter) {
          throw new Error(`package root is outside its publication placement: ${snapshot.rootPath}`)
        }
        if (!isSkillPackageRootPath(routedManifest.relativePath)) {
          throw new Error(`package root is not a canonical package root: ${snapshot.rootPath}`)
        }
        if (skillPlacementPathOf(routedManifest.relativePath) !== adapterPlacement) {
          throw new Error(`package root is outside its publication placement: ${snapshot.rootPath}`)
        }
        const lease = await this.admitSkillPlacement(manifestPath, 'exclusive', owner)

        try {
          const observed = await this.observeStrictAdmitted(snapshot.rootPath)

          if (observed.kind !== 'absent') {
            return { status: 'conflict' }
          }
          await this.assertSkillManifestNameAvailableAdmitted(manifestPath, manifest.content)

          return await this.commitPackageIfAbsentAdmitted({
            rootPath: snapshot.rootPath,
            files: snapshot.files,
            expectedRoot: observed.claim,
          })
        } finally {
          lease.settle()
        }
      },
    }
  }

  supportsRestartDurableStrict(path: string): boolean {
    this.assertRootsStable()
    const { adapter } = this.route(normalizePath(path))

    return adapter.capabilities.strictPublication?.restartDurable === true
  }

  /** Translate a space-relative resource address into the coordinate system of
   * its owning adapter. Domain code reasons about layout using relativePath and
   * reapplies adapterPrefix when it calls this authority again. */
  resourcePathContext(path: string): { adapterPrefix: string; relativePath: string } {
    this.assertRootsStable()
    const { adapter, relativePath } = this.route(normalizePath(path))

    return { adapterPrefix: adapter.prefix, relativePath }
  }

  /** Stage lookup/publication intentionally remain separate. The first call is
   * a short recovery-namespace operation before application admission; publish
   * later owns the resource lease for the complete physical lifetime. */
  async stageStrict(request: ResourceStrictStageRequest): Promise<ResourceStrictStageResult> {
    this.assertRootsStable()
    const snapshot = snapshotStrictStageRequest(request)
    const path = snapshot.path
    const { adapter, relativePath } = this.route(path)
    const strict = adapter.capabilities.strictPublication

    if (!strict?.restartDurable) {
      throw Object.assign(
        new Error(`adapter ${adapter.id} has no restart-durable strict publication`),
        { code: 'STRICT_PUBLICATION_UNAVAILABLE' },
      )
    }
    const candidateHash = await sha256Hex(snapshot.content)
    const result = snapshotStrictStageResult(
      await strict.stage(strictStageSubmission(snapshot, relativePath)),
    )

    if (result.status === 'idempotency-conflict') {
      return result
    }
    const state = this.mapStrictState(path, adapter.id, relativePath, result.state, {
      operationId: snapshot.operationId,
      binding: snapshot.binding,
      expected: snapshot.expected,
      candidateHash,
    })

    if (state.status === 'missing') {
      throw new Error(`adapter ${adapter.id} accepted a missing strict stage`)
    }

    return {
      status: 'accepted',
      created: result.created,
      state,
    }
  }

  async inspectStrict(request: ResourceStrictStageRef): Promise<ResourceStrictStageState> {
    this.assertRootsStable()
    const snapshot = snapshotStrictStageRef(request)
    const path = snapshot.path
    const { adapter, relativePath } = this.route(path)
    const strict = adapter.capabilities.strictPublication

    if (!strict?.restartDurable) {
      throw Object.assign(
        new Error(`adapter ${adapter.id} has no restart-durable strict publication`),
        { code: 'STRICT_PUBLICATION_UNAVAILABLE' },
      )
    }
    const state = snapshotStrictState(await strict.inspect(snapshot.operationId, snapshot.binding))

    return this.mapStrictState(path, adapter.id, relativePath, state, {
      operationId: snapshot.operationId,
      binding: snapshot.binding,
    })
  }

  /** Exact read for a caller that already owns the enclosing exclusive
   * resource/package lease. Strict multi-system commands use this instead of
   * nesting another admission request under their long-lived lease. */
  async observeStrictAdmitted(path: string, maxBytes?: number): Promise<ResourceObservation> {
    this.assertAdmitted()
    const canonicalPath = normalizePath(path)

    if (maxBytes != null && (!Number.isSafeInteger(maxBytes) || maxBytes < 0)) {
      throw new Error('observation maxBytes must be a non-negative safe integer')
    }

    return this.observeAdmitted(canonicalPath, maxBytes)
  }

  /** Compensation-only conditional delete. The publication claim is kept
   * adapter-opaque above this layer; the routed adapter verifies and detaches it
   * while this authority retains the cooperative exclusive lease. */
  async removeClaimed(
    path: string,
    physicalClaim: string,
    expectedContent: string,
  ): Promise<boolean> {
    this.assertRootsStable()
    const canonicalPath = normalizePath(path)
    const { adapter, relativePath } = this.route(canonicalPath)

    if (!adapter.capabilities.claimedRemoval || !physicalClaim.startsWith(`${adapter.id}:`)) {
      return false
    }
    const claimValue = physicalClaim.slice(adapter.id.length + 1)

    if (!claimValue) {
      return false
    }
    const lease = await this.admitResource(
      canonicalPath,
      'exclusive',
      'resource-claim-compensation',
    )

    try {
      return await adapter.capabilities.claimedRemoval.removeIfClaimed(
        relativePath,
        expectedContent,
        {
          kind: 'present',
          value: claimValue,
        },
      )
    } finally {
      lease.settle()
    }
  }

  /** Publish a durable stage while the caller retains the enclosing exclusive
   * admission lease. The public publishStrict wrapper remains the safe default
   * for one-shot callers; restore recovery needs the wider critical section. */
  async publishStrictAdmitted(
    request: ResourceStrictStageRef,
  ): Promise<ResourceStrictPublicationResult> {
    this.assertAdmitted()
    const snapshot = snapshotStrictStageRef(request)
    const path = snapshot.path
    const initial = await this.inspectStrict(snapshot)

    if (initial.status === 'missing') {
      throw Object.assign(new Error('strict stage is missing'), { code: 'STRICT_STAGE_MISSING' })
    }
    const { adapter, relativePath } = this.route(path)
    const result = snapshotStrictPublicationResult(
      await adapter.capabilities.strictPublication!.publish(snapshot.operationId, snapshot.binding),
    )

    return this.mapStrictPublication(path, adapter.id, relativePath, result, initial.stage)
  }

  async publishStrict(
    request: ResourceStrictStageRef,
    options?: {
      owner?: string
      deadlineMs?: number
      signal?: AbortSignal
      recovery?: boolean
    },
  ): Promise<ResourceStrictPublicationResult> {
    const snapshot = snapshotStrictStageRef(request)
    const path = snapshot.path
    const packagePath = snapshot.packagePath
    const owner = options?.owner ?? 'strict-publish'
    const deadlineMs = options?.deadlineMs
    const signal = options?.signal
    const recovery = options?.recovery === true
    const packageLease = packagePath
      ? await this.admitPackage(packagePath, 'shared', owner, {
          ...(deadlineMs != null ? { deadlineMs } : {}),
          ...(signal ? { signal } : {}),
          ...(recovery ? { allowDuringClosure: true } : {}),
        })
      : undefined
    const lease = await this.admitResource(path, 'exclusive', owner, {
      ...(packagePath ? { packagePath } : {}),
      ...(deadlineMs != null ? { deadlineMs } : {}),
      ...(signal ? { signal } : {}),
      ...(recovery ? { allowDuringClosure: true } : {}),
    })

    try {
      return await this.publishStrictAdmitted(snapshot)
    } finally {
      lease.settle()
      packageLease?.settle()
    }
  }

  async discardStrict(request: ResourceStrictStageRef): Promise<boolean> {
    this.assertRootsStable()
    const snapshot = snapshotStrictStageRef(request)
    const path = snapshot.path
    const { adapter } = this.route(path)
    const strict = adapter.capabilities.strictPublication

    if (!strict?.restartDurable) {
      return false
    }

    return strict.discard(snapshot.operationId, snapshot.binding)
  }

  private async observeAdmitted(path: string, maxBytes?: number): Promise<ResourceObservation> {
    const { adapter, relativePath } = this.route(path)

    if (!adapter.capabilities.resourceObservation) {
      throw Object.assign(new Error(`adapter ${adapter.id} cannot make exact observations`), {
        code: 'OBSERVATION_UNAVAILABLE',
      })
    }
    const observation = snapshotObservation(
      await adapter.capabilities.resourceObservation.observe(
        relativePath,
        maxBytes == null ? undefined : { maxBytes },
      ),
    )

    return {
      ...observation,
      spaceId: this.spaceId,
      path,
      adapterId: adapter.id,
      observationId: `${this.spaceId}:observation-${nextObservationId++}`,
    }
  }

  private mapStrictHeader(
    path: string,
    adapterId: string,
    relativePath: string,
    stage: FileStrictStageHeader,
    expected: {
      operationId: string
      binding: string
      expected?: FileClaim
      candidateHash?: string
    },
  ): ResourceStrictStageHeader {
    if (
      stage.operationId !== expected.operationId ||
      stage.binding !== expected.binding ||
      stage.path !== relativePath ||
      (expected.expected != null && !sameFileClaim(stage.expected, expected.expected)) ||
      (expected.candidateHash != null && stage.candidateHash !== expected.candidateHash)
    ) {
      throw new Error(`adapter ${adapterId} returned an invalid strict stage header`)
    }

    return {
      operationId: stage.operationId,
      binding: stage.binding,
      expected: snapshotClaim(stage.expected),
      candidateHash: stage.candidateHash,
      spaceId: this.spaceId,
      adapterId,
      path,
    }
  }

  private mapStrictReceipt(
    path: string,
    adapterId: string,
    relativePath: string,
    receipt: FileStrictMutationReceipt,
    stage: Pick<
      ResourceStrictStageHeader,
      'operationId' | 'binding' | 'candidateHash' | 'expected'
    >,
  ): StrictMutationReceipt {
    if (
      receipt.operationId !== stage.operationId ||
      receipt.binding !== stage.binding ||
      receipt.restartDurable !== true ||
      receipt.candidateHash !== stage.candidateHash ||
      receipt.transitions.length !== 1 ||
      receipt.transitions[0].path !== relativePath ||
      !sameFileClaim(receipt.transitions[0].before, stage.expected) ||
      receipt.transitions[0].after.kind !== 'present'
    ) {
      throw new Error(`adapter ${adapterId} returned an invalid strict publication proof`)
    }

    return {
      operationId: receipt.operationId,
      binding: receipt.binding,
      observationId: receipt.observationId,
      semanticEventTime: receipt.semanticEventTime,
      restartDurable: true,
      candidateHash: receipt.candidateHash,
      spaceId: this.spaceId,
      adapterId,
      transitions: [
        {
          path,
          before: snapshotClaim(receipt.transitions[0].before),
          after: snapshotClaim(receipt.transitions[0].after),
          mtimeMs: receipt.transitions[0].mtimeMs,
        },
      ],
    }
  }

  private mapStrictState(
    path: string,
    adapterId: string,
    relativePath: string,
    state: FileStrictStageState,
    expected: {
      operationId: string
      binding: string
      expected?: FileClaim
      candidateHash?: string
    },
  ): ResourceStrictStageState {
    if (state.status === 'missing') {
      return { status: 'missing' }
    }
    const stage = this.mapStrictHeader(path, adapterId, relativePath, state.stage, expected)

    if (state.status === 'published') {
      return {
        status: 'published',
        stage,
        receipt: this.mapStrictReceipt(path, adapterId, relativePath, state.receipt, stage),
      }
    }
    if (state.status === 'failed-recoverable') {
      return {
        status: 'failed-recoverable',
        stage,
        reason: state.reason,
        recoveryPaths: [...state.recoveryPaths],
      }
    }

    return { status: state.status, stage }
  }

  private mapStrictPublication(
    path: string,
    adapterId: string,
    relativePath: string,
    result: FileStrictPublicationResult,
    stage: ResourceStrictStageHeader,
  ): ResourceStrictPublicationResult {
    if (result.status === 'published') {
      return {
        status: 'published',
        receipt: this.mapStrictReceipt(path, adapterId, relativePath, result.receipt, stage),
      }
    }

    const mappedStage = this.mapStrictHeader(path, adapterId, relativePath, result.stage, {
      operationId: stage.operationId,
      binding: stage.binding,
      expected: stage.expected,
      candidateHash: stage.candidateHash,
    })

    return result.status === 'conflict'
      ? { status: 'conflict', stage: mappedStage }
      : {
          status: 'failed-recoverable',
          stage: mappedStage,
          reason: result.reason,
          recoveryPaths: [...result.recoveryPaths],
        }
  }

  private route(path: string): RoutedResource {
    const adapter = this.adapters.find((candidate) => containsPrefix(candidate.prefix, path))

    if (!adapter) {
      throw new Error(`no resource adapter owns ${path}`)
    }
    const relativePath = adapter.prefix ? path.slice(adapter.prefix.length + 1) : path

    if (!relativePath) {
      throw new Error(`resource path resolves to adapter root: ${path}`)
    }

    return { adapter, relativePath }
  }

  /** The lifecycle question, and the ONE place any entry point asks it: admission.
   *  Every public entry either passes through here to get its lease, or is an
   *  `*Admitted` entry whose caller already did — so the answer is given once per
   *  critical section instead of once per method, and a save no longer pays a third
   *  synchronous `lstat`+`realpath` of every mount root on the way out. */
  private assertAdmissible(allowDuringClosure?: boolean): void {
    if (!this.accepting && allowDuringClosure !== true) {
      throw Object.assign(new Error('space resource admission is closed'), {
        code: 'SPACE_LIFECYCLE_CLOSED',
      })
    }
    this.assertRootsStable()
  }

  /** What an `*Admitted` entry asks instead — and why it must NOT re-ask the one
   *  above. `closeAdmission` drops `accepting` synchronously and only THEN drains, so
   *  work admitted before the fence is still entitled to finish; a second lifecycle
   *  check on the way out breaks exactly the promise the fence makes, and refuses the
   *  recovery path, which holds its lease with `allowDuringClosure`. So the question
   *  here is the other half: was this call admitted at all? A call made while this
   *  authority holds no application lease provably did not come through admission, so
   *  it answers the admission gate after the fact and fails closed.
   *
   *  A backstop, not a proof: while some UNRELATED lease is live an unadmitted caller
   *  still slips past. Proving it per call needs the lease itself as an argument,
   *  which is a change to every caller of an `*Admitted` entry. What IS structural
   *  here is that no entry can skip the question — the classification test in
   *  `spaceResourceAuthority.test.ts` fails by name on a method it has never heard
   *  of, so a new entry cannot be added without answering. */
  private assertAdmitted(): void {
    if (this.admission.activeLeases() === 0) {
      this.assertAdmissible()
    }
  }

  private assertRootsStable(): void {
    for (const root of this.roots) {
      assertCanonicalResourceRoot(root)
    }
  }
}
