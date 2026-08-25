import { randomUUID } from 'node:crypto'

import {
  analyzeDocumentState,
  basenameOf,
  bindStorageOwnerProof,
  canonicalLegacyNameAliases,
  decodeDocumentState,
  diffStats,
  DOCUMENT_ROLE,
  DOCUMENT_STATE_FORMAT,
  documentRestoreCompatibility,
  type DocumentRole,
  documentSourceText,
  type DocumentState,
  documentStateVersionToken,
  encodeDocumentState,
  exactOwnerObservation,
  type IdentityRecord,
  isSkillPackageRootPath,
  legacyNoteNameAlias,
  LOGICAL_NOTE_STATE_FORMAT,
  logicalNoteStateFromProjection,
  normTags,
  planDocumentMutation,
  RESTORE_OPERATION_PHASE,
  type RestoreOperationRecord,
  type RestoreTerminalResult,
  REVISION_KIND,
  sha256Hex,
  skillPackagePathOf,
  SPACE_LIFECYCLE_PHASE,
  STORAGE_OWNER_KEY,
  type StorageOwnerProof,
  STORE_ERROR_REASON,
  unionLegacyNameAliases,
} from '@notarium/core'
import {
  type FileClaim,
  type ResourceStrictStageRef,
  sameFileClaim,
  type SpaceResourceAuthority,
  type StrictMutationReceipt,
} from '@notarium/engine'

import { can, type Principal } from '../authz'
import type { InstallationReplayKey } from '../installationReplayKey'
import type { MetaDb } from '../metaDb'
import type { SpaceManager } from '../spaces'

const ENDPOINT = {
  history: 'note-history-restore',
  trash: 'trash-restore',
} as const

const CORRUPT_EVIDENCE_CODE = 'RESTORE_EVIDENCE_CORRUPT'

type RestoreMode = keyof typeof ENDPOINT

export type RestoreCommand =
  | {
      mode: 'history'
      principal: Principal
      noteId: string
      revisionId: string
      versionToken: string
      idempotencyKey: string
    }
  | {
      mode: 'trash'
      principal: Principal
      space: string
      noteId: string
      revisionId: string
      idempotencyKey: string
    }

export type RestoreCommandResult =
  | ({ status: 'succeeded'; operationId: string } & RestoreTerminalResult)
  | {
      status: 'pending'
      operationId: string
      phase: 'staged' | 'prepared' | 'physical-published' | 'failed-recoverable'
    }
  | { status: 'conflict'; operationId: string; reason: string }
  | { status: 'not-restorable'; operationId: string; reason: string }
  | { status: 'busy'; reason: string }
  | { status: 'not-found' }

type AcceptedEvidence = {
  version: 1
  kind: 'accepted'
  mode: RestoreMode
  principalId: string
  noteId: string
  revisionId: string
  versionToken: string | null
  requestedSpace: string | null
}

type PreparedEvidence = {
  version: 1 | 2
  kind: 'prepared'
  mode: RestoreMode
  principalId: string
  noteId: string
  sourceRevisionId: string
  expectedHeadRevisionId: string
  targetPath: string
  class: string | null
  role: DocumentRole
  skillDirectoryName: string | null
  pathFallbackTitle: string | null
  candidateSource: string
  candidateVersionToken: string
  ownerClaims: Array<{
    key: (typeof STORAGE_OWNER_KEY)[keyof typeof STORAGE_OWNER_KEY]
    ownership: 'value' | 'entry'
  }>
  generatedContainer: boolean
  expectedClaim: FileClaim
  expectedIdentity: {
    addressRevision: number
    filePath: string
    deletedAt: string | null
  }
  identity: IdentityRecord
  /** Complete monotonic compatibility state captured before physical publish.
   * Version-1 evidence predates this field and parses as an empty array. */
  legacyNameAliases: readonly string[]
  expectedProofRevision: number | null
  charsAdded: number | null
  charsRemoved: number | null
}

type RestoreCoordinatorOptions = {
  metaDb: MetaDb
  replayKey: InstallationReplayKey
  spaces: SpaceManager
  authorityForSpace(space: string): Promise<SpaceResourceAuthority | null>
  wakeOutbox?: () => void
  now?: () => Date
  operationId?: () => string
  onError?: (error: unknown, operation?: RestoreOperationRecord) => void
}

type RestoreExecutionOptions = {
  acceptedByParentOperationId?: string
}

const encodeJson = (value: unknown): string => JSON.stringify(value)

const corruptEvidence = (message: string, cause?: unknown): Error =>
  Object.assign(new Error(message, { cause }), { code: CORRUPT_EVIDENCE_CODE })

const isCorruptEvidence = (error: unknown): boolean =>
  error instanceof Error && (error as Error & { code?: string }).code === CORRUPT_EVIDENCE_CODE

const parseEvidenceJson = <T>(raw: string | null, label: string): Partial<T> | null => {
  if (!raw) {
    return null
  }

  try {
    return JSON.parse(raw) as Partial<T>
  } catch (error) {
    throw corruptEvidence(`restore operation has malformed ${label}`, error)
  }
}

const parseAcceptedEvidence = (raw: string | null): AcceptedEvidence => {
  const value = parseEvidenceJson<AcceptedEvidence>(raw, 'accepted evidence')

  if (
    !value ||
    value.version !== 1 ||
    value.kind !== 'accepted' ||
    (value.mode !== 'history' && value.mode !== 'trash') ||
    typeof value.principalId !== 'string' ||
    typeof value.noteId !== 'string' ||
    typeof value.revisionId !== 'string' ||
    (value.versionToken !== null && typeof value.versionToken !== 'string') ||
    (value.requestedSpace !== null && typeof value.requestedSpace !== 'string')
  ) {
    throw corruptEvidence('restore operation has invalid accepted evidence')
  }

  return value as AcceptedEvidence
}

const parsePreparedEvidence = (raw: string | null): PreparedEvidence => {
  const value = parseEvidenceJson<PreparedEvidence>(raw, 'prepared evidence')

  if (
    !value ||
    (value.version !== 1 && value.version !== 2) ||
    value.kind !== 'prepared' ||
    typeof value.noteId !== 'string' ||
    typeof value.sourceRevisionId !== 'string' ||
    typeof value.expectedHeadRevisionId !== 'string' ||
    typeof value.targetPath !== 'string' ||
    typeof value.candidateSource !== 'string' ||
    typeof value.candidateVersionToken !== 'string' ||
    !value.expectedClaim ||
    !value.expectedIdentity ||
    !value.identity ||
    !Array.isArray(value.ownerClaims) ||
    (value.version === 2 && !Array.isArray(value.legacyNameAliases))
  ) {
    throw corruptEvidence('restore operation has invalid prepared evidence')
  }

  const identity = value.identity as IdentityRecord
  const legacyNameAliases = canonicalLegacyNameAliases(
    value.version === 2 ? value.legacyNameAliases : identity.legacyNameAliases,
  )

  return {
    ...(value as PreparedEvidence),
    identity: { ...identity, legacyNameAliases },
    legacyNameAliases,
  }
}

