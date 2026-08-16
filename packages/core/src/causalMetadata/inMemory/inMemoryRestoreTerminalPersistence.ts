import { unionLegacyNameAliases } from '../../identity'
import type { IdentityRecord } from '../../knowledgeStore'
import type { InMemoryRevisionPersistence } from '../../revisionJournal/inMemoryRevisionPersistence'
import {
  RESTORE_OPERATION_PHASE,
  RESTORE_TERMINAL_CONFLICT,
  type RestoreTerminalCommit,
  type RestoreTerminalFinalize,
  type RestoreTerminalPersistence,
  type RestoreTerminalResult,
} from '../types'
import type { InMemoryCausalOutboxPersistence } from './inMemoryCausalOutboxPersistence'
import type { InMemoryOwnerProofPersistence } from './inMemoryOwnerProofPersistence'
import type { InMemoryRestoreOperationPersistence } from './inMemoryRestoreOperationPersistence'
import type { InMemorySpaceLifecyclePersistence } from './inMemorySpaceLifecyclePersistence'

export type InMemoryRestoreTerminalDependencies = {
  operations: InMemoryRestoreOperationPersistence
  lifecycle: InMemorySpaceLifecyclePersistence
  revisions: InMemoryRevisionPersistence
  ownerProofs: InMemoryOwnerProofPersistence
  outbox: InMemoryCausalOutboxPersistence
}

const copyIdentity = (record: IdentityRecord): IdentityRecord => ({
  ...record,
  legacyNameAliases: [...record.legacyNameAliases],
})

const parseResult = (raw: string | null, operationId: string): RestoreTerminalResult => {
  if (!raw) {
    throw new Error(`succeeded restore operation has no terminal result: ${operationId}`)
  }
  const parsed = JSON.parse(raw) as RestoreTerminalResult

  if (
    typeof parsed.noteId !== 'string' ||
    typeof parsed.filePath !== 'string' ||
    typeof parsed.revisionId !== 'string' ||
    typeof parsed.versionToken !== 'string'
  ) {
    throw new Error(`succeeded restore operation has an invalid terminal result: ${operationId}`)
  }

  return parsed
}

const validShape = (input: RestoreTerminalCommit): boolean =>
  input.revision.kind === 'restore' &&
  input.revision.noteId === input.identity.id &&
  input.revision.space === input.identity.space &&
  input.revision.sourceRevisionId === input.sourceRevisionId &&
  input.revision.baseRevisionId === input.expectedHeadRevisionId &&
  input.revision.expectedHeadRevisionId === input.expectedHeadRevisionId &&
  input.identity.filePath === input.targetPath &&
  input.identity.deletedAt === null &&
  input.result.noteId === input.identity.id &&
  input.result.filePath === input.identity.filePath &&
  input.revision.contentHash != null

/** Reference implementation for contract tests and meta-less hosts. Validation,
 * mutations and rollback execute synchronously in one event-loop turn, giving
 * the composed facets the same observable atomic boundary as one SQL transaction. */
export class InMemoryRestoreTerminalPersistence implements RestoreTerminalPersistence {
  private readonly identities = new Map<string, IdentityRecord>()
  private gate: Promise<void> = Promise.resolve()

  constructor(private readonly dependencies: InMemoryRestoreTerminalDependencies) {}

  async init(): Promise<void> {}

  setIdentity(record: IdentityRecord): void {
    this.identities.set(record.id, copyIdentity(record))
  }

  identityForTest(id: string): IdentityRecord | null {
    const record = this.identities.get(id)
    return record ? copyIdentity(record) : null
  }

  async commit(input: RestoreTerminalCommit) {
    if (!validShape(input)) {
      throw new Error('invalid restore terminal commit shape')
    }
    let release!: () => void
    const previous = this.gate
    this.gate = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous

    try {
      return this.commitExclusive(input)
    } finally {
      release()
    }
  }

  async finalize(input: RestoreTerminalFinalize) {
    let release!: () => void
    const previous = this.gate
    this.gate = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous

    try {
      return this.finalizeExclusive(input)
    } finally {
      release()
    }
  }

