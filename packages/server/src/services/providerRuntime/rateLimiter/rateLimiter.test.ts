import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PROVIDER_CALL_ERROR } from '@notarium/contract'

import { ProviderRateLimitError } from './errors'
import { ProviderRateLimiter, type ProviderRateLimitRequest } from './rateLimiter'

const call = (overrides: Partial<ProviderRateLimitRequest> = {}): ProviderRateLimitRequest => ({
  owner: 'alice',
  credentialId: 'credential-a',
  rpm: 1,
  tpm: null,
  inputUpperBound: 0,
  outputTokenBudget: 0,
  signal: new AbortController().signal,
  waitTimeoutMs: 120_000,
  ...overrides,
})

const stateOf = async (promise: Promise<unknown>) => {
  const result: { state: 'waiting' | 'admitted' | 'rejected'; error?: unknown } = {
    state: 'waiting',
  }

  void promise.then(
    () => {
      result.state = 'admitted'
    },
    (error: unknown) => {
      result.state = 'rejected'
      result.error = error
    },
  )
  await Promise.resolve()
  await Promise.resolve()
  return result
}

describe('provider rate limiter', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-25T12:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('shares one RPM window between resources on the same credential', async () => {
    const limiter = new ProviderRateLimiter()

    await limiter.reserveCall(call())
    const waiting = limiter.reserveCall(call())

    await expect(stateOf(waiting)).resolves.toMatchObject({ state: 'waiting' })
    await vi.advanceTimersByTimeAsync(60_001)
    await expect(waiting).resolves.toBeDefined()
  })

  it('does not couple different credentials', async () => {
    const limiter = new ProviderRateLimiter()

    await limiter.reserveCall(call({ credentialId: 'credential-a' }))

    await expect(limiter.reserveCall(call({ credentialId: 'credential-b' }))).resolves.toBeDefined()
  })

  it('uses one conservative owner window when a credential has no effective limit', async () => {
    const limiter = new ProviderRateLimiter()

    for (let index = 0; index < 6; index += 1) {
      await limiter.reserveCall(call({ credentialId: `credential-${index}`, rpm: null, tpm: null }))
    }
    const waiting = limiter.reserveCall(
      call({ credentialId: 'credential-seventh', rpm: null, tpm: null }),
    )

    await expect(stateOf(waiting)).resolves.toMatchObject({ state: 'waiting' })
    await expect(
      limiter.reserveCall(call({ owner: 'bob', credentialId: null, rpm: null, tpm: null })),
    ).resolves.toBeDefined()
  })

  it('does not let a caller override the fallback for a resource without a credential', async () => {
    const limiter = new ProviderRateLimiter()

    for (let index = 0; index < 6; index += 1) {
      await limiter.reserveCall(
        call({ credentialId: null, rpm: 100, tpm: 100_000, inputUpperBound: 1 }),
      )
    }
    const seventh = limiter.reserveCall(
      call({ credentialId: null, rpm: 100, tpm: 100_000, inputUpperBound: 1 }),
    )

    await expect(stateOf(seventh)).resolves.toMatchObject({ state: 'waiting' })
  })

  it('refuses a waiter when its operation budget expires before the window', async () => {
    const limiter = new ProviderRateLimiter()

    await limiter.reserveCall(call())
    const waiting = limiter.reserveCall(call({ waitTimeoutMs: 30_000 }))
    const outcome = waiting.then(
      () => ({ state: 'admitted' as const }),
      (error: unknown) => ({ state: 'rejected' as const, error }),
    )
    await vi.advanceTimersByTimeAsync(30_001)
    const result = await outcome

    expect(result).toMatchObject({ state: 'rejected' })
    expect(result.state === 'rejected' ? result.error : null).toBeInstanceOf(ProviderRateLimitError)
  })

  it('keeps at most twelve waiters per window key', async () => {
    const limiter = new ProviderRateLimiter()

    for (let index = 0; index < 6; index += 1) {
      await limiter.reserveCall(call({ rpm: 6 }))
    }
    const waiting = Array.from({ length: 12 }, () => limiter.reserveCall(call({ rpm: 6 })))
    const allWaiting = Promise.all(waiting)

    await expect(limiter.reserveCall(call({ rpm: 6 }))).rejects.toMatchObject({
      code: PROVIDER_CALL_ERROR.notariumRateLimited,
    })
    await vi.advanceTimersByTimeAsync(2 * 60_001)
    await expect(allWaiting).resolves.toHaveLength(12)
  })

  it('removes an aborted waiter without opening a later admission', async () => {
    const limiter = new ProviderRateLimiter()
    const controller = new AbortController()

    await limiter.reserveCall(call())
    const waiting = limiter.reserveCall(call({ signal: controller.signal }))
    controller.abort(new Error('request closed'))

    await expect(waiting).rejects.toThrow('request closed')
    await vi.advanceTimersByTimeAsync(60_001)
    await expect(limiter.reserveCall(call())).resolves.toBeDefined()
  })

  it('never refunds below the TPM reserve and charges observed excess', async () => {
    const limiter = new ProviderRateLimiter()
    const reserved = await limiter.reserveCall(
      call({ rpm: 10, tpm: 10, inputUpperBound: 3, outputTokenBudget: 5 }),
    )

    limiter.settleCall(reserved, 4)
    await expect(
      limiter.reserveCall(call({ rpm: 10, tpm: 10, inputUpperBound: 2 })),
    ).resolves.toBeDefined()

    const second = new ProviderRateLimiter()
    const small = await second.reserveCall(call({ rpm: 10, tpm: 10, inputUpperBound: 2 }))
    second.settleCall(small, 8)
    const waiting = second.reserveCall(call({ rpm: 10, tpm: 10, inputUpperBound: 3 }))

    await expect(stateOf(waiting)).resolves.toMatchObject({ state: 'waiting' })
  })

  it('keeps the full TPM reserve when usage is unknown', async () => {
    const limiter = new ProviderRateLimiter()
    const reserved = await limiter.reserveCall(
      call({ rpm: 10, tpm: 10, inputUpperBound: 4, outputTokenBudget: 6 }),
    )

    limiter.settleCall(reserved, null)
    const waiting = limiter.reserveCall(call({ rpm: 10, tpm: 10, inputUpperBound: 1 }))

    await expect(stateOf(waiting)).resolves.toMatchObject({ state: 'waiting' })
  })

  it('applies the retarget ceiling through the same public limiter', () => {
    const limiter = new ProviderRateLimiter()

    for (let index = 0; index < 5; index += 1) {
      limiter.reserveRetarget('alice')
    }

    expect(() => limiter.reserveRetarget('alice')).toThrow(ProviderRateLimitError)
    expect(() => limiter.reserveRetarget('bob')).not.toThrow()
  })

  it('uses the same own-error class for the validate host cap', () => {
    const limiter = new ProviderRateLimiter()

    for (let index = 0; index < 20; index += 1) {
      limiter.reserveHostValidate('alice')
    }

    expect(() => limiter.reserveHostValidate('alice')).toThrow(
      expect.objectContaining({ code: PROVIDER_CALL_ERROR.notariumRateLimited }),
    )
  })

  it('sweeps 10k idle owner and credential keys without one timer per key', async () => {
    let now = 0
    const limiter = new ProviderRateLimiter({ now: () => now })
    const maps = limiter as unknown as {
      callWindows: Map<string, unknown>
      retargetWindows: Map<string, unknown>
    }

    for (let index = 0; index < 10_000; index += 1) {
      limiter.reserveHostValidate(`owner-${index}`)
      limiter.reserveRetarget(`owner-${index}`)
      await limiter.reserveCall(
        call({ owner: `owner-${index}`, credentialId: `credential-${index}` }),
      )
    }

    expect(maps.callWindows.size).toBe(20_000)
    expect(maps.retargetWindows.size).toBe(10_000)
    expect(vi.getTimerCount()).toBe(0)

    now = 2 * 60 * 60 * 1000
    limiter.reserveHostValidate('fresh-owner')

    expect(maps.callWindows.size).toBe(1)
    expect(maps.retargetWindows.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})
