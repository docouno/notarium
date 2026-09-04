import { randomUUID } from 'node:crypto'

import {
  RESTORE_OPERATION_PHASE,
  type RestoreOperationRecord,
  REVISION_RESTORE_AVAILABILITY,
  SPACE_LIFECYCLE_PHASE,
  type TrashEntry,
} from '@notarium/core'

import { can, type Principal } from '../authz'
import type { InstallationReplayKey } from '../installationReplayKey'
import type { MetaDb } from '../metaDb'
import type { SpaceManager } from '../spaces'
import type { RestoreCommandResult, RestoreCoordinator } from './restoreCoordinator'

const ENDPOINT = 'trash-restore-many'
const DISPATCH_LIMIT = 25

type BulkSelection =
  { mode: 'ids'; ids: string[] } | { mode: 'all'; q: string | null; onlyRestorable: boolean }

export type BulkRestoreCommand = {
  principal: Principal
  space: string
  idempotencyKey: string
  ids?: readonly string[]
  all?: boolean
  q?: string
  onlyRestorable?: boolean
}

export type BulkRestoreItemResult =
  | { id: string; revisionId: string | null; status: 'queued' }
  | {
      id: string
      revisionId: string
      status: 'pending'
      operationId: string
      phase: 'staged' | 'prepared' | 'physical-published' | 'failed-recoverable'
    }
  | {
      id: string
      revisionId: string
      status: 'succeeded'
      operationId: string
      restoredRevisionId: string
      filePath: string
      versionToken: string
    }
  | {
      id: string
      revisionId: string | null
      status: 'conflict'
      operationId?: string
      reason: string
    }
  | {
      id: string
      revisionId: string
      status: 'not-restorable'
      operationId: string
      reason: string
    }

export type BulkRestoreProgress = {
  status: 'running' | 'completed'
  operationId: string
  items: BulkRestoreItemResult[]
  counts: {
    total: number
    queued: number
    pending: number
    succeeded: number
    conflict: number
    notRestorable: number
  }
}

export type BulkRestoreResult =
  | BulkRestoreProgress
  | { status: 'conflict'; operationId: string; reason: 'idempotency-conflict' }
  | { status: 'busy'; reason: string }

type BulkEvidence = {
  version: 1
  kind: 'trash-restore-many'
  principalId: string
  space: string
  selection: BulkSelection
  items: BulkRestoreItemResult[]
}

type BulkRestoreCoordinatorOptions = {
  metaDb: MetaDb
  replayKey: InstallationReplayKey
  single: Pick<RestoreCoordinator, 'execute'>
  spaces: Pick<SpaceManager, 'resumeLifecycle'>
  rosterForSelection(input: { space: string; selection: BulkSelection }): Promise<TrashEntry[]>
  now?: () => Date
  operationId?: () => string
}

const normalizeSelection = (input: BulkRestoreCommand): BulkSelection => {
  const ids = [...new Set((input.ids ?? []).filter(Boolean))]

  return ids.length
    ? { mode: 'ids', ids }
    : {
        mode: 'all',
        q: input.q?.trim() || null,
        onlyRestorable: input.onlyRestorable === true,
      }
}

const canonicalRequest = (space: string, selection: BulkSelection): string =>
  JSON.stringify({ space, selection })

const parseEvidence = (operation: RestoreOperationRecord): BulkEvidence => {
  let value: Partial<BulkEvidence> | null = null

  try {
    value = operation.preparedEvidence
      ? (JSON.parse(operation.preparedEvidence) as Partial<BulkEvidence>)
      : null
  } catch (error) {
    throw new Error(`bulk restore ${operation.id} has malformed evidence`, { cause: error })
  }
  if (
    !value ||
    value.version !== 1 ||
    value.kind !== ENDPOINT ||
    typeof value.principalId !== 'string' ||
    value.space !== operation.space ||
    !value.selection ||
    !Array.isArray(value.items)
  ) {
    throw new Error(`bulk restore ${operation.id} has invalid evidence`)
  }

  return value as BulkEvidence
}

const terminalItem = (item: BulkRestoreItemResult): boolean =>
  item.status === 'succeeded' || item.status === 'conflict' || item.status === 'not-restorable'

const countsOf = (items: readonly BulkRestoreItemResult[]): BulkRestoreProgress['counts'] => ({
  total: items.length,
  queued: items.filter((item) => item.status === 'queued').length,
  pending: items.filter((item) => item.status === 'pending').length,
  succeeded: items.filter((item) => item.status === 'succeeded').length,
  conflict: items.filter((item) => item.status === 'conflict').length,
  notRestorable: items.filter((item) => item.status === 'not-restorable').length,
})

