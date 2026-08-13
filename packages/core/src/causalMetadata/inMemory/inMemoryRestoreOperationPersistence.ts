import {
  RESTORE_OPERATION_PHASE,
  type RestoreOperationAcceptance,
  type RestoreOperationPersistence,
  type RestoreOperationRecord,
  type RestoreOperationTransition,
  SPACE_LIFECYCLE_PHASE,
  type SpaceLifecyclePersistence,
} from '../types'

const cloneOperation = (operation: RestoreOperationRecord): RestoreOperationRecord => ({
  ...operation,
})

const terminalOperation = (phase: RestoreOperationRecord['phase']): boolean =>
  phase === RESTORE_OPERATION_PHASE.succeeded || phase === RESTORE_OPERATION_PHASE.rejected

type PurgeProtection = {
  protectFromPurge(space: string, noteIds: readonly string[]): void
  releasePurgeProtection(space: string, noteIds: readonly string[]): void
}

export class InMemoryRestoreOperationPersistence implements RestoreOperationPersistence {
  private readonly byId = new Map<string, RestoreOperationRecord>()
  private readonly byReplay = new Map<string, string>()
  private readonly protectedByOperation = new Map<
    string,
    { space: string; noteIds: readonly string[] }
  >()

  constructor(
    private readonly lifecycle: SpaceLifecyclePersistence,
    private readonly purgeProtection?: PurgeProtection,
  ) {}

  async init(): Promise<void> {}

  async accept(input: RestoreOperationAcceptance) {
    const lifecycle = this.lifecycle as SpaceLifecyclePersistence & {
      withExclusive?<T>(task: () => Promise<T>): Promise<T>
    }

    return lifecycle.withExclusive
      ? lifecycle.withExclusive(() => this.acceptUnlocked(input))
      : this.acceptUnlocked(input)
  }

  private async acceptUnlocked(input: RestoreOperationAcceptance) {
    const replay = `${input.actorDigest}\0${input.endpoint}\0${input.idempotencyDigest}`
    const existingId = this.byReplay.get(replay)

    if (existingId) {
      const operation = cloneOperation(this.byId.get(existingId)!)

      return operation.requestFingerprint === input.requestFingerprint
        ? ({ status: 'replayed', operation } as const)
        : ({ status: 'idempotency-conflict', operation } as const)
    }
    if (this.byId.has(input.id)) {
      throw new Error(`restore operation id already exists: ${input.id}`)
    }
    if (input.parentOperationId) {
      const parent = this.byId.get(input.parentOperationId)

      if (!parent || parent.space !== input.space || terminalOperation(parent.phase)) {
        throw new Error('restore child has no accepted bulk parent')
      }
    } else if ((await this.lifecycle.get(input.space))?.phase !== SPACE_LIFECYCLE_PHASE.active) {
      throw new Error('space lifecycle rejects restore admission')
    }
    const protectedNoteIds = [...new Set(input.protectedNoteIds ?? [input.noteId])]
    const accepted = { ...input }
    delete accepted.parentOperationId
    delete accepted.protectedNoteIds
    const operation: RestoreOperationRecord = {
      ...accepted,
      phase: RESTORE_OPERATION_PHASE.staged,
      expectedHeadRevisionId: null,
      physicalReceipt: null,
      terminalResult: null,
      failureCode: null,
      updatedAt: input.createdAt,
    }

    this.byId.set(operation.id, operation)
    this.byReplay.set(replay, operation.id)
    this.protectedByOperation.set(operation.id, {
      space: operation.space,
      noteIds: protectedNoteIds,
    })
    this.purgeProtection?.protectFromPurge(operation.space, protectedNoteIds)
    return { status: 'accepted', operation: cloneOperation(operation) } as const
  }

  async get(id: string): Promise<RestoreOperationRecord | null> {
    return this.getForRestoreTerminal(id)
  }