const terminalResultOf = (operation: RestoreOperationRecord): RestoreTerminalResult => {
  const value = parseEvidenceJson<RestoreTerminalResult>(
    operation.terminalResult,
    'terminal result',
  )

  if (
    !value ||
    typeof value.noteId !== 'string' ||
    typeof value.filePath !== 'string' ||
    typeof value.revisionId !== 'string' ||
    typeof value.versionToken !== 'string'
  ) {
    throw corruptEvidence(`restore operation ${operation.id} has invalid terminal result`)
  }

  return value as RestoreTerminalResult
}

const pendingPhaseOf = (
  operation: RestoreOperationRecord,
): Extract<RestoreCommandResult, { status: 'pending' }>['phase'] => {
  if (operation.phase === RESTORE_OPERATION_PHASE.succeeded) {
    return 'physical-published'
  }
  if (operation.phase === RESTORE_OPERATION_PHASE.metadataCommitted) {
    return 'physical-published'
  }
  if (operation.phase === RESTORE_OPERATION_PHASE.rejected) {
    return 'staged'
  }

  return operation.phase
}

const rejectionOf = (
  operation: RestoreOperationRecord,
): Extract<RestoreCommandResult, { status: 'conflict' | 'not-restorable' }> => {
  const code = operation.failureCode ?? 'conflict:restore-rejected'
  const separator = code.indexOf(':')
  const kind = separator < 0 ? 'conflict' : code.slice(0, separator)
  const reason = separator < 0 ? code : code.slice(separator + 1)

  return kind === 'not-restorable'
    ? { status: 'not-restorable', operationId: operation.id, reason }
    : { status: 'conflict', operationId: operation.id, reason }
}

const canonicalRequest = (input: RestoreCommand): string =>
  encodeJson(
    input.mode === 'history'
      ? {
          mode: input.mode,
          noteId: input.noteId,
          revisionId: input.revisionId,
          versionToken: input.versionToken,
        }
      : {
          mode: input.mode,
          space: input.space,
          noteId: input.noteId,
          revisionId: input.revisionId,
        },
  )

const bytesOf = (blob: string | Uint8Array): Uint8Array =>
  typeof blob === 'string' ? new TextEncoder().encode(blob) : Uint8Array.from(blob)

const fallbackTitleOf = (path: string): string => basenameOf(path).replace(/\.md$/i, '')

const proofOf = async (
  metaDb: MetaDb,
  identity: IdentityRecord,
  source: Uint8Array,
  fallback?: DocumentState | null,
): Promise<{ proof?: StorageOwnerProof; revision: number | null }> => {
  const binding = await metaDb.ownerProofs.get(identity.id)

  if (!binding) {
    return {
      proof:
        fallback &&
        fallback.source.byteLength === source.byteLength &&
        fallback.source.every((value, index) => value === source[index])
          ? fallback.provenance
          : undefined,
      revision: null,
    }
  }
  const sourceHash = await sha256Hex(source)

  if (
    binding.space !== identity.space ||
    binding.addressRevision !== (identity.addressRevision ?? 0) ||
    binding.sourceHash !== sourceHash
  ) {
    return {
      proof:
        fallback &&
        fallback.source.byteLength === source.byteLength &&
        fallback.source.every((value, index) => value === source[index])
          ? fallback.provenance
          : undefined,
      revision: binding.proofRevision,
    }
  }

  return {
    proof: JSON.parse(binding.proofJson) as StorageOwnerProof,
    revision: binding.proofRevision,
  }
}

type SkillPackageContext = {
  packagePath: string
  relativePath: string
}

const skillPackageContextOf = (
  authority: SpaceResourceAuthority,
  className: string | null,
  path: string,
): SkillPackageContext | null => {
  if (className !== 'skill') {
    return null
  }
  const { adapterPrefix, relativePath } = authority.resourcePathContext(path)
  const relativePackagePath = skillPackagePathOf(relativePath)

  if (!relativePackagePath) {
    return null
  }

  return {
    packagePath: adapterPrefix ? `${adapterPrefix}/${relativePackagePath}` : relativePackagePath,
    relativePath,
  }
}

const projectionFields = (
  state: DocumentState,
): { title: string; tags: string[]; slug: string | null } => {
  const projection = state.projection

  if (!projection) {
    throw new Error('restored document has no projection')
  }
  const slug = projection.frontmatter.slug

  return {
    title: projection.title,
    tags: normTags(projection.frontmatter.tags) ?? [],
    slug: typeof slug === 'string' && slug ? slug : null,
  }
}

export class RestoreCoordinator {
  private readonly metaDb: MetaDb
  private readonly replayKey: InstallationReplayKey
  private readonly spaces: SpaceManager
  private readonly authorityForSpace: RestoreCoordinatorOptions['authorityForSpace']
  private readonly wakeOutbox: () => void
  private readonly now: () => Date
  private readonly operationId: () => string
  private readonly onError: NonNullable<RestoreCoordinatorOptions['onError']>
  private readonly projectionReleases = new Map<string, () => void>()
  private readonly recoveryAuthorities = new Set<SpaceResourceAuthority>()

  constructor(options: RestoreCoordinatorOptions) {
    this.metaDb = options.metaDb
    this.replayKey = options.replayKey
    this.spaces = options.spaces
    this.authorityForSpace = options.authorityForSpace
    this.wakeOutbox = options.wakeOutbox ?? (() => {})
    this.now = options.now ?? (() => new Date())
    this.operationId = options.operationId ?? randomUUID
    this.onError =
      options.onError ??
      ((error, operation) =>
        console.error(
          `[restore]${operation ? ` ${operation.id}/${operation.phase}` : ''} ->`,
          (error as Error).message,
        ))
  }

  private async enterProjection(operation: RestoreOperationRecord): Promise<void> {
    if (this.projectionReleases.has(operation.id)) {
      return
    }
    this.projectionReleases.set(
      operation.id,
      await this.spaces.beginCausalPublication(operation.space, {
        kind: 'restore',
        operationId: operation.id,
      }),
    )
  }

  private releaseProjection(operationId: string): void {
    const release = this.projectionReleases.get(operationId)

    if (!release) {
      return
    }
    this.projectionReleases.delete(operationId)
    release()
  }

  private closeForRecovery(authority: SpaceResourceAuthority): void {
    this.recoveryAuthorities.add(authority)
    void authority
      .closeAdmission({ owner: 'restore-recovery' })
      .catch((error) => this.onError(error))
  }

