// Pins the #81 Stage-4b DEPLOY default for the graph search channel: it ships OFF.
// The engine default is wGraph 0.5 (ON), so the ONLY thing keeping graph off in
// production is main.ts mapping GRAPH_BOOST → searchTuning. Calibration showed the
// channel HURTS the one corpus we could measure (nDCG 0.2737 → 0.2468 at wGraph 0.5),
// so an inversion here would silently regress every deployment. This test fails the
// instant the default flips — the gap the inline ternary left uncovered.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import {
  graphSearchTuning,
  wikilinkParseCacheFromEnv,
} from '../../packages/server/src/apps/server/searchTuningEnv'

describe('graphSearchTuning — GRAPH_BOOST deploy gate (#81 Stage 4b)', () => {
  it('ships OFF: unset or "off" pins wGraph 0 so the third channel is inert', () => {
    expect(graphSearchTuning(undefined)).toEqual({ wGraph: 0 })
    expect(graphSearchTuning('off')).toEqual({ wGraph: 0 })
  })

  it('GRAPH_BOOST=on opts in: undefined tuning → the engine default (wGraph 0.5) engages', () => {
    expect(graphSearchTuning('on')).toBeUndefined()
    // Convention (matches VECTOR_SEARCH / EMBED_CPU_MEM_ARENA): only the literal "off"
    // disables — any other truthy-ish value opts in.
    expect(graphSearchTuning('1')).toBeUndefined()
    expect(graphSearchTuning('true')).toBeUndefined()
  })
})

describe('wikilinkParseCacheFromEnv — WIKILINK_PARSE_CACHE rollback gate (#410)', () => {
  it('ships ON and only literal "off" selects the reference derivation', () => {
    expect(wikilinkParseCacheFromEnv(undefined)).toBe(true)
    expect(wikilinkParseCacheFromEnv('on')).toBe(true)
    expect(wikilinkParseCacheFromEnv('1')).toBe(true)
    expect(wikilinkParseCacheFromEnv('off')).toBe(false)
  })

  it('carries the parsed mode from the process entrypoint into createServer', () => {
    const main = readFileSync('packages/server/src/apps/server/main.ts', 'utf8')
    const call = main.slice(main.indexOf('const app = await createServer({'))

    expect(call).toContain('wikilinkParseCache,')
  })

  it('keeps adjacency gate observations private to the server composition', () => {
    const main = readFileSync('packages/server/src/apps/server/main.ts', 'utf8')
    const server = readFileSync('packages/server/src/apps/server/server.ts', 'utf8')

    expect(main).toContain('process.env.GRAPH_ADJACENCY_OBSERVATION_FILE')
    expect(main).toContain('onGraphAdjacencyBuilt,')
    expect(server).toContain('onGraphAdjacencyBuilt: onGraphAdjacencyBuilt')
  })
})
