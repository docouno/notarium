import { describe, expect, it, vi } from 'vitest'

import { WikilinkLabelCache } from './wikilinkLabelCache'

describe('WikilinkLabelCache', () => {
  it('single-flights one row generation and clears the in-flight slot', async () => {
    const cache = new WikilinkLabelCache()
    let release!: (labels: readonly string[]) => void
    const loader = vi.fn(
      () =>
        new Promise<readonly string[]>((resolve) => {
          release = resolve
        }),
    )

    const first = cache.load(7, 1, 'a'.repeat(64), loader)
    const second = cache.load(7, 1, 'a'.repeat(64), loader)

    expect(loader).toHaveBeenCalledTimes(1)
    expect(cache.stats().inFlight).toBe(1)
    release(['Target'])
    await expect(Promise.all([first, second])).resolves.toEqual([['Target'], ['Target']])
    expect(cache.stats()).toMatchObject({ entries: 1, inFlight: 0, loads: 1, joins: 1 })
  })

  it('does not let an older async fill overwrite a newer write-through publication', async () => {
    const cache = new WikilinkLabelCache()
    let release!: (labels: readonly string[]) => void
    const old = cache.load(
      11,
      1,
      'a'.repeat(64),
      () =>
        new Promise<readonly string[]>((resolve) => {
          release = resolve
        }),
    )

    const publication = cache.beginPublication(11, 2)
    cache.publish(publication, 'b'.repeat(64), ['New'])
    release(['Old'])
    await expect(old).resolves.toEqual(['Old'])
    expect(cache.get(11, 'b'.repeat(64))).toEqual(['New'])
    expect(cache.get(11, 'a'.repeat(64))).toBeUndefined()
  })

  it('keeps rejected loads retryable and bounds settled entries by authoritative rowids', async () => {
    const cache = new WikilinkLabelCache()
    const hash = 'c'.repeat(64)

    await expect(
      cache.load(1, 1, hash, async () => {
        throw new Error('transient')
      }),
    ).rejects.toThrow('transient')
    await expect(cache.load(1, 1, hash, async () => ['Recovered'])).resolves.toEqual(['Recovered'])
    cache.publish(cache.beginPublication(2, 2), 'd'.repeat(64), ['Drop'])
    cache.prune(new Set([1]))

    expect(cache.stats()).toMatchObject({
      entries: 1,
      inFlight: 0,
      loads: 2,
      rejectedLoads: 1,
      pruned: 1,
    })
    expect(cache.get(1, hash)).toEqual(['Recovered'])
    expect(cache.get(2, 'd'.repeat(64))).toBeUndefined()
  })

  it('does not republish a deleted row when its loader settles after eviction', async () => {
    const cache = new WikilinkLabelCache()
    const hash = 'e'.repeat(64)
    let release!: (labels: readonly string[]) => void
    const loading = cache.load(
      23,
      1,
      hash,
      () =>
        new Promise<readonly string[]>((resolve) => {
          release = resolve
        }),
    )

    cache.evict([23])
    release(['Stale'])
    await expect(loading).resolves.toEqual(['Stale'])
    expect(cache.get(23, hash)).toBeUndefined()
    expect(cache.stats()).toMatchObject({ entries: 0, inFlight: 0 })
  })

  it('does not let delayed write-through republish after delete or a newer generation', () => {
    const cache = new WikilinkLabelCache()
    const deleted = cache.beginPublication(31, 1)

    cache.evict([31])
    expect(cache.publish(deleted, 'a'.repeat(64), ['Deleted'])).toBe(false)
    expect(cache.get(31, 'a'.repeat(64))).toBeUndefined()

    const older = cache.beginPublication(41, 2)
    const newer = cache.beginPublication(41, 3)

    expect(cache.publish(newer, 'c'.repeat(64), ['Newer'])).toBe(true)
    expect(cache.publish(older, 'b'.repeat(64), ['Older'])).toBe(false)
    expect(cache.get(41, 'c'.repeat(64))).toEqual(['Newer'])
  })

  it('lets the current conditional loader replace an older different-generation entry', async () => {
    const cache = new WikilinkLabelCache()
    cache.publish(cache.beginPublication(51, 1), 'a'.repeat(64), ['Old'])

    await expect(cache.load(51, 2, 'b'.repeat(64), async () => ['Current'])).resolves.toEqual([
      'Current',
    ])
    expect(cache.get(51, 'b'.repeat(64))).toEqual(['Current'])
  })

  it('does not let an older loader republish after the current publication is discarded', async () => {
    const cache = new WikilinkLabelCache()
    let release!: (labels: readonly string[]) => void
    const loading = cache.load(
      61,
      1,
      'a'.repeat(64),
      () =>
        new Promise<readonly string[]>((resolve) => {
          release = resolve
        }),
    )

    cache.discardPublication(cache.beginPublication(61, 2))
    release(['Old-visible-label'])
    await expect(loading).resolves.toEqual(['Old-visible-label'])
    expect(cache.get(61, 'a'.repeat(64))).toBeUndefined()
    expect(cache.stats()).toMatchObject({ entries: 0, inFlight: 0 })
  })
})
