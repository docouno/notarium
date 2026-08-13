import { basenameOf, directoryOf } from '@notarium/core'

import type {
  FileStrictMutationReceipt,
  FileStrictPublicationResult,
  FileStrictStageHeader,
  FileStrictStageState,
} from '../files'
import { ResourceAdmission } from './admission'
import { assertCanonicalResourceRoot, preflightResourceRoots } from './roots'
import {
  type AdmissionDiagnostic,
  type AdmissionLease,
  type AdmissionMode,
  type CanonicalResourceRoot,
  type MutationReceipt,
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

const containsPrefix = (prefix: string, path: string): boolean =>
  !prefix || path === prefix || path.startsWith(`${prefix}/`)

export class SpaceResourceAuthority {
  readonly spaceId: string
  private readonly adapters: ResourceAuthorityAdapter[]
  private readonly admission = new ResourceAdmission()
  private readonly roots: CanonicalResourceRoot[]
  private accepting = true
  private closePromise: Promise<void> | null = null

  constructor(spaceId: string, adapters: readonly ResourceAuthorityAdapter[]) {
    if (!spaceId.trim()) {
      throw new Error('resource authority requires a space id')
    }
    if (!adapters.length) {
      throw new Error('resource authority requires at least one adapter')
    }
    if (new Set(adapters.map((adapter) => adapter.id)).size !== adapters.length) {
      throw new Error('resource authority adapter ids must be unique')
    }
    if (new Set(adapters.map((adapter) => adapter.prefix)).size !== adapters.length) {
      throw new Error('resource authority adapter prefixes must be unique')
    }
    this.spaceId = spaceId
    this.adapters = [...adapters].sort((left, right) => right.prefix.length - left.prefix.length)
    this.roots = preflightResourceRoots(
      adapters.flatMap((adapter) =>
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

  admitResource(
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
    if (!this.accepting && options?.allowDuringClosure !== true) {
      return Promise.reject(
        Object.assign(new Error('space resource admission is closed'), {
          code: 'SPACE_LIFECYCLE_CLOSED',
        }),
      )
    }
    this.assertRootsStable()
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

  admitPackage(
    packagePath: string,
    mode: AdmissionMode,
    owner: string,
    options?: { deadlineMs?: number; signal?: AbortSignal; allowDuringClosure?: boolean },
  ): Promise<AdmissionLease> {
    if (!this.accepting && options?.allowDuringClosure !== true) {
      return Promise.reject(
        Object.assign(new Error('space resource admission is closed'), {
          code: 'SPACE_LIFECYCLE_CLOSED',
        }),
      )
    }
    this.assertRootsStable()
    return this.admission.admit({
      scope: 'package',
      mode,
      owner,
      path: normalizePath(packagePath),
      ...(options?.deadlineMs != null ? { deadlineMs: options.deadlineMs } : {}),
      ...(options?.signal ? { signal: options.signal } : {}),
    })
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
    },
  ): Promise<ResourceObservation> {
    const canonicalPath = normalizePath(path)

    if (
      options?.maxBytes != null &&
      (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0)
    ) {
      throw new Error('observation maxBytes must be a non-negative safe integer')
    }
    const lease = await this.admitResource(canonicalPath, 'shared', options?.owner ?? 'observe', {
      ...(options?.packagePath ? { packagePath: options.packagePath } : {}),
      ...(options?.deadlineMs != null ? { deadlineMs: options.deadlineMs } : {}),
      ...(options?.signal ? { signal: options.signal } : {}),
    })

    try {
      return await this.observeAdmitted(canonicalPath, options?.maxBytes)
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
    if (!adapter.files.exportFiles) {
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
      for await (const entry of adapter.files.exportFiles()) {
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
    const paths =
      request.kind === 'put'
        ? [normalizePath(request.path)]
        : [normalizePath(request.sourcePath), normalizePath(request.targetPath)]
    const routed = paths.map((path) => ({ path, ...this.route(path) }))
    const adapter = routed[0].adapter

    if (routed.some((entry) => entry.adapter !== adapter)) {
      throw new Error('one publication cannot cross resource adapters')
    }
    if (!adapter.files.publish) {
      throw Object.assign(new Error(`adapter ${adapter.id} cannot publish with proof`), {
        code: 'PUBLICATION_UNAVAILABLE',
      })
    }
    const packagePath = request.packagePath ? normalizePath(request.packagePath) : undefined
    // Capture the submitted candidate before the first suspension. The caller
    // retains its buffer and may mutate it while admission is queued.
    const content = Uint8Array.from(request.content)
    const packageLease = packagePath
      ? await this.admitPackage(packagePath, 'shared', options?.owner ?? 'publish', options)
      : undefined
    const resourceLeases: AdmissionLease[] = []

    try {
      for (const path of [...new Set(paths)].sort()) {
        resourceLeases.push(
          await this.admitResource(path, 'exclusive', options?.owner ?? 'publish', {
            ...(packagePath ? { packagePath } : {}),
            ...(options?.deadlineMs != null ? { deadlineMs: options.deadlineMs } : {}),
            ...(options?.signal ? { signal: options.signal } : {}),
          }),
        )
      }
      const result = await adapter.files.publish(
        request.kind === 'put'
          ? {
              kind: 'put',
              path: routed[0].relativePath,
              content,
              expected: request.expected,
            }
          : {
              kind: 'move-put',
              sourcePath: routed[0].relativePath,
              targetPath: routed[1].relativePath,
              content,
              expectedSource: request.expectedSource,
              expectedTarget: request.expectedTarget,
            },
      )

      if (result.status === 'conflict') {
        return result
      }
      const expectedRelativePaths = new Set(routed.map((entry) => entry.relativePath))
      const expectedBefore = new Map(
        request.kind === 'put'
          ? [[routed[0].relativePath, request.expected] as const]
          : [
              [routed[0].relativePath, request.expectedSource] as const,
              [routed[1].relativePath, request.expectedTarget] as const,
            ],
      )

      if (
        result.transitions.length !== expectedRelativePaths.size ||
        result.transitions.some((transition) => {
          const before = expectedBefore.get(transition.path)
          const afterKind =
            request.kind === 'move-put' && transition.path === routed[0].relativePath
              ? 'absent'
              : 'present'

          return (
            !expectedRelativePaths.has(transition.path) ||
            before == null ||
            !sameFileClaim(before, transition.before) ||
            transition.after.kind !== afterKind
          )
        })
      ) {
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
        candidateHash: result.candidateHash,
        transitions: result.transitions.map((transition) => {
          const entry = routed.find((candidate) => candidate.relativePath === transition.path)

          if (!entry) {
            throw new Error(`adapter ${adapter.id} returned a transition outside its request`)
          }

          return { ...transition, path: entry.path }
        }),
      }

      return { status: 'published', receipt }
    } finally {
      for (const lease of resourceLeases.reverse()) {
        lease.settle()
      }
      packageLease?.settle()
    }
  }

  async publishPackageIfAbsent(
    request: ResourcePackagePublicationRequest,
    options?: { owner?: string; deadlineMs?: number; signal?: AbortSignal },
  ): Promise<ResourcePublicationResult> {
    const rootPath = normalizePath(request.rootPath)
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
    if (!adapter.files.publishPackageIfAbsent) {
      throw Object.assign(new Error(`adapter ${adapter.id} cannot publish packages with proof`), {
        code: 'PACKAGE_PUBLICATION_UNAVAILABLE',
      })
    }
    const lease = await this.admitPackage(
      rootPath,
      'exclusive',
      options?.owner ?? 'publish-package',
      options,
    )

    try {
      const result = await adapter.files.publishPackageIfAbsent({
        rootPath: routed[0].relativePath,
        files: files.map((file) => ({ path: file.relativeToPackage, content: file.content })),
        expectedRoot: request.expectedRoot,
      })

      if (result.status === 'conflict') {
        return result
      }
      const expectedPaths = new Set(routed.map((entry) => entry.relativePath))

      if (
        result.transitions.length !== expectedPaths.size ||
        result.transitions.some((transition) => {
          const isRoot = transition.path === routed[0].relativePath

          return (
            !expectedPaths.has(transition.path) ||
            transition.after.kind !== 'present' ||
            (isRoot
              ? !sameFileClaim(transition.before, request.expectedRoot)
              : transition.before.kind !== 'absent')
          )
        })
      ) {
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

          return { ...transition, path: entry.path }
        }),
      }

      return { status: 'published', receipt }
    } finally {
      lease.settle()
    }
  }

  supportsRestartDurableStrict(path: string): boolean {
    this.assertRootsStable()
    const { adapter } = this.route(normalizePath(path))

    return adapter.files.strictPublication?.restartDurable === true
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
    const path = normalizePath(request.path)
    const { adapter, relativePath } = this.route(path)
    const strict = adapter.files.strictPublication

    if (!strict?.restartDurable) {
      throw Object.assign(
        new Error(`adapter ${adapter.id} has no restart-durable strict publication`),
        { code: 'STRICT_PUBLICATION_UNAVAILABLE' },
      )
    }
    const content = Uint8Array.from(request.content)
    const result = await strict.stage({
      operationId: request.operationId,
      binding: request.binding,
      path: relativePath,
      content,
      expected: request.expected,
    })

    if (result.status === 'idempotency-conflict') {
      return result
    }
    const state = this.mapStrictState(path, adapter.id, relativePath, result.state)

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
    const path = normalizePath(request.path)
    const { adapter, relativePath } = this.route(path)
    const strict = adapter.files.strictPublication

    if (!strict?.restartDurable) {
      throw Object.assign(
        new Error(`adapter ${adapter.id} has no restart-durable strict publication`),
        { code: 'STRICT_PUBLICATION_UNAVAILABLE' },
      )
    }
    const state = await strict.inspect(request.operationId, request.binding)

    return this.mapStrictState(path, adapter.id, relativePath, state)
  }

  /** Exact read for a caller that already owns the enclosing exclusive
   * resource/package lease. Strict multi-system commands use this instead of
   * nesting another admission request under their long-lived lease. */
  async observeStrictAdmitted(path: string, maxBytes?: number): Promise<ResourceObservation> {
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

    if (!adapter.files.removeIfClaimed || !physicalClaim.startsWith(`${adapter.id}:`)) {
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
      return adapter.files.removeIfClaimed(relativePath, expectedContent, {
        kind: 'present',
        value: claimValue,
      })
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
    const path = normalizePath(request.path)
    const initial = await this.inspectStrict(request)

    if (initial.status === 'missing') {
      throw Object.assign(new Error('strict stage is missing'), { code: 'STRICT_STAGE_MISSING' })
    }
    const { adapter, relativePath } = this.route(path)
    const result = await adapter.files.strictPublication!.publish(
      request.operationId,
      request.binding,
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
    const path = normalizePath(request.path)
    const packagePath = request.packagePath ? normalizePath(request.packagePath) : undefined
    const packageLease = packagePath
      ? await this.admitPackage(packagePath, 'shared', options?.owner ?? 'strict-publish', {
          ...options,
          allowDuringClosure: options?.recovery,
        })
      : undefined
    const lease = await this.admitResource(path, 'exclusive', options?.owner ?? 'strict-publish', {
      ...(packagePath ? { packagePath } : {}),
      ...(options?.deadlineMs != null ? { deadlineMs: options.deadlineMs } : {}),
      ...(options?.signal ? { signal: options.signal } : {}),
      ...(options?.recovery ? { allowDuringClosure: true } : {}),
    })

    try {
      return await this.publishStrictAdmitted(request)
    } finally {
      lease.settle()
      packageLease?.settle()
    }
  }

  async discardStrict(request: ResourceStrictStageRef): Promise<boolean> {
    this.assertRootsStable()
    const path = normalizePath(request.path)
    const { adapter } = this.route(path)
    const strict = adapter.files.strictPublication

    if (!strict?.restartDurable) {
      return false
    }

    return strict.discard(request.operationId, request.binding)
  }

  private async observeAdmitted(path: string, maxBytes?: number): Promise<ResourceObservation> {
    const { adapter, relativePath } = this.route(path)

    if (!adapter.files.observe) {
      throw Object.assign(new Error(`adapter ${adapter.id} cannot make exact observations`), {
        code: 'OBSERVATION_UNAVAILABLE',
      })
    }
    const observation = await adapter.files.observe(
      relativePath,
      maxBytes == null ? undefined : { maxBytes },
    )
    const immutable =
      observation.kind === 'present'
        ? { ...observation, bytes: Uint8Array.from(observation.bytes) }
        : observation

    return {
      ...immutable,
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
  ): ResourceStrictStageHeader {
    if (stage.path !== relativePath) {
      throw new Error(`adapter ${adapterId} returned a strict stage for another resource`)
    }

    return { ...stage, spaceId: this.spaceId, adapterId, path }
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
      receipt.candidateHash !== stage.candidateHash ||
      receipt.transitions.length !== 1 ||
      receipt.transitions[0].path !== relativePath ||
      !sameFileClaim(receipt.transitions[0].before, stage.expected) ||
      receipt.transitions[0].after.kind !== 'present'
    ) {
      throw new Error(`adapter ${adapterId} returned an invalid strict publication proof`)
    }

    return {
      ...receipt,
      spaceId: this.spaceId,
      adapterId,
      transitions: [{ ...receipt.transitions[0], path }],
    }
  }

  private mapStrictState(
    path: string,
    adapterId: string,
    relativePath: string,
    state: FileStrictStageState,
  ): ResourceStrictStageState {
    if (state.status === 'missing') {
      return state
    }
    const stage = this.mapStrictHeader(path, adapterId, relativePath, state.stage)

    if (state.status === 'published') {
      return {
        status: 'published',
        stage,
        receipt: this.mapStrictReceipt(path, adapterId, relativePath, state.receipt, stage),
      }
    }
    if (state.status === 'failed-recoverable') {
      return { ...state, stage }
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

    return {
      ...result,
      stage: this.mapStrictHeader(path, adapterId, relativePath, result.stage),
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

  private assertRootsStable(): void {
    for (const root of this.roots) {
      assertCanonicalResourceRoot(root)
    }
  }
}
