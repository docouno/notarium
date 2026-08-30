type Waiter = {
  resolve: (release: () => void) => void
  reject: (reason: unknown) => void
  signal: AbortSignal
  onAbort: () => void
}

type PrincipalState = {
  active: number
  waiters: Waiter[]
}

const PRINCIPAL_QUEUE_FULL = 'PROVIDER_PRINCIPAL_QUEUE_FULL'

const principalQueueFullError = (): Error =>
  Object.assign(new Error('provider concurrency queue is full'), {
    code: PRINCIPAL_QUEUE_FULL,
  })

export const isPrincipalQueueFullError = (
  error: unknown,
): error is Error & { code: typeof PRINCIPAL_QUEUE_FULL } =>
  error instanceof Error && (error as Error & { code?: unknown }).code === PRINCIPAL_QUEUE_FULL

export class PrincipalConcurrency {
  private readonly limit: number
  private readonly queueLimit: number
  private readonly state = new Map<string, PrincipalState>()

  constructor(limit: number, queueLimit: number) {
    this.limit = limit
    this.queueLimit = queueLimit
  }

  enter(principalId: string, signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) {
      return Promise.reject(signal.reason)
    }
    const state = this.state.get(principalId) ?? { active: 0, waiters: [] }

    this.state.set(principalId, state)
    if (state.active < this.limit) {
      state.active += 1
      return Promise.resolve(this.releaseFor(principalId, state))
    }
    if (state.waiters.length >= this.queueLimit) {
      return Promise.reject(principalQueueFullError())
    }

    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        signal,
        onAbort: () => {
          const index = state.waiters.indexOf(waiter)

          if (index >= 0) {
            state.waiters.splice(index, 1)
            reject(signal.reason)
          }
        },
      }

      state.waiters.push(waiter)
      signal.addEventListener('abort', waiter.onAbort, { once: true })
    })
  }

  private releaseFor(principalId: string, state: PrincipalState): () => void {
    let released = false

    return () => {
      if (released) {
        return
      }
      released = true
      for (;;) {
        const waiter = state.waiters.shift()

        if (!waiter) {
          state.active -= 1
          if (state.active === 0) {
            this.state.delete(principalId)
          }

          return
        }
        waiter.signal.removeEventListener('abort', waiter.onAbort)
        if (!waiter.signal.aborted) {
          waiter.resolve(this.releaseFor(principalId, state))
          return
        }
      }
    }
  }
}
