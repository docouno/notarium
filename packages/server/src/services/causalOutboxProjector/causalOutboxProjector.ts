import type { CausalOutboxPersistence, CausalOutboxRecord } from '@notarium/core'

const DEFAULT_POLL_MS = 1_000
const DEFAULT_BATCH_SIZE = 100

export type CausalOutboxProjectorOptions = {
  outbox: CausalOutboxPersistence
  /** Stable durable identity of this projection replica. */
  subscriberId: string
  project(record: CausalOutboxRecord): Promise<void>
  pollMs?: number
  batchSize?: number
  now?: () => Date
  onError?: (error: unknown, record?: CausalOutboxRecord) => void
}

/** Durable outbox delivery is intentionally pull-based: an event is only a
 * wake-up hint, and each replica repairs its projection by rereading committed
 * file/metadata truth before acknowledging it. */
export class CausalOutboxProjector {
  private readonly outbox: CausalOutboxPersistence
  private readonly subscriberId: string
  private readonly project: CausalOutboxProjectorOptions['project']
  private readonly pollMs: number
  private readonly batchSize: number
  private readonly now: () => Date
  private readonly onError: NonNullable<CausalOutboxProjectorOptions['onError']>
  private timer: ReturnType<typeof setInterval> | null = null
  private running: Promise<void> | null = null
  private stopped = false

  constructor({
    outbox,
    subscriberId,
    project,
    pollMs = DEFAULT_POLL_MS,
    batchSize = DEFAULT_BATCH_SIZE,
    now = () => new Date(),
    onError = (error, record) =>
      console.error(
        `[causal-outbox]${record ? ` ${record.id}/${record.kind}` : ''} ->`,
        (error as Error).message,
      ),
  }: CausalOutboxProjectorOptions) {
    if (!Number.isFinite(pollMs) || pollMs <= 0) {
      throw new Error('causal outbox pollMs must be a positive number')
    }
    if (!Number.isInteger(batchSize) || batchSize <= 0) {
      throw new Error('causal outbox batchSize must be a positive integer')
    }
    if (!subscriberId || subscriberId.length > 200) {
      throw new Error('causal outbox subscriberId must be a bounded non-empty string')
    }
    this.outbox = outbox
    this.subscriberId = subscriberId
    this.project = project
    this.pollMs = pollMs
    this.batchSize = batchSize
    this.now = now
    this.onError = onError
  }

  /** Startup is strict: admission must not open over a known stale projection. */
  async start(): Promise<void> {
    if (this.timer) {
      return
    }
    this.stopped = false
    await this.drain(true)
    this.timer = setInterval(() => this.wake(), this.pollMs)
    this.timer.unref?.()
  }

  /** Local terminal commits wake immediately; peers converge through polling. */
  wake(): void {
    if (this.stopped) {
      return
    }
    void this.drain(false).catch((error) => this.onError(error))
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    await this.running?.catch(() => {})
  }

  private drain(strict: boolean): Promise<void> {
    if (this.running) {
      return this.running
    }
    const task = this.drainExclusive(strict)
    this.running = task
    void task.then(
      () => {
        if (this.running === task) {
          this.running = null
        }
      },
      () => {
        if (this.running === task) {
          this.running = null
        }
      },
    )
    return task
  }

  private async drainExclusive(strict: boolean): Promise<void> {
    while (!this.stopped) {
      const pending = await this.outbox.pending(this.subscriberId, this.batchSize)

      if (!pending.length) {
        return
      }
      let acknowledged = 0
      let failed = false

      for (const record of pending) {
        if (this.stopped) {
          return
        }
        try {
          await this.project(record)
          await this.outbox.acknowledge(this.subscriberId, [record.id], this.now().toISOString())
          acknowledged++
        } catch (error) {
          failed = true
          this.onError(error, record)
          if (strict) {
            throw error
          }
        }
      }
      // A poison event must not create a hot loop. The next timer/local wake
      // retries it, while successes later in the same batch were still delivered.
      if (failed || acknowledged === 0 || pending.length < this.batchSize) {
        return
      }
    }
  }
}