  private async reopenAfterCommit(space: string, authority: SpaceResourceAuthority): Promise<void> {
    if (!this.recoveryAuthorities.delete(authority)) {
      return
    }
    await authority.closeAdmission({ owner: 'restore-recovery' })
    const lifecycle = await this.metaDb.spaceLifecycle.get(space)

    if (lifecycle?.phase === SPACE_LIFECYCLE_PHASE.active && !authority.diagnostics().length) {
      authority.reopenAdmission()
    }
  }

  async execute(
    input: RestoreCommand,
    options: RestoreExecutionOptions = {},
  ): Promise<RestoreCommandResult> {
    const endpoint = ENDPOINT[input.mode]
    const canonical = canonicalRequest(input)
    const candidates = await this.replayKey.digestCandidateBundles([
      { domain: 'restore-actor', value: input.principal.id },
      { domain: `restore-idempotency:${endpoint}`, value: input.idempotencyKey },
      { domain: `restore-request:${endpoint}`, value: canonical },
    ])

    for (const [actorDigest, idempotencyDigest, requestFingerprint] of candidates) {
      const existing = await this.metaDb.restoreOperations.getByReplay(
        actorDigest,
        endpoint,
        idempotencyDigest,
      )

      if (!existing) {
        continue
      }
      if (
        !can(input.principal, input.mode === 'history' ? 'note:write' : 'space:write', {
          space: existing.space,
        })
      ) {
        return { status: 'not-found' }
      }
      if (existing.requestFingerprint !== requestFingerprint) {
        return { status: 'conflict', operationId: existing.id, reason: 'idempotency-conflict' }
      }

      return this.resumeSafely(existing)
    }

    const identity = await this.metaDb.identity.findById?.(input.noteId)

    if (
      !identity ||
      (input.mode === 'history' && identity.deletedAt != null) ||
      (input.mode === 'trash' && (identity.deletedAt == null || identity.space !== input.space)) ||
      !can(input.principal, input.mode === 'history' ? 'note:write' : 'space:write', {
        space: identity.space,
      })
    ) {
      return { status: 'not-found' }
    }
    const lifecycle = await this.metaDb.spaceLifecycle.get(identity.space)

    if (lifecycle?.phase !== SPACE_LIFECYCLE_PHASE.active && !options.acceptedByParentOperationId) {
      return { status: 'busy', reason: 'space-not-active' }
    }
    const authority = await this.authorityForSpace(identity.space)

    if (!authority || !authority.supportsRestartDurableStrict(identity.filePath)) {
      return { status: 'busy', reason: 'strict-publication-unavailable' }
    }
    const id = this.operationId()
    const [actorDigest, idempotencyDigest, requestFingerprint, stageBinding] =
      await this.replayKey.digestBundle([
        { domain: 'restore-actor', value: input.principal.id },
        { domain: `restore-idempotency:${endpoint}`, value: input.idempotencyKey },
        { domain: `restore-request:${endpoint}`, value: canonical },
        { domain: 'restore-stage', value: `${id}\0${canonical}` },
      ])
    const acceptedEvidence: AcceptedEvidence = {
      version: 1,
      kind: 'accepted',
      mode: input.mode,
      principalId: input.principal.id,
      noteId: input.noteId,
      revisionId: input.revisionId,
      versionToken: input.mode === 'history' ? input.versionToken : null,
      requestedSpace: input.mode === 'trash' ? input.space : null,
    }
    let accepted

    try {
      accepted = await this.metaDb.restoreOperations.accept({
        id,
        space: identity.space,
        noteId: input.noteId,
        endpoint,
        actorDigest,
        idempotencyDigest,
        requestFingerprint,
        stageBinding,
        sourceRevisionId: input.revisionId,
        targetPath: identity.filePath,
        preparedEvidence: encodeJson(acceptedEvidence),
        parentOperationId: options.acceptedByParentOperationId,
        protectedNoteIds: [input.noteId],
        createdAt: this.now().toISOString(),
      })
    } catch (error) {
      this.onError(error)
      return { status: 'busy', reason: 'restore-admission-unavailable' }
    }

    if (accepted.status === 'idempotency-conflict') {
      return {
        status: 'conflict',
        operationId: accepted.operation.id,
        reason: 'idempotency-conflict',
      }
    }

    return this.resumeSafely(accepted.operation)
  }

  /** Resolve every durable operation once before public admission. Operations
   * that need an operator remain explicitly failed-recoverable; corrupt durable
   * evidence fails boot instead of admitting a second command over ambiguity. */
  async recover(): Promise<void> {
    for (const operation of await this.metaDb.restoreOperations.listRecoverable()) {
      if (operation.endpoint !== ENDPOINT.history && operation.endpoint !== ENDPOINT.trash) {
        continue
      }
      await this.resumeSafely(operation, true)
    }
  }

  private async resumeSafely(
    operation: RestoreOperationRecord,
    failOnCorruptEvidence = false,
  ): Promise<RestoreCommandResult> {
    try {
      const result = await this.resume(operation)

      if (result.status !== 'pending') {
        await this.spaces.resumeLifecycle(operation.space)
      }

      return result
    } catch (error) {
      if (failOnCorruptEvidence && isCorruptEvidence(error)) {
        throw error
      }
      this.onError(error, operation)
      const current = (await this.metaDb.restoreOperations.get(operation.id)) ?? operation

      if (current.phase === RESTORE_OPERATION_PHASE.rejected) {
        return rejectionOf(current)
      }
      if (current.phase === RESTORE_OPERATION_PHASE.metadataCommitted) {
        try {
          return await this.resume(current)
        } catch (recoveryError) {
          if (failOnCorruptEvidence && isCorruptEvidence(recoveryError)) {
            throw recoveryError
          }
          this.onError(recoveryError, current)
          return { status: 'pending', operationId: current.id, phase: 'physical-published' }
        }
      }
      if (current.phase === RESTORE_OPERATION_PHASE.succeeded) {
        try {
          return await this.completedResponse(current)
        } catch (terminalError) {
          if (failOnCorruptEvidence && isCorruptEvidence(terminalError)) {
            throw terminalError
          }
          this.onError(terminalError, current)

          return { status: 'pending', operationId: current.id, phase: 'physical-published' }
        }
      }

      return { status: 'pending', operationId: current.id, phase: pendingPhaseOf(current) }
    }
  }

