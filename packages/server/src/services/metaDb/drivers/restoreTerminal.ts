import {
  type RestoreOperationRecord,
  type RestoreTerminalCommit,
  type RestoreTerminalResult,
} from '@notarium/core'

export const parsedTerminalResult = (operation: RestoreOperationRecord): RestoreTerminalResult => {
  if (!operation.terminalResult) {
    throw new Error(`succeeded restore operation has no terminal result: ${operation.id}`)
  }

  const result = JSON.parse(operation.terminalResult) as unknown

  if (
    !result ||
    typeof result !== 'object' ||
    typeof (result as { noteId?: unknown }).noteId !== 'string' ||
    typeof (result as { filePath?: unknown }).filePath !== 'string' ||
    typeof (result as { revisionId?: unknown }).revisionId !== 'string' ||
    typeof (result as { versionToken?: unknown }).versionToken !== 'string'
  ) {
    throw new Error(`succeeded restore operation has an invalid terminal result: ${operation.id}`)
  }

  return result as RestoreTerminalResult
}

export const assertRestoreTerminalCommitShape = (input: RestoreTerminalCommit): void => {
  const { revision, identity, result } = input

  if (
    revision.kind !== 'restore' ||
    revision.noteId !== identity.id ||
    revision.space !== identity.space ||
    revision.sourceRevisionId !== input.sourceRevisionId ||
    revision.baseRevisionId !== input.expectedHeadRevisionId ||
    revision.expectedHeadRevisionId !== input.expectedHeadRevisionId ||
    identity.filePath !== input.targetPath ||
    identity.deletedAt !== null ||
    result.noteId !== identity.id ||
    result.filePath !== identity.filePath ||
    revision.contentHash == null
  ) {
    throw new Error('invalid restore terminal commit shape')
  }
}

export const RESTORE_TERMINAL_LIFECYCLE_PHASES: readonly string[] = [
  'active',
  'closing',
  'archived',
]
