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
  unavailable = 0,
): { tone: 'success' | 'warning' | 'error'; text: string } => {
  const unavailableText =
    unavailable > 0
      ? ` ${unavailable} unavailable item${unavailable === 1 ? '' : 's'} remain${unavailable === 1 ? 's' : ''} in Trash.`
      : ''

  if (failed.length === 0) {
    return {
      tone: 'success',
      text: `Restored ${restored} available item${restored === 1 ? '' : 's'}.${unavailableText}`,
    }
  }
  if (restored === 0) {
    if (attempted === 1 && failed[0]) {
      return { tone: 'error', text: `${restoreFailureText(failed[0])}${unavailableText}` }
    }

    return {
      tone: 'error',
      text: `Couldn’t restore ${failed.length} available item${failed.length === 1 ? '' : 's'}.${unavailableText}`,
    }
  }

  return {
    tone: 'warning',
    text: `Restored ${restored} of ${attempted} available items. ${failed.length} couldn’t be restored.${failed.length === 1 ? ` ${restoreFailureText(failed[0] ?? null)}` : ''}${unavailableText}`,
  }
}