  private async resume(operation: RestoreOperationRecord): Promise<RestoreCommandResult> {
    if (operation.phase === RESTORE_OPERATION_PHASE.rejected) {
      return rejectionOf(operation)
    }
    if (operation.phase === RESTORE_OPERATION_PHASE.succeeded) {
      return this.completedResponse(operation)
    }
    const authority = await this.authorityForSpace(operation.space)

    if (
      !authority ||
      !operation.targetPath ||
      !authority.supportsRestartDurableStrict(operation.targetPath)
    ) {
      return { status: 'pending', operationId: operation.id, phase: pendingPhaseOf(operation) }
    }
    const prepared =
      operation.phase === RESTORE_OPERATION_PHASE.staged
        ? null
        : parsePreparedEvidence(operation.preparedEvidence)
    const sourceClass = operation.sourceRevisionId
      ? (await this.metaDb.revisions.get(operation.space, operation.sourceRevisionId))?.class
      : null
    const className =
      prepared?.class ??
      sourceClass ??
      (await this.metaDb.revisions.latestFor(operation.space, operation.noteId))?.class ??
      null
    const packagePath =
      skillPackageContextOf(authority, className, operation.targetPath)?.packagePath ?? null
    await this.enterProjection(operation)
    const lease = packagePath
      ? await authority.admitSkillPlacement(
          operation.targetPath,
          'exclusive',
          `restore:${operation.id}`,
          {
            allowDuringClosure: true,
          },
        )
      : await authority.admitResource(
          operation.targetPath,
          'exclusive',
          `restore:${operation.id}`,
          { allowDuringClosure: true },
        )

    let result: RestoreCommandResult

    try {
      const current =
        operation.phase === RESTORE_OPERATION_PHASE.staged
          ? await this.prepare(
              operation,
              authority,
              parseAcceptedEvidence(operation.preparedEvidence),
            )
          : operation

      if (current.phase === RESTORE_OPERATION_PHASE.rejected) {
        result = rejectionOf(current)
      } else {
        result = await this.publishAndCommit(current, authority, packagePath)
      }
      if (
        result.status === 'pending' &&
        (result.phase === 'physical-published' || result.phase === 'failed-recoverable')
      ) {
        this.closeForRecovery(authority)
      }
    } catch (error) {
      const durable = await this.metaDb.restoreOperations.get(operation.id)

      if (
        durable?.phase === RESTORE_OPERATION_PHASE.physicalPublished ||
        durable?.phase === RESTORE_OPERATION_PHASE.failedRecoverable
      ) {
        this.closeForRecovery(authority)
      }
      throw error
    } finally {
      lease.settle()
    }

    if (result.status === 'succeeded') {
      await this.reopenAfterCommit(operation.space, authority)
      try {
        await this.spaces.reconcileCausalProjection(operation.space, operation.noteId)
      } catch (error) {
        this.onError(error, operation)
        return { status: 'pending', operationId: operation.id, phase: 'physical-published' }
      }
    }

    return result
  }

