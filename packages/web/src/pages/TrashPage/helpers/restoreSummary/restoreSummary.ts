import { errorText } from '../../../../libs/errors'
import { RESTORE_REASONS } from '../../consts'
import type { BatchFailure } from '../../types'

const restoreFailureText = (failure: BatchFailure | null): string =>
  failure
    ? errorText({ message: failure.error, reason: failure.reason }, RESTORE_REASONS)
    : 'Restore failed.'

export const restoreSummary = (
  attempted: number,
  restored: number,
  failed: BatchFailure[],
): { tone: 'success' | 'warning' | 'error'; text: string } => {
  if (failed.length === 0) {
    return { tone: 'success', text: `Restored ${restored} item${restored === 1 ? '' : 's'}.` }
  }
  if (restored === 0) {
    if (attempted === 1 && failed[0]) {
      return { tone: 'error', text: restoreFailureText(failed[0]) }
    }

    return {
      tone: 'error',
      text: `Couldn’t restore ${failed.length} item${failed.length === 1 ? '' : 's'}.`,
    }
  }

  return {
    tone: 'warning',
    text: `Restored ${restored} of ${attempted}. ${failed.length} couldn’t be restored.`,
  }
}
