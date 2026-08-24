import { createHash, randomUUID } from 'node:crypto'
import { ABILITY_KIND, type AgentAbilityAvailabilityState, NOTE_CLASS } from '@notarium/contract'
import {
  type AgentWriteAttribution,
  analyzeDocumentState,
  bindStorageOwnerProof,
  directoryOf,
  DOCUMENT_ROLE,
  type DocumentState,
  documentStateVersionToken,
  encodeDocumentState,
  freshNoteId,
  type IdentityRecord,
  planDocumentMutation,
  type PublishedResourceEvidence,
  REVISION_ENTRY_ROLE,
  REVISION_KIND,
  sha256Hex,
  STORAGE_OWNER_KEY,
  type StorageOwnerKey,
  type StorageOwnerProof,
} from '@notarium/core'
import type {
  ResourceStrictStageRef,
  ResourceStrictStageState,
  SpaceResourceAuthority,
  StrictMutationReceipt,
} from '@notarium/engine'

import {
  ABILITY_CREATE_PHASE,
  type AbilityCreateOperationRecord,
  type AbilityCreatePersistence,
  type AbilityCreateTerminalResult,
} from '../../../metaDb'
import {
  AbilityUnavailableError,
  type AddressedPlacement,
  ownedRoleLocator,
  ownedSkillLocator,
  RoleAlreadyExistsError,
  type RoleLocation,
  type RolesService,
  SkillAlreadyExistsError,
  type SkillHomeLocation,
} from '../../../roles'
import { SystemAbilityNameConflictError } from '../../errors'
import type { CustomAbilityCreator, PreparedAbilityCreate, PublishedAbility } from '../../types'

type PreparedEvidence = {
  version: 1
  kind: 'role' | 'skill'
  body: Extract<PreparedAbilityCreate, { source: 'custom' }>['body']
  location: AddressedPlacement
  availability?: AgentAbilityAvailabilityState
  packageId: string
  noteId: string
  targetPath: string
  createdAt: string
  source: string
  versionToken: string
  ownerClaims: Array<{ key: StorageOwnerKey; ownership: 'entry' | 'value' }>
  generatedContainer: boolean
  attribution: { principal: string; agent?: AgentWriteAttribution }
  systemNamePolicy: 'allow' | 'reject'
  /** Evidence written before caller policy existed is conservatively reject-only. */
  legacySystemNamePolicy?: true
}

type DurableAbilityCreatorOptions = {
  persistence: AbilityCreatePersistence
  roles: RolesService
  authorityForSpace(space: string): Promise<SpaceResourceAuthority | null>
  beginProjection?(space: string, operationId: string): Promise<() => void>
  primeIdentity?(space: string, record: IdentityRecord): Promise<void>
  confirmIdentity?(space: string, noteId: string): Promise<void>
  releaseIdentity?(space: string, noteId: string): Promise<void>
  adoptPublication?(space: string, evidence: PublishedResourceEvidence): Promise<DocumentState>
  reconcile(space: string, noteId: string): Promise<void>
  wakeOutbox?: () => void
  now?: () => Date
  operationId?: () => string
  onError?: (error: unknown, operation: AbilityCreateOperationRecord) => void
}

const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
const encodeJson = (value: unknown): string => JSON.stringify(value)