  private async prepare(
    operation: RestoreOperationRecord,
    authority: SpaceResourceAuthority,
    accepted: AcceptedEvidence,
  ): Promise<RestoreOperationRecord> {
    const reject = (kind: 'conflict' | 'not-restorable', reason: string) =>
      this.reject(operation, kind, reason)
    let identity = await this.metaDb.identity.findById?.(operation.noteId)
    const sourceRevision = operation.sourceRevisionId
      ? await this.metaDb.revisions.get(operation.space, operation.sourceRevisionId)
      : null
    const head = await this.metaDb.revisions.latestFor(operation.space, operation.noteId)

    if (
      !identity ||
      identity.space !== operation.space ||
      identity.filePath !== operation.targetPath ||
      !sourceRevision ||
      sourceRevision.noteId !== operation.noteId ||
      sourceRevision.space !== operation.space ||
      accepted.noteId !== operation.noteId ||
      accepted.revisionId !== sourceRevision.id
    ) {
      return reject('conflict', 'source-or-identity-changed')
    }
    if (!head) {
      return reject('conflict', 'revision-head-missing')
    }
    if (
      accepted.mode === 'history'
        ? identity.deletedAt != null
        : identity.deletedAt == null ||
          accepted.requestedSpace !== operation.space ||
          head.id !== sourceRevision.id ||
          head.kind !== REVISION_KIND.delete
    ) {
      return reject('conflict', 'restore-target-changed')
    }
    if (!sourceRevision.contentHash) {
      return reject('not-restorable', 'source-content-unavailable')
    }
    const sourceBlob = await this.metaDb.revisions.content(sourceRevision.contentHash)

    if (sourceBlob == null) {
      return reject('not-restorable', 'source-content-unavailable')
    }
    const observation = await authority.observeStrictAdmitted(identity.filePath)

    if (observation.kind === 'unavailable') {
      throw new Error('restore target is not stably observable')
    }
    if (
      (accepted.mode === 'history' && observation.kind !== 'present') ||
      (accepted.mode === 'trash' && observation.kind !== 'absent')
    ) {
      return reject('conflict', 'physical-target-changed')
    }
    const className = head.class ?? sourceRevision.class
    const target = await this.targetDocumentContext(authority, className, identity.filePath)

    if (target.status === 'retry') {
      throw new Error(target.reason)
    }
    if (target.status === 'reject') {
      return reject('not-restorable', target.reason)
    }
    let headDocumentState: DocumentState | null = null

    if (
      head.contentHash &&
      (head.stateFormat === DOCUMENT_STATE_FORMAT.markdown ||
        head.stateFormat === DOCUMENT_STATE_FORMAT.skill ||
        head.stateFormat === DOCUMENT_STATE_FORMAT.opaque)
    ) {
      const headBlob =
        head.contentHash === sourceRevision.contentHash
          ? sourceBlob
          : await this.metaDb.revisions.content(head.contentHash)

      if (headBlob != null) {
        try {
          headDocumentState = decodeDocumentState(bytesOf(headBlob))
        } catch {
          headDocumentState = null
        }
      }
    }
    const proof =
      observation.kind === 'present'
        ? await proofOf(this.metaDb, identity, observation.bytes, headDocumentState)
        : {
            revision: (await this.metaDb.ownerProofs.get(identity.id))?.proofRevision ?? null,
          }
    const currentState =
      observation.kind === 'present'
        ? analyzeDocumentState({
            source: observation.bytes,
            role: target.role,
            pathFallbackTitle: target.pathFallbackTitle,
            ownerProof: proof.proof,
            ...(target.skillDirectoryName ? { skillDirectoryName: target.skillDirectoryName } : {}),
          })
        : null

    if (
      accepted.mode === 'history' &&
      (!currentState || documentStateVersionToken(currentState) !== accepted.versionToken)
    ) {
      return reject('conflict', 'version-conflict')
    }
    if (observation.kind === 'present') {
      const owner = exactOwnerObservation(observation.bytes)

      if (
        owner.kind === 'unproven' ||
        (owner.kind === 'claimed' && owner.id !== operation.noteId)
      ) {
        return reject('conflict', 'physical-owner-unproven')
      }
      const currentTitle = currentState?.projection?.title
      const alias = currentTitle ? legacyNoteNameAlias(currentTitle, identity.filePath) : null

      if (alias) {
        const merged = await this.metaDb.identity.mergeLegacyNameAlias({
          id: identity.id,
          space: identity.space,
          alias,
        })

        if (merged.status !== 'merged') {
          return reject('conflict', 'source-or-identity-changed')
        }
        const refreshed = await this.metaDb.identity.findById?.(identity.id)

        if (!refreshed || refreshed.space !== operation.space) {
          return reject('conflict', 'source-or-identity-changed')
        }
        identity = {
          ...refreshed,
          legacyNameAliases: unionLegacyNameAliases(
            refreshed.legacyNameAliases,
            merged.legacyNameAliases,
          ),
        }
      }
    }
    let candidatePlan
    let sourceKind: 'document' | 'legacy'

    if (
      sourceRevision.stateFormat === DOCUMENT_STATE_FORMAT.markdown ||
      sourceRevision.stateFormat === DOCUMENT_STATE_FORMAT.skill ||
      sourceRevision.stateFormat === DOCUMENT_STATE_FORMAT.opaque
    ) {
      let historical: DocumentState

      try {
        historical = decodeDocumentState(bytesOf(sourceBlob))
      } catch {
        // The blob EXISTS — we are holding its bytes — and this reader cannot project
        // them. Saying "invalid" blames the row for what is a fact about this server, and
        // it is the same lie the journal's own vocabulary stopped telling.
        // canon: docs/trash.md#availability
        return reject('not-restorable', STORE_ERROR_REASON.revisionContentUnreadable)
      }
      const compatibility = documentRestoreCompatibility(historical, {
        role: target.role,
        pathFallbackTitle: target.pathFallbackTitle,
      })

      if (compatibility.status === 'non-restorable') {
        return reject('not-restorable', compatibility.reason)
      }
      try {
        candidatePlan = planDocumentMutation(historical, {
          owners: {
            [STORAGE_OWNER_KEY.id]: operation.noteId,
            [STORAGE_OWNER_KEY.created]: identity.createdAt,
          },
        })
      } catch {
        return reject('not-restorable', 'owner-provenance-conflict')
      }
      sourceKind = 'document'
    } else {
      let legacyBody: string

      if (sourceRevision.stateFormat === LOGICAL_NOTE_STATE_FORMAT) {
        const legacyState = analyzeDocumentState({
          source: bytesOf(sourceBlob),
          role: target.role,
          pathFallbackTitle: target.pathFallbackTitle,
          ...(target.skillDirectoryName ? { skillDirectoryName: target.skillDirectoryName } : {}),
        })

        if (!legacyState.projection) {
          return reject('not-restorable', 'legacy-source-unreadable')
        }
        legacyBody = legacyState.projection.body
      } else {
        legacyBody = new TextDecoder().decode(bytesOf(sourceBlob))
      }
      const legacyBase =
        currentState ??
        analyzeDocumentState({
          source:
            sourceRevision.stateFormat === LOGICAL_NOTE_STATE_FORMAT
              ? bytesOf(sourceBlob)
              : new TextEncoder().encode(
                  logicalNoteStateFromProjection({
                    title: sourceRevision.title,
                    body: legacyBody,
                    frontmatter: {
                      tags: sourceRevision.tags,
                      ...(sourceRevision.slug ? { slug: sourceRevision.slug } : {}),
                    },
                  }).markdown,
                ),
          role: target.role,
          pathFallbackTitle: target.pathFallbackTitle,
          ...(target.skillDirectoryName ? { skillDirectoryName: target.skillDirectoryName } : {}),
        })

      try {
        candidatePlan = planDocumentMutation(legacyBase, {
          title: sourceRevision.title,
          fallbackPolicy: 'pinned',
          body: legacyBody,
          tags: sourceRevision.tags,
          slug: sourceRevision.slug,
          owners: {
            [STORAGE_OWNER_KEY.id]: operation.noteId,
            [STORAGE_OWNER_KEY.created]: identity.createdAt,
          },
        })
      } catch {
        return reject('not-restorable', 'legacy-source-unsafe')
      }
      sourceKind = 'legacy'
    }
    // Reading the candidate back is PURE: the same bytes give the same answer on every
    // replay, so a throw here is a verdict about this restore and not a transient fault
    // no retry can clear — the honest refusal a document over the frontmatter cap gets,
    // for instance. It has to be terminal. Left to propagate it aborted prepare with the
    // operation still `staged`, which `listRecoverable` reports, so ONE such note pinned
    // its whole space against archive and purge forever while every retry re-threw.
    // Everything above this point may legitimately fail transiently (the meta-DB, the
    // filesystem, an admission lease) and is deliberately left retryable.
    let candidateState: DocumentState

    try {
      const placeholderProof = bindStorageOwnerProof({
        source: candidatePlan.source,
        owners: candidatePlan.proposedOwnerProof.claims.map(({ key, ownership }) => ({
          key,
          ownership,
        })),
        evidence: { kind: 'mutation-receipt', id: operation.id },
        generatedContainer: candidatePlan.proposedOwnerProof.generatedContainer,
      })

      candidateState = analyzeDocumentState({
        source: candidatePlan.source,
        role: target.role,
        pathFallbackTitle: candidatePlan.pathFallbackTitle,
        ownerProof: placeholderProof,
        ...(target.skillDirectoryName ? { skillDirectoryName: target.skillDirectoryName } : {}),
      })
    } catch (error) {
      // The failure code says what the operator can act on; the cause stays in the log.
      this.onError(error, operation)
      return reject('not-restorable', 'candidate-is-unsafe')
    }

    if (!candidateState.projection || candidateState.restoreSafety.status !== 'safe') {
      return reject('not-restorable', 'candidate-is-unsafe')
    }
    if (target.role === DOCUMENT_ROLE.skillRoot) {
      try {
        await authority.assertSkillManifestNameAvailableAdmitted(
          identity.filePath,
          candidatePlan.source,
        )
      } catch (error) {
        if ((error as { code?: string }).code === 'SKILL_NAME_CONFLICT') {
          return reject('conflict', 'skill-name-conflict')
        }
        if ((error as { code?: string }).code === 'INVALID_SKILL_MANIFEST') {
          return reject('not-restorable', 'invalid-skill-manifest')
        }
        throw error
      }
    }
    const beforeText =
      sourceKind === 'document'
        ? documentSourceText(decodeDocumentState(bytesOf(sourceBlob)))
        : null
    const afterText = documentSourceText(candidateState)
    const stats = beforeText != null && afterText != null ? diffStats(beforeText, afterText) : null
    const prepared: PreparedEvidence = {
      version: 2,
      kind: 'prepared',
      mode: accepted.mode,
      principalId: accepted.principalId,
      noteId: operation.noteId,
      sourceRevisionId: sourceRevision.id,
      expectedHeadRevisionId: head.id,
      targetPath: identity.filePath,
      class: className,
      role: target.role,
      skillDirectoryName: target.skillDirectoryName,
      pathFallbackTitle: candidatePlan.pathFallbackTitle,
      candidateSource: Buffer.from(candidatePlan.source).toString('base64'),
      candidateVersionToken: documentStateVersionToken(candidateState),
      ownerClaims: candidatePlan.proposedOwnerProof.claims.map(({ key, ownership }) => ({
        key,
        ownership,
      })),
      generatedContainer: candidatePlan.proposedOwnerProof.generatedContainer === true,
      expectedClaim: observation.claim,
      expectedIdentity: {
        addressRevision: identity.addressRevision ?? 0,
        filePath: identity.filePath,
        deletedAt: identity.deletedAt,
      },
      identity: { ...identity, addressRevision: identity.addressRevision ?? 0, deletedAt: null },
      legacyNameAliases: [...identity.legacyNameAliases],
      expectedProofRevision: proof.revision,
      charsAdded: stats?.charsAdded ?? null,
      charsRemoved: stats?.charsRemoved ?? null,
    }
    const stagePackagePath = skillPackageContextOf(
      authority,
      className,
      identity.filePath,
    )?.packagePath
    const stage = await authority.stageStrict({
      operationId: operation.id,
      binding: operation.stageBinding,
      path: identity.filePath,
      content: candidatePlan.source,
      expected: observation.claim,
      ...(stagePackagePath ? { packagePath: stagePackagePath } : {}),
    })

    if (stage.status === 'idempotency-conflict') {
      throw new Error('strict stage binding conflicts with durable state')
    }
    const transition = await this.metaDb.restoreOperations.transition({
      id: operation.id,
      expectedPhases: [RESTORE_OPERATION_PHASE.staged],
      phase: RESTORE_OPERATION_PHASE.prepared,
      sourceRevisionId: sourceRevision.id,
      expectedHeadRevisionId: head.id,
      targetPath: identity.filePath,
      preparedEvidence: encodeJson(prepared),
      failureCode: null,
      updatedAt: this.now().toISOString(),
    })

    if (transition.status === 'missing') {
      throw new Error('accepted restore operation disappeared during prepare')
    }

    return transition.operation
  }

