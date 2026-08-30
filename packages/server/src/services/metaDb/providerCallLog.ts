import {
  PROVIDER_CALL_ERROR,
  PROVIDER_CALL_OUTCOME,
  PROVIDER_TIMEOUT,
  PROVIDER_USAGE_SOURCE,
  type ProviderCallOutcome,
} from '@notarium/contract'

import type { ProviderCallLogPersistence, ProviderCallLogRecord } from './types'

export const PROVIDER_CALL_LOG_RETENTION_ENV = 'PROVIDERS_CALL_LOG_RETENTION_DAYS'
export const PROVIDER_CALL_LOG_RETENTION_DEFAULT_DAYS = 90
export type ProviderCallLogRetentionDays = 30 | 90 | 365 | null

/** `null` means explicit forever. The small closed vocabulary keeps an accidental
 *  typo from silently turning a bounded audit into an unbounded one. */
export const providerCallLogRetentionFromEnv = (
  value: string | undefined,
): ProviderCallLogRetentionDays => {
  if (value === undefined) {
    return PROVIDER_CALL_LOG_RETENTION_DEFAULT_DAYS
  }
  if (value === 'forever') {
    return null
  }
  const days = Number(value)

  if (days === 30 || days === 90 || days === 365) {
    return days
  }

  throw new Error(`${PROVIDER_CALL_LOG_RETENTION_ENV} must be 30, 90, 365, or forever`)
}

export const providerCallLogRetentionBefore = (
  now: Date,
  days: ProviderCallLogRetentionDays,
): string | null =>
  days === null ? null : new Date(now.getTime() - days * 24 * 60 * 60 * 1_000).toISOString()

/** One bounded maintenance batch. The shared server maintenance tick owns cadence;
 *  this helper deliberately creates no process timer of its own. */
export const pruneProviderCallLogRetention = async (
  persistence: Pick<ProviderCallLogPersistence, 'pruneTerminalBefore'>,
  input: { now: Date; days: ProviderCallLogRetentionDays; limit?: number },
): Promise<number> => {
  const before = providerCallLogRetentionBefore(input.now, input.days)
  return before === null ? 0 : persistence.pruneTerminalBefore(before, input.limit)
}

/** An intent that never closed is read as `outcome-unknown` once no call could still
 *  be running — the row itself keeps saying `in-flight`, because nothing observed it
 *  end and a background rechecker is not part of this model. The ceiling is the
 *  longest a call may legally take, so anything older either died with its process or
 *  lost its answer, and both mean the same thing to a caller: it may have been paid
 *  for. */
export const providerCallOutcomeAsRead = (
  record: ProviderCallLogRecord,
  now: Date,
  ceilingMs: number = PROVIDER_TIMEOUT.callMaximumMs,
): ProviderCallOutcome =>
  record.outcome === PROVIDER_CALL_OUTCOME.inFlight &&
  now.getTime() - Date.parse(record.createdAt) > ceilingMs
    ? PROVIDER_CALL_ERROR.outcomeUnknown
    : record.outcome

/** Whether the last attempt of a logical durable call licenses another one. Read by
 *  all three drivers rather than restated in each: a rule that says "may I spend the
 *  owner's money again" is not something two backends should be free to disagree
 *  about, and the twins exist to prove they answer the same. Only a terminal outcome
 *  that PROVED the request went unprocessed opens the door — an open intent proves
 *  nothing, because the process may have died between the commit and the socket
 *  write, and neither does any call the provider answered, whatever its class. */
export const providerCallLicensesAnotherAttempt = (previous: ProviderCallLogRecord): boolean =>
  previous.outcome !== PROVIDER_CALL_OUTCOME.inFlight && previous.retrySafe

export type ProviderCallUsageTotals = {
  calls: number
  /** Prompt + completion, counted only where the wire said so. */
  tokens: number
  /** How many of those calls reported nothing. Kept apart from `tokens` on purpose:
   *  folding an unknown spend in as zero is the one reading that makes the total a
   *  lie in the direction that costs money. */
  unknownUsageCalls: number
}

const tokensOf = (record: ProviderCallLogRecord): number | null => {
  if (!record.usage) {
    return null
  }
  if (record.usage.source === PROVIDER_USAGE_SOURCE.openaiCompatible) {
    const { totalTokens, promptTokens, completionTokens } = record.usage

    if (totalTokens !== null) {
      return totalTokens
    }

    return promptTokens === null && completionTokens === null
      ? null
      : (promptTokens ?? 0) + (completionTokens ?? 0)
  }
  const { promptEvalCount, evalCount } = record.usage

  return promptEvalCount === null && evalCount === null
    ? null
    : (promptEvalCount ?? 0) + (evalCount ?? 0)
}

/** The spend rollup, computed from the events every time it is asked for. There is no
 *  stored sum anywhere and there is deliberately no second one: a column that agrees
 *  with the journal only until someone forgets to update it is worse than an
 *  arithmetic pass over rows a human reads in the hundreds. */
export const providerCallUsageTotals = (
  records: readonly ProviderCallLogRecord[],
): ProviderCallUsageTotals => {
  let tokens = 0
  let unknownUsageCalls = 0

  for (const record of records) {
    const counted = tokensOf(record)

    if (counted === null) {
      unknownUsageCalls += 1
    } else {
      tokens += counted
    }
  }

  return { calls: records.length, tokens, unknownUsageCalls }
}