const progressOf = (
  operation: RestoreOperationRecord,
  evidence: BulkEvidence,
): BulkRestoreProgress => ({
  status: evidence.items.every(terminalItem) ? 'completed' : 'running',
  operationId: operation.id,
  items: evidence.items,
  counts: countsOf(evidence.items),
})

const recoveryPrincipal = (id: string): Principal => ({
  id,
  userId: null,
  username: null,
  admin: false,
  scope: 'write',
  grants: new Map(),
  spaces: null,
  system: true,
})

const itemFromSingle = (
  id: string,
  revisionId: string,
  result: RestoreCommandResult,
): BulkRestoreItemResult | null => {
  if (result.status === 'succeeded') {
    return {
      id,
      revisionId,
      status: 'succeeded',
      operationId: result.operationId,
      restoredRevisionId: result.revisionId,
      filePath: result.filePath,
      versionToken: result.versionToken,
    }
  }
  if (result.status === 'pending') {
    return {
      id,
      revisionId,
      status: 'pending',
      operationId: result.operationId,
      phase: result.phase,
    }
  }
  if (result.status === 'conflict') {
    return {
      id,
      revisionId,
      status: 'conflict',
      operationId: result.operationId,
      reason: result.reason,
    }
  }
  if (result.status === 'not-restorable') {
    return {
      id,
      revisionId,
      status: 'not-restorable',
      operationId: result.operationId,
      reason: result.reason,
    }
  }
  if (result.status === 'not-found') {
    return { id, revisionId, status: 'conflict', reason: 'note_not_in_trash' }
  }

  return null
}

export class BulkRestoreCoordinator {
  private readonly metaDb: MetaDb
  private readonly replayKey: InstallationReplayKey
  private readonly single: Pick<RestoreCoordinator, 'execute'>
  private readonly spaces: Pick<SpaceManager, 'resumeLifecycle'>
  private readonly rosterForSelection: BulkRestoreCoordinatorOptions['rosterForSelection']
  private readonly now: () => Date
  private readonly operationId: () => string

  constructor(options: BulkRestoreCoordinatorOptions) {
    this.metaDb = options.metaDb
    this.replayKey = options.replayKey
    this.single = options.single
    this.spaces = options.spaces
    this.rosterForSelection = options.rosterForSelection
    this.now = options.now ?? (() => new Date())
    this.operationId = options.operationId ?? randomUUID
  }

  async execute(input: BulkRestoreCommand): Promise<BulkRestoreResult> {
    const selection = normalizeSelection(input)
    const canonical = canonicalRequest(input.space, selection)
    const candidates = await this.replayKey.digestCandidateBundles([
      { domain: 'restore-actor', value: input.principal.id },
      { domain: `restore-idempotency:${ENDPOINT}`, value: input.idempotencyKey },
      { domain: `restore-request:${ENDPOINT}`, value: canonical },
    ])

    for (const [actorDigest, idempotencyDigest, requestFingerprint] of candidates) {
      const existing = await this.metaDb.restoreOperations.getByReplay(
        actorDigest,
        ENDPOINT,
        idempotencyDigest,
      )

      if (!existing) {
        continue
      }
      if (!can(input.principal, 'space:write', { space: existing.space })) {
        return { status: 'busy', reason: 'space-not-active' }
      }
      if (existing.requestFingerprint !== requestFingerprint) {
        return { status: 'conflict', operationId: existing.id, reason: 'idempotency-conflict' }
      }

      return this.resume(existing)
    }

    if (!can(input.principal, 'space:write', { space: input.space })) {
      return { status: 'busy', reason: 'space-not-active' }
    }
    const lifecycle = await this.metaDb.spaceLifecycle.get(input.space)

    if (lifecycle?.phase !== SPACE_LIFECYCLE_PHASE.active) {
      return { status: 'busy', reason: 'space-not-active' }
    }
    let selected: TrashEntry[]

    try {
      selected = await this.rosterForSelection({ space: input.space, selection })
    } catch {
      return { status: 'busy', reason: 'bulk-roster-unavailable' }
    }
    const byId = new Map(selected.map((item) => [item.noteId, item]))
    const roster =
      selection.mode === 'ids'
        ? selection.ids.map((id): BulkRestoreItemResult => {
            const item = byId.get(id)

            return item
              ? { id, revisionId: item.revisionId, status: 'queued' }
              : { id, revisionId: null, status: 'conflict', reason: 'note_not_in_trash' }
          })
        : selected
            .filter(
              (item) =>
                !selection.onlyRestorable ||
                item.restoreAvailability === REVISION_RESTORE_AVAILABILITY.full ||
                item.restoreAvailability === REVISION_RESTORE_AVAILABILITY.partial,
            )
            .map((item) => ({
              id: item.noteId,
              revisionId: item.revisionId,
              status: 'queued' as const,
            }))
    const id = this.operationId()
    const [actorDigest, idempotencyDigest, requestFingerprint, stageBinding] =
      await this.replayKey.digestBundle([
        { domain: 'restore-actor', value: input.principal.id },
        { domain: `restore-idempotency:${ENDPOINT}`, value: input.idempotencyKey },
        { domain: `restore-request:${ENDPOINT}`, value: canonical },
        { domain: 'restore-stage', value: `${id}\0${canonical}` },
      ])
    const evidence: BulkEvidence = {
      version: 1,
      kind: ENDPOINT,
      principalId: input.principal.id,
      space: input.space,
      selection,
      items: roster,
    }
    let accepted

    try {
      accepted = await this.metaDb.restoreOperations.accept({
        id,
        space: input.space,
        noteId: `@bulk:${id}`,
        endpoint: ENDPOINT,
        actorDigest,
        idempotencyDigest,
        requestFingerprint,
        stageBinding,
        sourceRevisionId: 'bulk-roster',
        targetPath: '@bulk',
        preparedEvidence: JSON.stringify(evidence),
        protectedNoteIds: roster.filter((item) => item.status === 'queued').map((item) => item.id),
        createdAt: this.now().toISOString(),
      })
    } catch {
      return { status: 'busy', reason: 'bulk-admission-unavailable' }
    }
    if (accepted.status === 'idempotency-conflict') {
      return {
        status: 'conflict',
        operationId: accepted.operation.id,
        reason: 'idempotency-conflict',
      }
    }

    return this.resume(accepted.operation)
  }