  private async publishAndCommit(
    operation: RestoreOperationRecord,
    authority: SpaceResourceAuthority,
    packagePath: string | null,
  ): Promise<RestoreCommandResult> {
    let prepared = parsePreparedEvidence(operation.preparedEvidence)
    const ref: ResourceStrictStageRef = {
      operationId: operation.id,
      binding: operation.stageBinding,
      path: prepared.targetPath,
      ...(packagePath ? { packagePath } : {}),
    }
    let current = operation

    if (
      current.phase === RESTORE_OPERATION_PHASE.prepared ||
      current.phase === RESTORE_OPERATION_PHASE.failedRecoverable
    ) {
      const state = await authority.inspectStrict(ref)
      let publication

      // A v1 operation has no durable pre-effect owner observation. Once strict
      // publication may have started, the public pathname may already contain the
      // candidate and cannot prove what this operation originally observed.
      if (
        prepared.version === 1 &&
        (state.status === 'publishing' || state.status === 'failed-recoverable')
      ) {
        return this.markRecoverable(current, 'legacy-strict-stage-post-effect-ambiguous')
      }

      if (prepared.version === 1 && state.status === 'staged') {
        const upgraded = await this.upgradePreparedEvidence(
          current,
          prepared,
          authority,
          state.stage.expected,
        )

        if (!upgraded) {
          await authority.discardStrict(ref)
          const rejected = await this.reject(current, 'conflict', 'physical-target-changed')
          return rejectionOf(rejected)
        }
        current = upgraded.operation
        prepared = upgraded.prepared
      }

      if (state.status === 'published') {
        publication = { status: 'published' as const, receipt: state.receipt }
      } else if (state.status === 'missing') {
        return this.markRecoverable(current, 'strict-stage-missing')
      } else {
        publication = await authority.publishStrictAdmitted(ref)
      }

      if (publication.status === 'conflict') {
        await authority.discardStrict(ref)
        const rejected = await this.reject(current, 'conflict', 'physical-target-changed')
        return rejectionOf(rejected)
      }
      if (publication.status === 'failed-recoverable') {
        return this.markRecoverable(current, publication.reason)
      }
      const physicalReceipt = encodeJson(publication.receipt)
      const transitioned = await this.metaDb.restoreOperations.transition({
        id: current.id,
        expectedPhases: [
          RESTORE_OPERATION_PHASE.prepared,
          RESTORE_OPERATION_PHASE.failedRecoverable,
        ],
        phase: RESTORE_OPERATION_PHASE.physicalPublished,
        physicalReceipt,
        failureCode: null,
        updatedAt: this.now().toISOString(),
      })

      if (transitioned.status === 'missing') {
        throw new Error('restore operation disappeared after physical publication')
      }
      current = transitioned.operation
    }
    if (
      current.phase !== RESTORE_OPERATION_PHASE.physicalPublished &&
      current.phase !== RESTORE_OPERATION_PHASE.metadataCommitted
    ) {
      return this.responseFor(current)
    }
    if (!current.physicalReceipt) {
      throw new Error('physical restore operation has no receipt')
    }
    if (prepared.version === 1) {
      // A pre-upgrade operation may already have crossed physical publication,
      // where the old title/path pair no longer exists to inspect. Never infer
      // from the restored bytes; carry only aliases already durable on identity.
      const durable = await this.metaDb.identity.findById?.(prepared.noteId)
      const aliases = unionLegacyNameAliases(
        prepared.legacyNameAliases,
        durable?.legacyNameAliases ?? [],
      )

      prepared = {
        ...prepared,
        identity: { ...prepared.identity, legacyNameAliases: aliases },
        legacyNameAliases: aliases,
      }
    }
    const candidateSource = Uint8Array.from(Buffer.from(prepared.candidateSource, 'base64'))
    const ownerProof = bindStorageOwnerProof({
      source: candidateSource,
      owners: prepared.ownerClaims,
      evidence: { kind: 'mutation-receipt', id: current.id },
      generatedContainer: prepared.generatedContainer,
    })
    const finalState = analyzeDocumentState({
      source: candidateSource,
      role: prepared.role,
      pathFallbackTitle: prepared.pathFallbackTitle,
      ownerProof,
      ...(prepared.skillDirectoryName ? { skillDirectoryName: prepared.skillDirectoryName } : {}),
    })

    if (documentStateVersionToken(finalState) !== prepared.candidateVersionToken) {
      throw new Error('prepared restore candidate changed semantic identity')
    }
    const physicalReceipt = JSON.parse(current.physicalReceipt) as StrictMutationReceipt

    if (
      physicalReceipt.operationId !== current.id ||
      physicalReceipt.binding !== current.stageBinding ||
      physicalReceipt.restartDurable !== true ||
      physicalReceipt.candidateHash !== (await sha256Hex(candidateSource))
    ) {
      throw new Error('restore physical receipt changed before projection adoption')
    }
    const adopted = await this.spaces.adoptCausalPublication(current.space, {
      path: prepared.targetPath,
      source: candidateSource,
      ownerProof,
      document: {
        role: prepared.role,
        pathFallbackTitle: prepared.pathFallbackTitle,
        skillDirectoryName: prepared.skillDirectoryName,
      },
      identity: prepared.identity,
      receipt: {
        id: current.id,
        semanticEventTime: physicalReceipt.semanticEventTime,
        candidateHash: physicalReceipt.candidateHash,
        transitions: physicalReceipt.transitions,
      },
    })

    if (
      documentStateVersionToken(adopted) !== prepared.candidateVersionToken ||
      adopted.semanticFingerprint !== finalState.semanticFingerprint
    ) {
      throw new Error('restore projection changed before terminal metadata')
    }
    const content = encodeDocumentState(finalState)
    const contentHash = await sha256Hex(content)
    const fields = projectionFields(finalState)
    const committedAt = this.now().toISOString()
    const terminal =
      current.phase === RESTORE_OPERATION_PHASE.metadataCommitted
        ? {
            status: 'replayed' as const,
            operation: current,
            result: terminalResultOf(current),
          }
        : await this.metaDb.restoreTerminal.commit({
            operationId: current.id,
            sourceRevisionId: prepared.sourceRevisionId,
            expectedHeadRevisionId: prepared.expectedHeadRevisionId,
            targetPath: prepared.targetPath,
            preparedEvidence: current.preparedEvidence!,
            physicalReceipt: current.physicalReceipt,
            expectedIdentity: prepared.expectedIdentity,
            identity: prepared.identity,
            revision: {
              noteId: prepared.noteId,
              space: current.space,
              baseRevisionId: prepared.expectedHeadRevisionId,
              expectedHeadRevisionId: prepared.expectedHeadRevisionId,
              theirRevisionId: null,
              sourceRevisionId: prepared.sourceRevisionId,
              kind: REVISION_KIND.restore,
              entryRole: 'change',
              principal: prepared.principalId,
              agent: null,
              contentHash,
              semanticFingerprint: finalState.semanticFingerprint,
              stateFormat: finalState.format,
              restoreSafety: finalState.restoreSafety.status,
              title: fields.title,
              class: prepared.class,
              slug: fields.slug,
              tags: fields.tags,
              createdAt: committedAt,
              charsAdded: prepared.charsAdded,
              charsRemoved: prepared.charsRemoved,
              allowSemanticNoop: false,
            },
            content,
            proof: {
              sourceHash: await sha256Hex(candidateSource),
              proofJson: encodeJson(ownerProof),
              receiptId: current.id,
              expectedProofRevision: prepared.expectedProofRevision,
            },
            result: {
              noteId: prepared.noteId,
              filePath: prepared.targetPath,
              versionToken: prepared.candidateVersionToken,
            },
            outboxKind: 'note-restore-committed',
            committedAt,
          })

    if (terminal.status === 'conflict') {
      return this.markRecoverable(current, `terminal-${terminal.conflict}`)
    }
    current = terminal.operation
    this.releaseProjection(current.id)
    // Publication is the physical linearization point. Once terminal.commit has
    // persisted the restore revision, a foreign pathname replacement is a later
    // external mutation: keeping metadata-committed nonterminal cannot make the
    // two authorities atomic and instead pins purge/lifecycle forever. Finalize
    // the accepted command and let execute() synchronously reconcile the current
    // pathname as the next journal/projection state before returning success.
    const finalized = await this.metaDb.restoreTerminal.finalize({
      operationId: current.id,
      preparedEvidence: current.preparedEvidence!,
      physicalReceipt: current.physicalReceipt!,
      outboxKind: 'note-restore-committed',
      finalizedAt: this.now().toISOString(),
    })

    if (finalized.status === 'conflict') {
      return {
        status: 'pending',
        operationId: current.id,
        phase: pendingPhaseOf(current),
      }
    }
    this.wakeOutbox()
    await this.cleanupStrictStage(finalized.operation, authority, ref)
    const result = finalized.result

    return { status: 'succeeded', operationId: finalized.operation.id, ...result }
  }