const parsedEvidence = (operation: AbilityCreateOperationRecord): PreparedEvidence => {
  let value: unknown

  try {
    value = JSON.parse(operation.preparedEvidence)
  } catch {
    throw new Error(`ability create operation ${operation.id} has invalid evidence`)
  }
  const evidence = value as Partial<PreparedEvidence>
  const legacySystemNamePolicy = evidence.systemNamePolicy === undefined

  if (
    evidence.version !== 1 ||
    (evidence.kind !== ABILITY_KIND.role && evidence.kind !== ABILITY_KIND.skill) ||
    !evidence.body ||
    typeof evidence.body !== 'object' ||
    !evidence.location ||
    typeof evidence.location !== 'object' ||
    typeof evidence.packageId !== 'string' ||
    typeof evidence.noteId !== 'string' ||
    typeof evidence.targetPath !== 'string' ||
    typeof evidence.createdAt !== 'string' ||
    typeof evidence.source !== 'string' ||
    typeof evidence.versionToken !== 'string' ||
    !Array.isArray(evidence.ownerClaims) ||
    !evidence.attribution ||
    typeof evidence.attribution.principal !== 'string' ||
    (!legacySystemNamePolicy &&
      evidence.systemNamePolicy !== 'allow' &&
      evidence.systemNamePolicy !== 'reject')
  ) {
    throw new Error(`ability create operation ${operation.id} has invalid evidence`)
  }
  if (
    evidence.packageId !== operation.packageId ||
    evidence.noteId !== operation.noteId ||
    evidence.targetPath !== operation.targetPath
  ) {
    throw new Error(`ability create operation ${operation.id} evidence changed address`)
  }

  const normalized = evidence as PreparedEvidence

  normalized.systemNamePolicy ??= 'reject'
  if (legacySystemNamePolicy) {
    normalized.legacySystemNamePolicy = true
  }

  return normalized
}

const resultOf = (operation: AbilityCreateOperationRecord): AbilityCreateTerminalResult => {
  const result = operation.terminalResult
    ? (JSON.parse(operation.terminalResult) as Partial<AbilityCreateTerminalResult>)
    : null

  if (
    !result ||
    typeof result.packageId !== 'string' ||
    typeof result.noteId !== 'string' ||
    typeof result.versionToken !== 'string' ||
    typeof result.revisionId !== 'string'
  ) {
    throw new Error(`ability create operation ${operation.id} has invalid terminal result`)
  }

  return result as AbilityCreateTerminalResult
}

const projectionFields = (state: DocumentState) => {
  const projection = state.projection

  if (!projection?.skill) {
    throw new Error('prepared ability has no skill projection')
  }
  const tags = projection.frontmatter.tags
  const slug = projection.frontmatter.slug

  return {
    title: projection.title,
    tags: Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === 'string') : [],
    slug: typeof slug === 'string' && slug ? slug : null,
  }
}

const stateOf = (operation: AbilityCreateOperationRecord, evidence: PreparedEvidence) => {
  const source = Uint8Array.from(Buffer.from(evidence.source, 'base64'))
  const proof = bindStorageOwnerProof({
    source,
    owners: evidence.ownerClaims,
    evidence: { kind: 'mutation-receipt', id: operation.id },
    generatedContainer: evidence.generatedContainer,
  })
  const state = analyzeDocumentState({
    source,
    role: DOCUMENT_ROLE.skillRoot,
    skillDirectoryName: evidence.packageId,
    pathFallbackTitle: evidence.body.name,
    ownerProof: proof,
  })

  if (!state.projection?.skill || documentStateVersionToken(state) !== evidence.versionToken) {
    throw new Error(`ability create operation ${operation.id} evidence is not reproducible`)
  }

  return { source, proof, state }
}

