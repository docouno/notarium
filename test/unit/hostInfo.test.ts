// hostInfoFrom (#97): the pure derivation of /api/about's HostInfo from the
// composition root's facts. Unit-tested directly (no server boot) because the
// fake can't exercise the hybrid/embedder/graph branches — it wires no embedder.

import { describe, expect, it } from 'vitest'

import { hostInfoFrom } from '../../packages/server/src/libs/hostInfo'

describe('hostInfoFrom (#97)', () => {
  it('reports FTS-only when no embedder is wired', () => {
    const h = hostInfoFrom({ authMode: 'none', spaces: [{ slug: 'main' }] })
    expect(h.search).toEqual({
      vector: false,
      embedderId: null,
      embedderDims: null,
      graphBoost: false,
    })
  })

  it('reports the wired embedder and engages the graph channel by default', () => {
    const h = hostInfoFrom({
      embedder: { id: 'Xenova/bge-m3@q8', dimensions: 1024 },
      // undefined tuning ⇒ the engine default (wGraph 0.5) engages
      authMode: 'password',
      spaces: [],
    })
    expect(h.search).toEqual({
      vector: true,
      embedderId: 'Xenova/bge-m3@q8',
      embedderDims: 1024,
      graphBoost: true,
    })
  })

  it('turns graphBoost off when the tuning pins wGraph to 0 (the shipped default)', () => {
    const h = hostInfoFrom({
      embedder: { id: 'm', dimensions: 8 },
      searchTuning: { wGraph: 0 },
      authMode: 'none',
      spaces: [],
    })
    expect(h.search.graphBoost).toBe(false)
  })

  it('keeps graphBoost inert without an embedder even if the tuning leaves it on', () => {
    const h = hostInfoFrom({ searchTuning: undefined, authMode: 'none', spaces: [] })
    expect(h.search.graphBoost).toBe(false)
  })

  it('detects the meta-DB kind from the URL scheme (both postgres spellings)', () => {
    const mk = (metaDbUrl?: string) =>
      hostInfoFrom({ authMode: 'none', spaces: [], metaDbUrl }).deployment.metaDb
    expect(mk('sqlite:.data/meta.db')).toBe('sqlite')
    expect(mk('postgres://u@h/db')).toBe('postgres')
    expect(mk('postgresql://u@h/db')).toBe('postgres')
    expect(mk(undefined)).toBe('none')
  })

  it('maps per-space engines, defaulting an unset engine to notarium', () => {
    const h = hostInfoFrom({
      authMode: 'none',
      spaces: [{ slug: 'a', engine: 'notarium' }, { slug: 'b' }],
    })
    expect(h.deployment.engines).toEqual([
      { slug: 'a', engine: 'notarium' },
      { slug: 'b', engine: 'notarium' },
    ])
  })

  it('passes the auth mode through', () => {
    expect(hostInfoFrom({ authMode: 'password', spaces: [] }).deployment.authMode).toBe('password')
  })
})