  /** Upgrade old prepared evidence only while the strict stage still proves its
   * original expected claim. Published stages have crossed the trust boundary and
   * carry only aliases that were already durable. */
  private async upgradePreparedEvidence(
    operation: RestoreOperationRecord,
    prepared: PreparedEvidence,
    authority: SpaceResourceAuthority,
    stagedExpectedClaim: FileClaim,
  ): Promise<{ operation: RestoreOperationRecord; prepared: PreparedEvidence } | null> {
    const durable = await this.metaDb.identity.findById?.(prepared.noteId)

    if (!durable || durable.space !== operation.space) {
      return null
    }
    let aliases = unionLegacyNameAliases(prepared.legacyNameAliases, durable.legacyNameAliases)

    if (!sameFileClaim(stagedExpectedClaim, prepared.expectedClaim)) {
      return null
    }
    const observation = await authority.observeStrictAdmitted(prepared.targetPath)

    if (
      !('claim' in observation) ||
      !sameFileClaim(observation.claim, prepared.expectedClaim) ||
      (prepared.mode === 'history' && observation.kind !== 'present') ||
      (prepared.mode === 'trash' && observation.kind !== 'absent')
    ) {
      return null
    }
    if (observation.kind === 'absent') {
      if (durable.filePath !== prepared.targetPath) {
        return null
      }
    } else {
      if (observation.kind !== 'present') {
        return null
      }
      const owner = exactOwnerObservation(observation.bytes)

      if (
        owner.kind === 'unproven' ||
        (owner.kind === 'claimed' && owner.id !== prepared.noteId) ||
        (owner.kind === 'absent' && durable.filePath !== prepared.targetPath)
      ) {
        return null
      }
      const state = analyzeDocumentState({
        source: observation.bytes,
        role: prepared.role,
        pathFallbackTitle: prepared.pathFallbackTitle,
        ...(prepared.skillDirectoryName ? { skillDirectoryName: prepared.skillDirectoryName } : {}),
      })
      const title = state.projection?.title
      const alias = title ? legacyNoteNameAlias(title, prepared.targetPath) : null

      if (alias) {
        const merged = await this.metaDb.identity.mergeLegacyNameAlias({
          id: prepared.noteId,
          space: operation.space,
          alias,
        })

        if (merged.status !== 'merged') {
          return null
        }
        aliases = unionLegacyNameAliases(aliases, merged.legacyNameAliases)
      }
    }
    const upgraded: PreparedEvidence = {
      ...prepared,
      version: 2,
      identity: { ...prepared.identity, legacyNameAliases: aliases },
      legacyNameAliases: aliases,
    }
    const transition = await this.metaDb.restoreOperations.transition({
      id: operation.id,
      expectedPhases: [operation.phase],
      expectedPreparedEvidence: operation.preparedEvidence ?? undefined,
      phase: operation.phase,
      preparedEvidence: encodeJson(upgraded),
      updatedAt: this.now().toISOString(),
    })

    if (transition.status === 'missing') {
      throw new Error('prepared restore operation disappeared during evidence upgrade')
    }
    if (transition.status === 'phase-conflict') {
      const concurrent = parsePreparedEvidence(transition.operation.preparedEvidence)

      return concurrent.version === 2
        ? { operation: transition.operation, prepared: concurrent }
        : null
    }

    return { operation: transition.operation, prepared: upgraded }
  }