  getForRestoreTerminal(id: string): RestoreOperationRecord | null {
    const operation = this.byId.get(id)
    return operation ? cloneOperation(operation) : null
  }

  async getByReplay(
    actorDigest: string,
    endpoint: string,
    idempotencyDigest: string,
  ): Promise<RestoreOperationRecord | null> {
    const id = this.byReplay.get(`${actorDigest}\0${endpoint}\0${idempotencyDigest}`)
    return id ? cloneOperation(this.byId.get(id)!) : null
  }

  async transition(input: RestoreOperationTransition) {
    return this.transitionForRestoreTerminal(input)
  }

  transitionForRestoreTerminal(input: RestoreOperationTransition) {
    const operation = this.byId.get(input.id)

    if (!operation) {
      return { status: 'missing' } as const
    }
    if (
      !input.expectedPhases.includes(operation.phase) ||
      (input.expectedPreparedEvidence !== undefined &&
        operation.preparedEvidence !== input.expectedPreparedEvidence)
    ) {
      return { status: 'phase-conflict', operation: cloneOperation(operation) } as const
    }
    const updated: RestoreOperationRecord = {
      ...operation,
      phase: input.phase,
      updatedAt: input.updatedAt,
      ...(input.sourceRevisionId !== undefined ? { sourceRevisionId: input.sourceRevisionId } : {}),
      ...(input.expectedHeadRevisionId !== undefined
        ? { expectedHeadRevisionId: input.expectedHeadRevisionId }
        : {}),
      ...(input.targetPath !== undefined ? { targetPath: input.targetPath } : {}),
      ...(input.preparedEvidence !== undefined ? { preparedEvidence: input.preparedEvidence } : {}),
      ...(input.physicalReceipt !== undefined ? { physicalReceipt: input.physicalReceipt } : {}),
      ...(input.terminalResult !== undefined ? { terminalResult: input.terminalResult } : {}),
      ...(input.failureCode !== undefined ? { failureCode: input.failureCode } : {}),
    }

    this.byId.set(updated.id, updated)

    if (terminalOperation(updated.phase) && !terminalOperation(operation.phase)) {
      const protection = this.protectedByOperation.get(updated.id)

      if (protection) {
        this.purgeProtection?.releasePurgeProtection(protection.space, protection.noteIds)
      }
      this.protectedByOperation.delete(updated.id)
    }

    return { status: 'transitioned', operation: cloneOperation(updated) } as const
  }

  snapshotForRestoreTerminal() {
    return {
      byId: new Map([...this.byId].map(([id, operation]) => [id, cloneOperation(operation)])),
      byReplay: new Map(this.byReplay),
      protectedByOperation: new Map(
        [...this.protectedByOperation].map(([id, protection]) => [
          id,
          { ...protection, noteIds: [...protection.noteIds] },
        ]),
      ),
    }
  }

  restoreForRestoreTerminal(snapshot: ReturnType<this['snapshotForRestoreTerminal']>): void {
    this.byId.clear()
    this.byReplay.clear()
    this.protectedByOperation.clear()
    for (const [id, operation] of snapshot.byId) {
      this.byId.set(id, cloneOperation(operation))
    }
    for (const [key, id] of snapshot.byReplay) {
      this.byReplay.set(key, id)
    }
    for (const [id, protection] of snapshot.protectedByOperation) {
      this.protectedByOperation.set(id, {
        ...protection,
        noteIds: [...protection.noteIds],
      })
    }
  }

  async listRecoverable(space?: string): Promise<RestoreOperationRecord[]> {
    return [...this.byId.values()]
      .filter((operation) => !terminalOperation(operation.phase))
      .filter((operation) => space == null || operation.space === space)
      .sort((left, right) =>
        left.createdAt === right.createdAt
          ? left.id.localeCompare(right.id)
          : left.createdAt.localeCompare(right.createdAt),
      )
      .map(cloneOperation)
  }
}
