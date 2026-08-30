import {
  PROVIDER_CONSERVATIVE_RPM,
  PROVIDER_RATE_LIMIT_MAX_WAITERS,
  PROVIDER_RETARGET_HOST_CAP,
  PROVIDER_VALIDATE_HOST_CAP,
} from '@notarium/contract'

import { ProviderRateLimitError } from './errors'
import { ProviderHostCapError } from './hostCapError'

const CALL_WINDOW_MS = 60 * 1000
const IDLE_SWEEP_INTERVAL_MS = 60 * 1000

export type ProviderRateLimiterOptions = {
  now?: () => number
}

export type ProviderRateLimitRequest = {
  owner: string
  credentialId: string | null
  rpm: number | null
  tpm: number | null
  inputUpperBound: number
  outputTokenBudget: number
  signal: AbortSignal
  waitTimeoutMs: number
}

export type ProviderRateLimitReservation = {
  readonly key: string
  readonly id: symbol
}

export type ProviderCallRateLimiter = Pick<
  ProviderRateLimiter,
  'releaseCall' | 'reserveCall' | 'reserveHostValidate' | 'settleCall'
>

export type ProviderRetargetRateLimiter = Pick<ProviderRateLimiter, 'reserveRetarget'>

type EffectiveLimit = {
  key: string
  rpm: number
  tpm: number | null
  tokens: number
  signal: AbortSignal
  deadlineAt: number
}

type WindowEntry = {
  id: symbol
  at: number
  tokens: number
}

type WindowWaiter = {
  limit: EffectiveLimit
  resolve: (reservation: ProviderRateLimitReservation) => void
  reject: (reason: unknown) => void
  abort: () => void
}

type CallWindow = {
  entries: WindowEntry[]
  waiters: WindowWaiter[]
  timer: ReturnType<typeof setTimeout> | null
  windowMs: number
}

const positiveIntegerOrNull = (value: number | null): boolean =>
  value === null || (Number.isInteger(value) && value > 0)

const nonnegativeInteger = (value: number): boolean => Number.isInteger(value) && value >= 0

/** Process-local sliding windows. One map owns every outbound-call gate; retargeting
 *  is the second bucket because it has a different operation and hour window. */
export class ProviderRateLimiter {
  private readonly now: () => number
  private readonly callWindows = new Map<string, CallWindow>()
  private readonly retargetWindows = new Map<string, number[]>()
  private lastIdleSweepAt = Number.NEGATIVE_INFINITY

  constructor(options: ProviderRateLimiterOptions = {}) {
    this.now = options.now ?? Date.now
  }

  reserveCall(input: ProviderRateLimitRequest): Promise<ProviderRateLimitReservation> {
    this.sweepIdle()
    let limit: EffectiveLimit

    try {
      limit = this.effectiveLimit(input)
    } catch (error) {
      return Promise.reject(error)
    }
    if (limit.signal.aborted) {
      return Promise.reject(limit.signal.reason)
    }
    const window = this.window(limit.key, CALL_WINDOW_MS)
    this.prune(window, CALL_WINDOW_MS)

    if (window.waiters.length === 0 && this.fits(window, limit)) {
      return Promise.resolve(this.add(window, limit))
    }
    if (limit.tpm !== null && limit.tokens > limit.tpm) {
      return Promise.reject(new ProviderRateLimitError(CALL_WINDOW_MS))
    }
    if (window.waiters.length >= PROVIDER_RATE_LIMIT_MAX_WAITERS) {
      return Promise.reject(new ProviderRateLimitError(this.retryAfter(window, CALL_WINDOW_MS)))
    }

    return new Promise<ProviderRateLimitReservation>((resolve, reject) => {
      const waiter: WindowWaiter = {
        limit,
        resolve,
        reject,
        abort: () => {
          const index = window.waiters.indexOf(waiter)

          if (index >= 0) {
            window.waiters.splice(index, 1)
          }
          limit.signal.removeEventListener('abort', waiter.abort)
          reject(limit.signal.reason)
          this.drain(limit.key, window)
        },
      }
      window.waiters.push(waiter)
      limit.signal.addEventListener('abort', waiter.abort, { once: true })
      this.schedule(limit.key, window)
    })
  }

  settleCall(reservation: ProviderRateLimitReservation, observedTokens: number | null): void {
    if (observedTokens === null || !nonnegativeInteger(observedTokens)) {
      return
    }
    const window = this.callWindows.get(reservation.key)
    const entry = window?.entries.find((candidate) => candidate.id === reservation.id)

    if (entry) {
      entry.tokens = Math.max(entry.tokens, observedTokens)
    }
  }

  releaseCall(reservation: ProviderRateLimitReservation): void {
    const window = this.callWindows.get(reservation.key)

    if (!window) {
      return
    }
    window.entries = window.entries.filter((entry) => entry.id !== reservation.id)
    this.drain(reservation.key, window)
  }

  reserveHostValidate(owner: string): void {
    this.sweepIdle()
    const key = `validate:${owner}`
    const window = this.window(key, PROVIDER_VALIDATE_HOST_CAP.windowMs)
    this.prune(window, PROVIDER_VALIDATE_HOST_CAP.windowMs)

    if (window.entries.length >= PROVIDER_VALIDATE_HOST_CAP.calls) {
      throw new ProviderHostCapError(this.retryAfter(window, PROVIDER_VALIDATE_HOST_CAP.windowMs))
    }
    window.entries.push({ id: Symbol(key), at: this.now(), tokens: 0 })
  }