const publishedOf = (
  operation: AbilityCreateOperationRecord,
  evidence: PreparedEvidence,
  result: AbilityCreateTerminalResult,
): PublishedAbility => {
  const state = stateOf(operation, evidence).state
  const fields = projectionFields(state)

  if (evidence.kind === ABILITY_KIND.role) {
    const body = evidence.body as Extract<
      Extract<PreparedAbilityCreate, { source: 'custom' }>,
      { kind: 'role' }
    >['body']
    const location = evidence.location as RoleLocation

    return {
      kind: ABILITY_KIND.role,
      body,
      location,
      ability: {
        name: body.name,
        title: fields.title,
        description: body.description,
        scope: location.scope,
        space: location.space,
        ...(location.projectId ? { projectId: location.projectId } : {}),
        ...(evidence.availability ? { availability: evidence.availability } : {}),
        packageId: result.packageId,
        noteId: result.noteId,
      },
      locator: ownedRoleLocator(location, result.packageId),
      versionToken: result.versionToken,
    }
  }
  const body = evidence.body as Extract<
    Extract<PreparedAbilityCreate, { source: 'custom' }>,
    { kind: 'skill' }
  >['body']
  const location = evidence.location as SkillHomeLocation

  return {
    kind: ABILITY_KIND.skill,
    body,
    location,
    ability: {
      name: body.name,
      title: fields.title,
      description: body.description,
      scope: location.scope,
      space: location.space,
      ...(evidence.availability ? { availability: evidence.availability } : {}),
      packageId: result.packageId,
      noteId: result.noteId,
    },
    locator: ownedSkillLocator(location, result.packageId),
    versionToken: result.versionToken,
  }
}

export class DurableAbilityCreator implements CustomAbilityCreator {
  private readonly now: () => Date
  private readonly operationId: () => string
  private readonly onError: (error: unknown, operation: AbilityCreateOperationRecord) => void
  private readonly projectionReleases = new Map<string, () => void>()

  constructor(private readonly options: DurableAbilityCreatorOptions) {
    this.now = options.now ?? (() => new Date())
    this.operationId = options.operationId ?? randomUUID
    this.onError =
      options.onError ??
      ((error, operation) =>
        console.error(
          `[ability-create] ${operation.id}/${operation.phase} ->`,
          (error as Error).message,
        ))
  }

  private async enterProjection(operation: AbilityCreateOperationRecord): Promise<void> {
    return this.enterProjectionAt(operation.id, operation.space)
  }

  private async enterProjectionAt(operationId: string, space: string): Promise<void> {
    if (this.projectionReleases.has(operationId) || !this.options.beginProjection) {
      return
    }
    this.projectionReleases.set(operationId, await this.options.beginProjection(space, operationId))
  }

  private releaseProjection(operationId: string): void {
    const release = this.projectionReleases.get(operationId)

    if (!release) {
      return
    }
    this.projectionReleases.delete(operationId)
    release()
  }

