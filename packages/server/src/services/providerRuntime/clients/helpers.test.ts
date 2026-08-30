import { performance } from 'node:perf_hooks'
import { describe, expect, it } from 'vitest'

import { ProviderLineDecoder } from './helpers'

describe('provider line decoder', () => {
  it('keeps UTF-8 and line boundaries across arbitrary transport chunks', () => {
    const decoder = new ProviderLineDecoder()
    const bytes = new TextEncoder().encode('first α\nsecond β\nlast γ')
    const lines = [
      ...decoder.push(bytes.subarray(0, 8)),
      ...decoder.push(bytes.subarray(8, 17)),
      ...decoder.push(bytes.subarray(17)),
      ...decoder.finish(),
    ]

    expect(lines).toEqual(['first α', 'second β', 'last γ'])
  })

  it('frames one large provider-controlled line in linear time', () => {
    const decoder = new ProviderLineDecoder()
    const chunk = new Uint8Array(64 * 1024).fill('a'.charCodeAt(0))
    const startedAt = performance.now()

    for (let offset = 0; offset < 8 * 1024 * 1024; offset += chunk.byteLength) {
      expect(decoder.push(chunk)).toEqual([])
    }
    const lines = decoder.finish()
    const elapsedMs = performance.now() - startedAt

    expect(lines).toHaveLength(1)
    expect(lines[0]).toHaveLength(8 * 1024 * 1024)
    // The former repeated-prefix scan took ~640 ms on the review host. The
    // incremental implementation is normally <30 ms; this deliberately loose
    // ceiling detects the old complexity without turning host jitter into flakes.
    expect(elapsedMs).toBeLessThan(500)
  })
})