  reserveRetarget(owner: string): void {
    this.sweepIdle()
    const at = this.now()
    const since = at - PROVIDER_RETARGET_HOST_CAP.windowMs
    const kept = (this.retargetWindows.get(owner) ?? []).filter((stamp) => stamp > since)

    if (kept.length >= PROVIDER_RETARGET_HOST_CAP.calls) {
      this.retargetWindows.set(owner, kept)
      throw new ProviderRateLimitError(
        Math.max(1, kept[0] + PROVIDER_RETARGET_HOST_CAP.windowMs - at),
      )
    }
    kept.push(at)
    this.retargetWindows.set(owner, kept)
  }

  private effectiveLimit(input: ProviderRateLimitRequest): EffectiveLimit {
    if (
      !positiveIntegerOrNull(input.rpm) ||
      !positiveIntegerOrNull(input.tpm) ||
      !nonnegativeInteger(input.inputUpperBound) ||
      !nonnegativeInteger(input.outputTokenBudget) ||
      !Number.isInteger(input.waitTimeoutMs) ||
      input.waitTimeoutMs <= 0
    ) {
      throw new TypeError('provider rate-limit inputs must be nonnegative integer budgets')
    }
    const configured = input.credentialId !== null && (input.rpm !== null || input.tpm !== null)

    return {
      key: configured ? `credential:${input.credentialId}` : `owner:${input.owner}`,
      rpm: configured ? (input.rpm ?? PROVIDER_CONSERVATIVE_RPM) : PROVIDER_CONSERVATIVE_RPM,
      tpm: configured ? input.tpm : null,
      tokens: input.inputUpperBound + input.outputTokenBudget,
      signal: input.signal,
      deadlineAt: this.now() + input.waitTimeoutMs,
    }
  }

  private window(key: string, windowMs: number): CallWindow {
    const present = this.callWindows.get(key)

    if (present) {
      if (present.windowMs !== windowMs) {
        throw new Error(`provider limiter window ${key} changed duration`)
      }

      return present
    }
    const created: CallWindow = { entries: [], waiters: [], timer: null, windowMs }
    this.callWindows.set(key, created)
    return created
  }

  private prune(window: CallWindow, windowMs: number): void {
    const since = this.now() - windowMs
    window.entries = window.entries.filter((entry) => entry.at > since)
  }

  private fits(window: CallWindow, limit: EffectiveLimit): boolean {
    if (window.entries.length >= limit.rpm) {
      return false
    }

    return (
      limit.tpm === null ||
      window.entries.reduce((total, entry) => total + entry.tokens, 0) + limit.tokens <= limit.tpm
    )
  }

  private add(window: CallWindow, limit: EffectiveLimit): ProviderRateLimitReservation {
    const id = Symbol(limit.key)
    window.entries.push({ id, at: this.now(), tokens: limit.tokens })
    return { key: limit.key, id }
  }

  private drain(key: string, window: CallWindow): void {
    this.prune(window, window.windowMs)

    for (const waiter of [...window.waiters]) {
      if (waiter.limit.deadlineAt >= this.now()) {
        continue
      }
      window.waiters.splice(window.waiters.indexOf(waiter), 1)
      waiter.limit.signal.removeEventListener('abort', waiter.abort)
      waiter.reject(new ProviderRateLimitError(this.retryAfter(window, window.windowMs)))
    }

    while (window.waiters.length > 0) {
      const waiter = window.waiters[0]

      if (!this.fits(window, waiter.limit)) {
        break
      }
      window.waiters.shift()
      waiter.limit.signal.removeEventListener('abort', waiter.abort)
      waiter.resolve(this.add(window, waiter.limit))
    }
    if (window.entries.length === 0 && window.waiters.length === 0) {
      if (window.timer) {
        clearTimeout(window.timer)
        window.timer = null
      }
      this.callWindows.delete(key)
      return
    }
    this.schedule(key, window)
  }

  private schedule(key: string, window: CallWindow): void {
    if (window.timer) {
      clearTimeout(window.timer)
      window.timer = null
    }
    if (window.waiters.length === 0 || window.entries.length === 0) {
      return
    }
    const earliestDeadline = window.waiters.reduce(
      (earliest, waiter) => Math.min(earliest, waiter.limit.deadlineAt),
      Number.POSITIVE_INFINITY,
    )
    const deadlineDelay = Math.max(1, earliestDeadline - this.now())
    window.timer = setTimeout(
      () => {
        window.timer = null
        this.drain(key, window)
      },
      Math.min(this.retryAfter(window, window.windowMs), deadlineDelay),
    )
  }

  /** Opportunistic global sweep: one pass per minute of limiter activity, never one
   *  timeout per owner/credential. A completely idle process retains no growing work;
   *  the next admission pays one bounded pass and drops every expired key at once. */
  private sweepIdle(): void {
    const at = this.now()

    if (at - this.lastIdleSweepAt < IDLE_SWEEP_INTERVAL_MS) {
      return
    }
    this.lastIdleSweepAt = at
    for (const [key, window] of this.callWindows) {
      this.prune(window, window.windowMs)
      if (window.waiters.length > 0) {
        this.drain(key, window)
      } else if (window.entries.length === 0) {
        if (window.timer) {
          clearTimeout(window.timer)
        }
        this.callWindows.delete(key)
      }
    }
    const since = at - PROVIDER_RETARGET_HOST_CAP.windowMs

    for (const [owner, stamps] of this.retargetWindows) {
      const kept = stamps.filter((stamp) => stamp > since)

      if (kept.length === 0) {
        this.retargetWindows.delete(owner)
      } else if (kept.length !== stamps.length) {
        this.retargetWindows.set(owner, kept)
      }
    }
  }

  private retryAfter(window: CallWindow, windowMs: number): number {
    const first = window.entries.reduce(
      (minimum, entry) => Math.min(minimum, entry.at),
      Number.POSITIVE_INFINITY,
    )

    return Number.isFinite(first) ? Math.max(1, first + windowMs - this.now()) : windowMs
  }
}