  async createDurably(
    input: Parameters<CustomAbilityCreator['createDurably']>[0],
  ): Promise<PublishedAbility> {
    const systemNamePolicy = input.operation?.systemNamePolicy ?? 'reject'
    const defaultLegacyRequestFingerprint = encodeJson({
      kind: input.prepared.kind,
      body: input.prepared.body,
      location: input.prepared.location,
      availability: input.prepared.availability ?? null,
    })
    const requestFingerprint = digest(
      input.operation?.requestFingerprint ??
        encodeJson({
          request: JSON.parse(defaultLegacyRequestFingerprint) as unknown,
          systemNamePolicy,
        }),
    )
    const legacyRequestFingerprint = digest(
      input.operation?.legacyRequestFingerprint ?? defaultLegacyRequestFingerprint,
    )
    const actorDigest = digest(input.prepared.principal.id)
    const idempotencyDigest = input.operation?.idempotencyKey
      ? digest(`${input.operation.scopeKey ?? ''}\0${input.operation.idempotencyKey}`)
      : null

    const replayCommitted = async (): Promise<PublishedAbility | null> => {
      if (!idempotencyDigest) {
        return null
      }
      const replay = await this.options.persistence.findReplay({
        actorDigest,
        idempotencyDigest,
        requestFingerprint,
      })

      if (replay.status === 'replayed') {
        return { ...(await this.resume(replay.operation)), replayed: true }
      }
      if (replay.status === 'idempotency-conflict') {
        const evidence = parsedEvidence(replay.operation)

        if (
          systemNamePolicy === 'reject' &&
          evidence.legacySystemNamePolicy &&
          replay.operation.requestFingerprint === legacyRequestFingerprint
        ) {
          return { ...(await this.resume(replay.operation)), replayed: true }
        }
        throw new AbilityUnavailableError('idempotency key belongs to a different ability create')
      }

      return null
    }
    const replay = await replayCommitted()

    if (replay) {
      return replay
    }
    const id = this.operationId()
    const createdAt = this.now().toISOString()

    const preparePackage = async () => {
      const next = await input.preparePackage()

      if (
        next.prepared.kind !== input.prepared.kind ||
        next.prepared.body.name !== input.prepared.body.name ||
        next.prepared.body.description !== input.prepared.body.description ||
        next.prepared.body.instructions !== input.prepared.body.instructions ||
        encodeJson(next.prepared.location) !== encodeJson(input.prepared.location) ||
        encodeJson(next.prepared.availability ?? null) !==
          encodeJson(input.prepared.availability ?? null)
      ) {
        throw new Error('deferred ability preparation changed immutable create fields')
      }

      return next
    }
    let publication

    try {
      publication = await preparePackage()
    } catch (error) {
      // A concurrent identical request can commit after our initial replay miss but
      // before mutable dependency resolution finishes. Its durable success still
      // owns the answer; only propagate the preparation failure when the second
      // lookup proves that no such operation won the race.
      const concurrentReplay = await replayCommitted()

      if (concurrentReplay) {
        return concurrentReplay
      }
      throw error
    }
    let pkg = publication.pkg
    let noteId = pkg.directoryName

    for (;;) {
      const prepared = publication.prepared
      const authority = await this.options.authorityForSpace(prepared.location.space)
      const targetPath = this.options.roles.manifestPath(prepared.location, pkg.directoryName)

      if (!authority || !targetPath || !authority.supportsRestartDurableStrict(targetPath)) {
        throw new AbilityUnavailableError(
          'restart-durable ability publication is unavailable for this placement',
        )
      }
      const manifest = pkg.files.get('SKILL.md')

      if (!manifest || pkg.files.size !== 1) {
        throw new Error('custom ability create requires one SKILL.md package')
      }
      const initial = analyzeDocumentState({
        source: manifest,
        role: DOCUMENT_ROLE.skillRoot,
        skillDirectoryName: pkg.directoryName,
        pathFallbackTitle: prepared.body.name,
      })
      const plan = planDocumentMutation(initial, {
        owners: {
          [STORAGE_OWNER_KEY.id]: noteId,
          [STORAGE_OWNER_KEY.created]: createdAt,
        },
      })
      const ownerClaims = plan.proposedOwnerProof.claims.map(({ key, ownership }) => ({
        key,
        ownership,
      }))
      const placeholder = bindStorageOwnerProof({
        source: plan.source,
        owners: ownerClaims,
        evidence: { kind: 'mutation-receipt', id },
        generatedContainer: plan.proposedOwnerProof.generatedContainer,
      })
      const state = analyzeDocumentState({
        source: plan.source,
        role: DOCUMENT_ROLE.skillRoot,
        skillDirectoryName: pkg.directoryName,
        pathFallbackTitle: prepared.body.name,
        ownerProof: placeholder,
      })

      if (!state.projection?.skill) {
        throw new Error('custom ability package became invalid while materializing identity')
      }
      const evidence: PreparedEvidence = {
        version: 1,
        kind: prepared.kind,
        body: prepared.body,
        location: prepared.location,
        ...(prepared.availability ? { availability: prepared.availability } : {}),
        packageId: pkg.directoryName,
        noteId,
        targetPath,
        createdAt,
        source: Buffer.from(plan.source).toString('base64'),
        versionToken: documentStateVersionToken(state),
        ownerClaims,
        generatedContainer: plan.proposedOwnerProof.generatedContainer === true,
        attribution: {
          principal: input.attribution.principal ?? prepared.principal.id,
          ...(input.attribution.agent ? { agent: input.attribution.agent } : {}),
        },
        systemNamePolicy,
      }
      const preparedEvidence = encodeJson(evidence)
      await this.enterProjectionAt(id, prepared.location.space)
      let accepted

      try {
        accepted = await this.options.persistence.accept({
          id,
          actorDigest,
          idempotencyDigest,
          requestFingerprint,
          space: prepared.location.space,
          packageId: pkg.directoryName,
          noteId,
          targetPath,
          availabilityRequired: prepared.availability != null,
          stageBinding: digest(`${actorDigest}\0${requestFingerprint}`),
          preparedEvidence,
          identity: {
            id: noteId,
            filePath: targetPath,
            space: prepared.location.space,
            createdAt,
            materialized: false,
            deletedAt: null,
            addressRevision: 1,
            legacyNameAliases: [],
          },
          availability: prepared.availability ?? null,
          createdAt,
        })
      } catch (error) {
        const durable = await this.options.persistence.get(id).catch(() => null)

        if (durable && durable.phase !== ABILITY_CREATE_PHASE.rejected) {
          return this.resume(durable)
        }
        this.releaseProjection(id)
        throw error
      }

      if (accepted.status === 'replayed') {
        this.releaseProjection(id)
        return { ...(await this.resume(accepted.operation)), replayed: true }
      }
      if (accepted.status === 'idempotency-conflict') {
        this.releaseProjection(id)
        throw new AbilityUnavailableError('idempotency key belongs to a different ability create')
      }
      if (accepted.status === 'identity-conflict') {
        this.releaseProjection(id)
        noteId = freshNoteId()
        continue
      }
      if (accepted.status === 'path-conflict' || accepted.status === 'package-conflict') {
        this.releaseProjection(id)
        publication = await preparePackage()
        pkg = publication.pkg
        noteId = pkg.directoryName
        continue
      }
      if (accepted.status !== 'accepted') {
        this.releaseProjection(id)
        throw new Error(`unsupported ability create acceptance: ${accepted.status}`)
      }

      return this.resume(accepted.operation)
    }
  }

