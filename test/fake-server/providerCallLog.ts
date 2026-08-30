import { PROVIDER_CALL_OUTCOME, PROVIDER_DELIVERY_STATE } from '@notarium/contract'
import {
  type ProviderCallIntentInput,
  providerCallLicensesAnotherAttempt,
  type ProviderCallLogPersistence,
  type ProviderCallLogRecord,
  type ProviderCallSettleInput,
} from '@notarium/server'

const copy = (record: ProviderCallLogRecord): ProviderCallLogRecord => ({
  ...record,
  spaces: [...record.spaces],
  usage: record.usage ? { ...record.usage } : null,
})

/** In-memory twin of the provider call journal (#387 vertical 12) — the SQL drivers'
 *  behavioural double for the fake backend. Two-phase like the drivers: the intent is
 *  recorded before a send is allowed and the outcome closes the same row, and the
 *  durable send-fence refuses a second attempt of a logical job call whose last one
 *  did not prove the provider went unpaid. Kept in lockstep with
 *  sqliteMetaDb/pgMetaDb's `providerCallLog`. */
export class InMemoryProviderCallLog implements ProviderCallLogPersistence {
  private rows: ProviderCallLogRecord[] = []

  constructor(private readonly jobIsLive: (jobId: string) => boolean = () => false) {}

  clear(): void {
    this.rows = []
  }

  /** Test read-model seam: every row in insertion order. */
  snapshot(): ProviderCallLogRecord[] {
    return this.rows.map(copy)
  }

  private latest(jobId: string, jobCallKey: string): ProviderCallLogRecord | undefined {
    return this.rows
      .filter((row) => row.jobId === jobId && row.jobCallKey === jobCallKey)
      .reduce<ProviderCallLogRecord | undefined>(
        (best, row) => (!best || (row.attemptNo ?? 0) > (best.attemptNo ?? 0) ? row : best),
        undefined,
      )
  }

  async intent(input: ProviderCallIntentInput) {
    const previous = input.job ? this.latest(input.job.jobId, input.job.jobCallKey) : undefined

    if (previous && !providerCallLicensesAnotherAttempt(previous)) {
      return { status: 'blocked' as const, record: copy(previous) }
    }
    const record: ProviderCallLogRecord = {
      id: input.id,
      owner: input.owner,
      principal: input.principal,
      agent: input.agent,
      resourceId: input.resourceId,
      credentialId: input.credentialId,
      host: input.host,
      spaces: [...input.spaces],
      jobId: input.job?.jobId ?? null,
      jobCallKey: input.job?.jobCallKey ?? null,
      attemptNo: input.job ? (previous?.attemptNo ?? 0) + 1 : null,
      deliveryState: PROVIDER_DELIVERY_STATE.mayHaveSent,
      retrySafe: false,
      outcome: PROVIDER_CALL_OUTCOME.inFlight,
      usage: null,
      createdAt: input.createdAt,
      settledAt: null,
    }
    this.rows.push(record)
    return { status: 'recorded' as const, record: copy(record) }
  }

  async settle(input: ProviderCallSettleInput) {
    const row = this.rows.find((candidate) => candidate.id === input.id)

    if (!row) {
      return null
    }
    if (row.outcome === PROVIDER_CALL_OUTCOME.inFlight) {
      row.deliveryState = input.deliveryState
      row.retrySafe = input.retrySafe
      row.outcome = input.outcome
      row.usage = input.usage ? { ...input.usage } : null
      row.settledAt = input.settledAt
    }

    return copy(row)
  }

  async get(id: string) {
    const row = this.rows.find((candidate) => candidate.id === id)
    return row ? copy(row) : null
  }

  async latestForJobCall(jobId: string, jobCallKey: string) {
    const row = this.latest(jobId, jobCallKey)
    return row ? copy(row) : null
  }

  async pruneTerminalBefore(before: string, limit = 1_000) {
    const removable = this.rows
      .filter(
        (row) =>
          row.outcome !== PROVIDER_CALL_OUTCOME.inFlight &&
          row.settledAt !== null &&
          row.settledAt < before &&
          (row.jobId === null || !this.jobIsLive(row.jobId)),
      )
      .sort((left, right) =>
        left.settledAt === right.settledAt
          ? left.id.localeCompare(right.id)
          : left.settledAt!.localeCompare(right.settledAt!),
      )
      .slice(0, Math.max(1, Math.min(limit, 1_000)))
    const ids = new Set(removable.map(({ id }) => id))

    this.rows = this.rows.filter(({ id }) => !ids.has(id))
    return ids.size
  }

  async listForOwner(owner: string) {
    return this.rows.filter((row) => row.owner === owner).map(copy)
  }
}