  private finalizeExclusive(input: RestoreTerminalFinalize) {
    const operation = this.dependencies.operations.getForRestoreTerminal(input.operationId)

    if (!operation) {
      return {
        status: 'conflict',
        conflict: RESTORE_TERMINAL_CONFLICT.operationMissing,
        operation: null,
      } as const
    }
    if (operation.phase === RESTORE_OPERATION_PHASE.succeeded) {
      return {
        status: 'replayed',
        operation,
        result: parseResult(operation.terminalResult, operation.id),
      } as const
    }
    if (
      operation.phase !== RESTORE_OPERATION_PHASE.metadataCommitted ||
      operation.preparedEvidence !== input.preparedEvidence ||
      operation.physicalReceipt !== input.physicalReceipt
    ) {
      return {
        status: 'conflict',
        conflict:
          operation.phase === RESTORE_OPERATION_PHASE.metadataCommitted
            ? RESTORE_TERMINAL_CONFLICT.operationEvidence
            : RESTORE_TERMINAL_CONFLICT.operationPhase,
        operation,
      } as const
    }
    const lifecycle = this.dependencies.lifecycle.getForRestoreTerminal(operation.space)

    if (!lifecycle) {
      return {
        status: 'conflict',
        conflict: RESTORE_TERMINAL_CONFLICT.lifecycle,
        operation,
      } as const
    }
    const result = parseResult(operation.terminalResult, operation.id)
    const operationSnapshot = this.dependencies.operations.snapshotForRestoreTerminal()
    const revisionSnapshot = this.dependencies.revisions.snapshotForRestoreTerminal()
    const outboxSnapshot = this.dependencies.outbox.snapshotForRestoreTerminal()

    try {
      this.dependencies.outbox.appendForRestoreTerminal({
        space: operation.space,
        generation: lifecycle.generation,
        kind: input.outboxKind,
        operationId: operation.id,
        resourceId: operation.noteId,
        createdAt: input.finalizedAt,
      })
      const transition = this.dependencies.operations.transitionForRestoreTerminal({
        id: operation.id,
        expectedPhases: [RESTORE_OPERATION_PHASE.metadataCommitted],
        phase: RESTORE_OPERATION_PHASE.succeeded,
        failureCode: null,
        updatedAt: input.finalizedAt,
      })

      if (transition.status !== 'transitioned') {
        throw new Error(`in-memory terminal finalization diverged: ${transition.status}`)
      }

      return {
        status: 'committed',
        operation: transition.operation,
        result,
      } as const
    } catch (error) {
      this.dependencies.operations.restoreForRestoreTerminal(operationSnapshot)
      this.dependencies.revisions.restoreForRestoreTerminal(revisionSnapshot)
      this.dependencies.outbox.restoreForRestoreTerminal(outboxSnapshot)
      throw error
    }
  }

