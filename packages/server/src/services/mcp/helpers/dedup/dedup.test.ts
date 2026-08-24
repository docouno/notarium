import { describe, expect, it, vi } from 'vitest'

import { type Ctx } from '../../gateway'
import { dedupedWrite } from './dedup'

const deferred = <T>() => {
  let resolve!: (value: T) => void

  let reject!: (reason?: unknown) => void

  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })

  return { promise, resolve, reject }
}

describe('dedupedWrite single-flight', () => {
  it('hands one rejected attempt to every joiner and frees the key for a later retry', async () => {
    const inFlight: NonNullable<Ctx['idempotencyInFlight']> = new Map()
    const ctx = {
      principal: { id: 'principal-id' },
      idempotencyInFlight: inFlight,
      now: () => new Date('2026-08-11T00:00:00.000Z'),
    } as Ctx
    const keys = { toolName: 'create_note' as const, idempotencyKey: 'same-key' }
    const release = deferred<{ noteId: string; versionToken: string }>()
    const failure = new Error('runner failed')
    let runs = 0

    const run = async () => {
      runs += 1
      return release.promise
    }
    const runner = dedupedWrite(ctx, keys, run)
    const joiners = [dedupedWrite(ctx, keys, run), dedupedWrite(ctx, keys, run)]

    expect(runs).toBe(1)
    expect(inFlight.size).toBe(1)
    release.reject(failure)
    const settled = await Promise.allSettled([runner, ...joiners])

    expect(settled.every((result) => result.status === 'rejected')).toBe(true)
    expect(
      settled.every((result) => result.status === 'rejected' && result.reason === failure),
    ).toBe(true)
    expect(runs).toBe(1)
    expect(inFlight.size).toBe(0)

    await expect(
      dedupedWrite(ctx, keys, async () => {
        runs += 1
        return { noteId: 'retry-note', versionToken: 'retry-token' }
      }),
    ).resolves.toEqual({
      result: { noteId: 'retry-note', versionToken: 'retry-token' },
      wasHit: false,
    })
    expect(runs).toBe(2)
  })

  it('returns a committed write with an honest warning when durable replay persistence fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const ctx = {
      principal: { id: 'principal-id' },
      idempotencyInFlight: new Map(),
      gatewayState: {
        dedupGet: vi.fn(async () => null),
        dedupPut: vi.fn(async () => {
          throw new Error('db unavailable')
        }),
        dedupPrune: vi.fn(async () => undefined),
      },
      now: () => new Date('2026-08-11T00:00:00.000Z'),
    } as unknown as Ctx

    await expect(
      dedupedWrite(ctx, { toolName: 'create_ability', idempotencyKey: 'same-key' }, async () => ({
        noteId: 'package-id',
        versionToken: 'version-one',
      })),
    ).resolves.toEqual({
      result: { noteId: 'package-id', versionToken: 'version-one' },
      wasHit: false,
      persistenceFailed: true,
    })
    expect(error).toHaveBeenCalledWith('[mcp] idempotency persistence failed ->', 'db unavailable')
    error.mockRestore()
  })
})