  async recover(): Promise<void> {
    const reopened = new Set<SpaceResourceAuthority>()
    const recovered: AbilityCreateOperationRecord[] = []

    for (const operation of await this.options.persistence.listRecoverable()) {
      const authority = await this.options.authorityForSpace(operation.space)

      if (!authority) {
        throw new Error(`ability create recovery has no authority for ${operation.space}`)
      }
      if (!reopened.has(authority)) {
        await authority.closeAdmission({ owner: 'ability-create-recovery' })
        reopened.add(authority)
      }
      await this.resume(operation, true)
      recovered.push(operation)
    }
    for (const authority of reopened) {
      if (!authority.diagnostics().length) {
        authority.reopenAdmission()
      }
    }
    // Recovery deliberately closes fresh resource admission while it settles every
    // accepted operation in a space. Reconciliation performs ordinary exact reads,
    // so running it inside resume() would race those reads against the still-closed
    // authority and record an anonymous external gap. Reopen first, then project
    // each recovered identity; terminal metadata already owns the result.
    for (const operation of recovered) {
      try {
        await this.options.reconcile(operation.space, operation.noteId)
      } catch (error) {
        this.onError(error, operation)
      }
    }
  }

  private async resume(
    initial: AbilityCreateOperationRecord,
    recovery = false,
  ): Promise<PublishedAbility> {
    const operation = (await this.options.persistence.get(initial.id)) ?? initial
    const evidence = parsedEvidence(operation)
    const authority = await this.options.authorityForSpace(operation.space)

    if (!authority) {
      throw new Error(`ability create has no authority for ${operation.space}`)
    }
    if (operation.phase === ABILITY_CREATE_PHASE.rejected) {
      throw new AbilityUnavailableError(operation.failureCode ?? 'ability create was rejected')
    }
    if (operation.phase === ABILITY_CREATE_PHASE.succeeded) {
      return this.completeMetadata(operation, evidence, authority, recovery)
    }
    const ref = {
      operationId: operation.id,
      binding: operation.stageBinding,
      path: operation.targetPath,
      packagePath: directoryOf(operation.targetPath),
    }
    let state = await authority.inspectStrict(ref)

    try {
      if (state.status === 'missing') {
        const observation = await authority.observe(operation.targetPath, {
          owner: 'ability-create-stage',
          packagePath: directoryOf(operation.targetPath),
          allowDuringClosure: true,
        })

        if (observation.kind !== 'absent') {
          await this.options.persistence.reject(
            operation.id,
            'physical-target-changed',
            this.now().toISOString(),
          )
          throw new AbilityUnavailableError('ability package target is occupied')
        }
        const staged = await authority.stageStrict({
          ...ref,
          content: Uint8Array.from(Buffer.from(evidence.source, 'base64')),
          expected: observation.claim,
        })

        if (staged.status === 'idempotency-conflict') {
          throw new Error('ability create strict stage has an idempotency conflict')
        }
        state = staged.state
      }
      const stagedState = state as Exclude<ResourceStrictStageState, { status: 'missing' }>

      const finish = async () => {
        try {
          return await this.publishAndCommit(
            operation,
            evidence,
            authority,
            ref,
            stagedState,
            recovery,
          )
        } catch (error) {
          const observed = await authority.inspectStrict(ref).catch(() => null)

          if (
            observed?.status === 'publishing' ||
            observed?.status === 'published' ||
            observed?.status === 'failed-recoverable'
          ) {
            void authority
              .closeAdmission({ owner: 'ability-create-failure' })
              .catch((closeError) => this.onError(closeError, operation))
          }
          throw error
        }
      }
      await this.enterProjection(operation)
      const terminal = recovery
        ? await finish()
        : await this.options.roles.withCreateAdmission(
            evidence.location,
            evidence.packageId,
            finish,
            { allowDuringClosure: true },
          )
      return this.settleCommitted(
        terminal.operation,
        evidence,
        authority,
        terminal.result,
        recovery,
      )
    } catch (error) {
      const durable = await this.options.persistence.get(operation.id)

      if (
        durable?.phase === ABILITY_CREATE_PHASE.metadataCommitted ||
        durable?.phase === ABILITY_CREATE_PHASE.succeeded
      ) {
        return this.completeMetadata(durable, evidence, authority, recovery)
      }
      const observed = await authority.inspectStrict(ref).catch(() => null)
      const postEffect =
        operation.physicalReceipt != null ||
        observed?.status === 'publishing' ||
        observed?.status === 'published' ||
        observed?.status === 'failed-recoverable'

      if (!postEffect && observed?.status === 'missing') {
        await this.options.persistence.reject(
          operation.id,
          'pre-publication-failure',
          this.now().toISOString(),
        )
        await this.options.releaseIdentity?.(operation.space, operation.noteId)
        this.releaseProjection(operation.id)
      } else {
        await this.options.persistence.markRecoverable(
          operation.id,
          (error as Error).message || 'ability-create-failed',
          this.now().toISOString(),
        )
        if (!recovery) {
          await authority.closeAdmission({ owner: 'ability-create-failure' })
        }
      }
      this.onError(error, operation)
      throw error
    }
  }