  private async targetDocumentContext(
    authority: SpaceResourceAuthority,
    className: string | null,
    path: string,
  ): Promise<
    | {
        status: 'ready'
        role: DocumentRole
        pathFallbackTitle: string
        skillDirectoryName: string | null
      }
    | { status: 'retry'; reason: string }
    | { status: 'reject'; reason: string }
  > {
    const pathFallbackTitle = fallbackTitleOf(path)

    if (className !== 'skill') {
      return {
        status: 'ready',
        role: DOCUMENT_ROLE.generic,
        pathFallbackTitle,
        skillDirectoryName: null,
      }
    }
    const context = skillPackageContextOf(authority, className, path)

    if (!context) {
      return { status: 'retry', reason: 'skill package path is not canonical' }
    }
    const { packagePath, relativePath } = context
    const directoryName = basenameOf(packagePath)

    if (isSkillPackageRootPath(relativePath)) {
      return {
        status: 'ready',
        role: DOCUMENT_ROLE.skillRoot,
        pathFallbackTitle,
        skillDirectoryName: directoryName,
      }
    }
    const root = await authority.observeStrictAdmitted(`${packagePath}/SKILL.md`)

    if (root.kind === 'unavailable') {
      return { status: 'retry', reason: 'skill package root is not stably observable' }
    }
    if (
      root.kind === 'present' &&
      analyzeDocumentState({
        source: root.bytes,
        role: DOCUMENT_ROLE.skillRoot,
        skillDirectoryName: directoryName,
      }).format === DOCUMENT_STATE_FORMAT.skill
    ) {
      return {
        status: 'ready',
        role: DOCUMENT_ROLE.skillAuxiliary,
        pathFallbackTitle,
        skillDirectoryName: null,
      }
    }

    if (root.kind === 'absent') {
      return { status: 'reject', reason: 'skill-package-root-missing' }
    }

    return {
      status: 'ready',
      role: DOCUMENT_ROLE.generic,
      pathFallbackTitle,
      skillDirectoryName: null,
    }
  }

  private async reject(
    operation: RestoreOperationRecord,
    kind: 'conflict' | 'not-restorable',
    reason: string,
  ): Promise<RestoreOperationRecord> {
    const transition = await this.metaDb.restoreOperations.transition({
      id: operation.id,
      expectedPhases: [
        RESTORE_OPERATION_PHASE.staged,
        RESTORE_OPERATION_PHASE.prepared,
        RESTORE_OPERATION_PHASE.failedRecoverable,
      ],
      phase: RESTORE_OPERATION_PHASE.rejected,
      failureCode: `${kind}:${reason}`,
      updatedAt: this.now().toISOString(),
    })

    if (transition.status === 'missing') {
      throw new Error('restore operation disappeared while rejecting it')
    }

    this.releaseProjection(operation.id)

    return transition.operation
  }

  private async markRecoverable(
    operation: RestoreOperationRecord,
    reason: string,
  ): Promise<Extract<RestoreCommandResult, { status: 'pending' }>> {
    const transition = await this.metaDb.restoreOperations.transition({
      id: operation.id,
      expectedPhases: [
        RESTORE_OPERATION_PHASE.prepared,
        RESTORE_OPERATION_PHASE.failedRecoverable,
        RESTORE_OPERATION_PHASE.physicalPublished,
      ],
      phase: RESTORE_OPERATION_PHASE.failedRecoverable,
      failureCode: reason,
      updatedAt: this.now().toISOString(),
    })
    const current = transition.status === 'missing' ? operation : transition.operation

    return {
      status: 'pending',
      operationId: current.id,
      phase: pendingPhaseOf(current),
    }
  }

  private async completedResponse(
    operation: RestoreOperationRecord,
  ): Promise<RestoreCommandResult> {
    this.releaseProjection(operation.id)
    const authority = operation.targetPath ? await this.authorityForSpace(operation.space) : null

    if (authority && operation.targetPath && operation.preparedEvidence) {
      const prepared = parsePreparedEvidence(operation.preparedEvidence)
      const packagePath = skillPackageContextOf(
        authority,
        prepared.class,
        prepared.targetPath,
      )?.packagePath
      await this.cleanupStrictStage(operation, authority, {
        operationId: operation.id,
        binding: operation.stageBinding,
        path: prepared.targetPath,
        ...(packagePath ? { packagePath } : {}),
      })
    }
    try {
      await this.spaces.reconcileCausalProjection(operation.space, operation.noteId)
    } catch (error) {
      this.onError(error, operation)
      return { status: 'pending', operationId: operation.id, phase: 'physical-published' }
    }
    const result = terminalResultOf(operation)

    return { status: 'succeeded', operationId: operation.id, ...result }
  }

  private async cleanupStrictStage(
    operation: RestoreOperationRecord,
    authority: SpaceResourceAuthority,
    ref: ResourceStrictStageRef,
  ): Promise<void> {
    try {
      await authority.discardStrict(ref)
    } catch (error) {
      // Metadata is already terminal and is the complete replay source. Cleanup
      // failure must not turn a successful accepted command back into an error;
      // every replay retries this best-effort reclamation.
      this.onError(error, operation)
    }
  }

  private responseFor(operation: RestoreOperationRecord): RestoreCommandResult {
    if (operation.phase === RESTORE_OPERATION_PHASE.rejected) {
      return rejectionOf(operation)
    }

    return { status: 'pending', operationId: operation.id, phase: pendingPhaseOf(operation) }
  }
}