  async recover(): Promise<void> {
    for (const operation of await this.metaDb.restoreOperations.listRecoverable()) {
      if (operation.endpoint === ENDPOINT) {
        await this.resume(operation, Number.POSITIVE_INFINITY)
      }
    }
  }

  private async resume(
    initial: RestoreOperationRecord,
    dispatchLimit = DISPATCH_LIMIT,
  ): Promise<BulkRestoreProgress> {
    if (initial.phase === RESTORE_OPERATION_PHASE.succeeded) {
      return JSON.parse(initial.terminalResult!) as BulkRestoreProgress
    }
    let operation = initial
    let evidence = parseEvidence(operation)
    let dispatched = 0

    for (let index = 0; index < evidence.items.length && dispatched < dispatchLimit; index++) {
      const item = evidence.items[index]

      if (terminalItem(item)) {
        continue
      }
      if (item.revisionId == null) {
        evidence.items[index] = {
          id: item.id,
          revisionId: null,
          status: 'conflict',
          reason: 'note_not_in_trash',
        }
      } else {
        const single = await this.single.execute(
          {
            mode: 'trash',
            principal: recoveryPrincipal(evidence.principalId),
            space: evidence.space,
            noteId: item.id,
            revisionId: item.revisionId,
            idempotencyKey: `bulk:${operation.id}:${index}`,
          },
          { acceptedByParentOperationId: operation.id },
        )
        const next = itemFromSingle(item.id, item.revisionId, single)

        if (next == null) {
          break
        }
        evidence.items[index] = next
      }
      dispatched++
      const raw = JSON.stringify(evidence)
      const transition = await this.metaDb.restoreOperations.transition({
        id: operation.id,
        expectedPhases: [RESTORE_OPERATION_PHASE.staged],
        expectedPreparedEvidence: operation.preparedEvidence,
        phase: RESTORE_OPERATION_PHASE.staged,
        preparedEvidence: raw,
        updatedAt: this.now().toISOString(),
      })

      if (transition.status === 'missing') {
        throw new Error(`bulk restore ${operation.id} disappeared`)
      }
      operation = transition.operation
      if (operation.phase === RESTORE_OPERATION_PHASE.succeeded) {
        return JSON.parse(operation.terminalResult!) as BulkRestoreProgress
      }
      evidence = parseEvidence(operation)
    }
    let progress = progressOf(operation, evidence)

    if (progress.status === 'completed') {
      const terminalResult = JSON.stringify(progress)
      const terminal = await this.metaDb.restoreOperations.transition({
        id: operation.id,
        expectedPhases: [RESTORE_OPERATION_PHASE.staged],
        expectedPreparedEvidence: operation.preparedEvidence,
        phase: RESTORE_OPERATION_PHASE.succeeded,
        terminalResult,
        updatedAt: this.now().toISOString(),
      })

      if (terminal.status === 'missing') {
        throw new Error(`bulk restore ${operation.id} disappeared at completion`)
      }
      operation = terminal.operation
      progress =
        operation.phase === RESTORE_OPERATION_PHASE.succeeded
          ? (JSON.parse(operation.terminalResult!) as BulkRestoreProgress)
          : progressOf(operation, parseEvidence(operation))
      if (progress.status === 'completed') {
        await this.spaces.resumeLifecycle(operation.space)
      }
    }

    return progress
  }
}