  private async publishAndCommit(
    initial: AbilityCreateOperationRecord,
    evidence: PreparedEvidence,
    authority: SpaceResourceAuthority,
    ref: ResourceStrictStageRef,
    state: Exclude<ResourceStrictStageState, { status: 'missing' }>,
    recovery: boolean,
  ) {
    let operation = initial
    let receipt: StrictMutationReceipt

    const systemNameConflict =
      state.status === 'staged' &&
      evidence.systemNamePolicy === 'reject' &&
      (await this.options.roles.hasSystemAbility(evidence.kind, evidence.body.name))
    const ownedNameConflict =
      state.status === 'staged' &&
      !systemNameConflict &&
      (await this.options.roles.hasOwnedAbilityAt(evidence.location, evidence.body.name, {
        allowDuringClosure: true,
      }))

    if (systemNameConflict || ownedNameConflict) {
      await authority.discardStrict(ref)
      await this.options.persistence.reject(
        operation.id,
        systemNameConflict ? 'system-ability-name-conflict' : 'ability-name-conflict',
        this.now().toISOString(),
      )
      if (systemNameConflict) {
        throw new SystemAbilityNameConflictError(
          `${evidence.kind} "${evidence.body.name}" conflicts with a System ability`,
        )
      }
      throw evidence.kind === ABILITY_KIND.role
        ? new RoleAlreadyExistsError(
            `role "${evidence.body.name}" already exists in ${evidence.location.scope}`,
          )
        : new SkillAlreadyExistsError(
            `skill "${evidence.body.name}" already exists in ${evidence.location.scope}`,
          )
    }
    await this.options.primeIdentity?.(operation.space, {
      id: operation.noteId,
      filePath: operation.targetPath,
      space: operation.space,
      createdAt: evidence.createdAt,
      materialized: false,
      deletedAt: null,
      addressRevision: 1,
      legacyNameAliases: [],
    })
    if (state.status === 'published') {
      receipt = state.receipt
    } else {
      const publication = recovery
        ? await authority.publishStrict(ref, { owner: 'ability-create-recovery', recovery: true })
        : await authority.publishStrictAdmitted(ref)

      if (publication.status === 'conflict') {
        await authority.discardStrict(ref)
        await this.options.persistence.reject(
          operation.id,
          'physical-target-changed',
          this.now().toISOString(),
        )
        throw new AbilityUnavailableError('ability package target changed before publication')
      }
      if (publication.status === 'failed-recoverable') {
        throw new Error(publication.reason)
      }
      receipt = publication.receipt
    }
    operation =
      (await this.options.persistence.markPhysical(
        operation.id,
        operation.preparedEvidence,
        encodeJson(receipt),
        this.now().toISOString(),
      )) ?? operation
    const provisional = stateOf(operation, evidence)
    const finalState = (await this.adoptPublication(operation, evidence)) ?? provisional.state

    if (!finalState.projection?.skill) {
      throw new Error('adopted ability publication changed its document identity')
    }
    const { source, proof } = provisional
    const fields = projectionFields(finalState)
    const content = encodeDocumentState(finalState)
    const committedAt = this.now().toISOString()
    const terminal = await this.options.persistence.commit({
      operationId: operation.id,
      preparedEvidence: operation.preparedEvidence,
      physicalReceipt: operation.physicalReceipt!,
      identity: {
        id: operation.noteId,
        filePath: operation.targetPath,
        space: operation.space,
        createdAt: evidence.createdAt,
        materialized: true,
        deletedAt: null,
        addressRevision: 1,
        legacyNameAliases: [],
      },
      revision: {
        noteId: operation.noteId,
        space: operation.space,
        baseRevisionId: null,
        expectedHeadRevisionId: null,
        theirRevisionId: null,
        sourceRevisionId: null,
        kind: REVISION_KIND.write,
        entryRole: REVISION_ENTRY_ROLE.origin,
        principal: evidence.attribution.principal,
        agent: evidence.attribution.agent,
        contentHash: await sha256Hex(content),
        semanticFingerprint: finalState.semanticFingerprint,
        stateFormat: finalState.format,
        restoreSafety: finalState.restoreSafety.status,
        title: fields.title,
        class: NOTE_CLASS.skill,
        slug: fields.slug,
        tags: fields.tags,
        createdAt: committedAt,
        charsAdded: new TextDecoder().decode(source).length,
        charsRemoved: 0,
      },
      content,
      ownerProof: {
        sourceHash: await sha256Hex(source),
        proofJson: encodeJson(proof satisfies StorageOwnerProof),
        receiptId: operation.id,
      },
      result: {
        packageId: operation.packageId,
        noteId: operation.noteId,
        versionToken: documentStateVersionToken(finalState),
      },
      committedAt,
    })

    if (terminal.status === 'conflict') {
      throw new Error('ability create terminal evidence changed')
    }

    return terminal
  }