  private commitExclusive(input: RestoreTerminalCommit) {
    const operation = this.dependencies.operations.getForRestoreTerminal(input.operationId)

    if (!operation) {
      return {
        status: 'conflict',
        conflict: RESTORE_TERMINAL_CONFLICT.operationMissing,
        operation: null,
      } as const
    }
    if (
      operation.phase === RESTORE_OPERATION_PHASE.metadataCommitted ||
      operation.phase === RESTORE_OPERATION_PHASE.succeeded
    ) {
      return {
        status: 'replayed',
        operation,
        result: parseResult(operation.terminalResult, operation.id),
      } as const
    }
    if (operation.phase !== RESTORE_OPERATION_PHASE.physicalPublished) {
      return {
        status: 'conflict',
        conflict: RESTORE_TERMINAL_CONFLICT.operationPhase,
        operation,
      } as const
    }
    if (
      operation.space !== input.revision.space ||
      operation.noteId !== input.revision.noteId ||
      operation.sourceRevisionId !== input.sourceRevisionId ||
      operation.expectedHeadRevisionId !== input.expectedHeadRevisionId ||
      operation.targetPath !== input.targetPath ||
      operation.preparedEvidence !== input.preparedEvidence ||
      operation.physicalReceipt !== input.physicalReceipt
    ) {
      return {
        status: 'conflict',
        conflict: RESTORE_TERMINAL_CONFLICT.operationEvidence,
        operation,
      } as const
    }
    const lifecycle = this.dependencies.lifecycle.getForRestoreTerminal(operation.space)

    if (!lifecycle || !['active', 'closing', 'archived'].includes(lifecycle.phase)) {
      return {
        status: 'conflict',
        conflict: RESTORE_TERMINAL_CONFLICT.lifecycle,
        operation,
      } as const
    }
    const source = this.dependencies.revisions.getForRestoreTerminal(
      operation.space,
      input.sourceRevisionId,
    )
    const head = this.dependencies.revisions.latestForRestoreTerminal(
      operation.space,
      operation.noteId,
    )

    // SQL checks the source row with `integrity = trusted` and reads the trusted
    // revision_heads projection. The in-memory journal serves a quarantined row
    // as a structural gap from get(), while latestFor() deliberately skips gaps;
    // using listByNote() here would therefore accept a withheld source and let a
    // newer withheld row become the CAS head.
    if (
      !source ||
      source.noteId !== operation.noteId ||
      source.space !== operation.space ||
      source.unavailableReason != null
    ) {
      return {
        status: 'conflict',
        conflict: RESTORE_TERMINAL_CONFLICT.operationEvidence,
        operation,
      } as const
    }
    if (head?.id !== input.expectedHeadRevisionId) {
      return {
        status: 'conflict',
        conflict: RESTORE_TERMINAL_CONFLICT.revisionHead,
        operation,
      } as const
    }
    const identity = this.identities.get(operation.noteId)

    if (
      !identity ||
      identity.space !== operation.space ||
      identity.addressRevision !== input.expectedIdentity.addressRevision ||
      identity.filePath !== input.expectedIdentity.filePath ||
      identity.deletedAt !== input.expectedIdentity.deletedAt
    ) {
      return {
        status: 'conflict',
        conflict: RESTORE_TERMINAL_CONFLICT.identity,
        operation,
      } as const
    }
    const occupied = [...this.identities.values()].some(
      (candidate) =>
        candidate.id !== operation.noteId &&
        candidate.space === operation.space &&
        candidate.filePath === input.identity.filePath &&
        candidate.deletedAt == null,
    )

    if (occupied) {
      return {
        status: 'conflict',
        conflict: RESTORE_TERMINAL_CONFLICT.targetOccupied,
        operation,
      } as const
    }
    const proof = this.dependencies.ownerProofs.getForRestoreTerminal(operation.noteId)

    if ((proof?.proofRevision ?? null) !== input.proof.expectedProofRevision) {
      return {
        status: 'conflict',
        conflict: RESTORE_TERMINAL_CONFLICT.proof,
        operation,
      } as const
    }
    if (
      this.dependencies.ownerProofs.getByReceiptForRestoreTerminal(
        operation.space,
        input.proof.receiptId,
      )
    ) {
      return {
        status: 'conflict',
        conflict: RESTORE_TERMINAL_CONFLICT.receipt,
        operation,
      } as const
    }
    const revisionSnapshot = this.dependencies.revisions.snapshotForRestoreTerminal()
    const proofSnapshot = this.dependencies.ownerProofs.snapshotForRestoreTerminal()
    const operationSnapshot = this.dependencies.operations.snapshotForRestoreTerminal()
    const identitySnapshot = new Map(
      [...this.identities].map(([id, record]) => [id, copyIdentity(record)]),
    )

    try {
      const revision = this.dependencies.revisions.appendForRestoreTerminal(
        input.revision,
        input.content,
      )
      const addressChanged =
        identity.filePath !== input.identity.filePath ||
        identity.space !== input.identity.space ||
        identity.deletedAt !== input.identity.deletedAt
      const addressRevision =
        (identity.addressRevision ?? input.expectedIdentity.addressRevision) +
        (addressChanged ? 1 : 0)
      this.identities.set(
        operation.noteId,
        copyIdentity({
          ...input.identity,
          legacyNameAliases: unionLegacyNameAliases(
            identity.legacyNameAliases,
            input.identity.legacyNameAliases,
          ),
          addressRevision,
        }),
      )
      this.dependencies.ownerProofs.setAddress(operation.noteId, operation.space, addressRevision)
      const adoption = this.dependencies.ownerProofs.adoptForRestoreTerminal({
        ...input.proof,
        noteId: operation.noteId,
        space: operation.space,
        addressRevision,
        updatedAt: input.committedAt,
      })

      if (adoption.status !== 'adopted') {
        throw new Error(`in-memory terminal proof adoption diverged: ${adoption.status}`)
      }
      const result = { ...input.result, revisionId: revision.id }
      const transition = this.dependencies.operations.transitionForRestoreTerminal({
        id: operation.id,
        expectedPhases: [RESTORE_OPERATION_PHASE.physicalPublished],
        phase: RESTORE_OPERATION_PHASE.metadataCommitted,
        terminalResult: JSON.stringify(result),
        failureCode: null,
        updatedAt: input.committedAt,
      })

      if (transition.status !== 'transitioned') {
        throw new Error(`in-memory terminal operation transition diverged: ${transition.status}`)
      }

      return { status: 'committed', operation: transition.operation, result } as const
    } catch (error) {
      this.dependencies.operations.restoreForRestoreTerminal(operationSnapshot)
      this.dependencies.ownerProofs.restoreForRestoreTerminal(proofSnapshot)
      this.dependencies.revisions.restoreForRestoreTerminal(revisionSnapshot)
      this.identities.clear()
      for (const [id, record] of identitySnapshot) {
        this.identities.set(id, copyIdentity(record))
      }
      throw error
    }
  }
}