  private async completeMetadata(
    operation: AbilityCreateOperationRecord,
    evidence: PreparedEvidence,
    authority: SpaceResourceAuthority,
    strictProjection: boolean,
  ): Promise<PublishedAbility> {
    const result = resultOf(operation)
    const alreadyAdopted = this.projectionReleases.has(operation.id)

    if (!alreadyAdopted) {
      await this.enterProjection(operation)
      try {
        await this.adoptPublication(operation, evidence)
      } catch (error) {
        if (strictProjection) {
          throw error
        }
        this.onError(error, operation)
      }
    }

    return this.settleCommitted(operation, evidence, authority, result, strictProjection)
  }

  private async settleCommitted(
    operation: AbilityCreateOperationRecord,
    evidence: PreparedEvidence,
    authority: SpaceResourceAuthority,
    result: AbilityCreateTerminalResult,
    deferReconcile = false,
  ): Promise<PublishedAbility> {
    let current = operation

    try {
      await this.options.confirmIdentity?.(operation.space, operation.noteId)
    } catch (error) {
      this.onError(error, operation)
    }
    // Confirmation is part of the protected causal projection. Finalize, strict-stage
    // cleanup and reconcile may re-enter their own mutation/resource seams, so the
    // global claim must be released before them (the same no-recursion rule as writes).
    this.releaseProjection(operation.id)
    if (operation.phase !== ABILITY_CREATE_PHASE.succeeded) {
      try {
        current =
          (await this.options.persistence.finalize(
            operation.id,
            operation.preparedEvidence,
            operation.physicalReceipt!,
            this.now().toISOString(),
          )) ?? operation
      } catch (error) {
        this.onError(error, operation)
      }
    }
    try {
      await authority.discardStrict({
        operationId: operation.id,
        binding: operation.stageBinding,
        path: operation.targetPath,
        packagePath: directoryOf(operation.targetPath),
      })
    } catch (error) {
      this.onError(error, operation)
    }
    this.options.wakeOutbox?.()
    if (!deferReconcile) {
      try {
        await this.options.reconcile(operation.space, operation.noteId)
      } catch (error) {
        this.onError(error, operation)
      }
    }

    return publishedOf(current, evidence, result)
  }

  private async adoptPublication(
    operation: AbilityCreateOperationRecord,
    evidence: PreparedEvidence,
  ): Promise<DocumentState | undefined> {
    if (!this.options.adoptPublication || !operation.physicalReceipt) {
      return undefined
    }
    const receipt = JSON.parse(operation.physicalReceipt) as StrictMutationReceipt
    const { source, proof } = stateOf(operation, evidence)

    if (
      receipt.operationId !== operation.id ||
      receipt.binding !== operation.stageBinding ||
      typeof receipt.semanticEventTime !== 'string' ||
      typeof receipt.candidateHash !== 'string' ||
      !Array.isArray(receipt.transitions)
    ) {
      throw new Error(`ability create operation ${operation.id} has invalid physical receipt`)
    }

    return this.options.adoptPublication(operation.space, {
      path: operation.targetPath,
      source,
      ownerProof: proof,
      document: {
        role: DOCUMENT_ROLE.skillRoot,
        pathFallbackTitle: evidence.body.name,
        skillDirectoryName: evidence.packageId,
      },
      identity: {
        id: operation.noteId,
        filePath: operation.targetPath,
        space: operation.space,
        createdAt: evidence.createdAt,
        materialized: false,
        deletedAt: null,
        addressRevision: 1,
        legacyNameAliases: [],
      },
      receipt: {
        id: operation.id,
        semanticEventTime: receipt.semanticEventTime,
        candidateHash: receipt.candidateHash,
        transitions: receipt.transitions,
      },
    })
  }
}
