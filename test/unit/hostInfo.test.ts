// hostInfoFrom (#97): the pure derivation of /api/about's HostInfo from the
// composition root's facts. Unit-tested directly (no server boot) because the
// fake can't exercise the hybrid/embedder/graph branches — it wires no embedder.

import { describe, expect, it } from 'vitest'

import type { CredentialKeyringStatus } from '@notarium/contract'

import { hostInfoFrom } from '../../packages/server/src/libs/hostInfo'

describe('hostInfoFrom (#97)', () => {
  it('reports FTS-only when no embedder is wired', () => {
    const h = hostInfoFrom({ authMode: 'none', metaDbFlavour: 'none', spaces: [{ slug: 'main' }] })
    expect(h.search).toEqual({
      vector: false,
      embedderId: null,
      embedderDims: null,
      graphBoost: false,
    })
    expect(h.deployment.providers).toBe(false)
  })

  it('publishes the explicit provider-subsystem capability', () => {
    const credentialKeyring: { status: CredentialKeyringStatus } = { status: 'ready' }
    const input = {
      authMode: 'none' as const,
      metaDbFlavour: 'none' as const,
      spaces: [],
      providers: true,
      credentialKeyring,
    }

    const host = hostInfoFrom(input)
    expect(host.deployment.providers).toBe(true)
    expect(host.deployment.credentialKeyring).toBe(credentialKeyring)
    credentialKeyring.status = 'unreadable'
    expect(host.deployment.credentialKeyring?.status).toBe('unreadable')
  })

  it('reports the wired embedder and engages the graph channel by default', () => {
    const h = hostInfoFrom({
      embedder: { id: 'Xenova/bge-m3@q8', dimensions: 1024 },
      // undefined tuning ⇒ the engine default (wGraph 0.5) engages
      authMode: 'password',
      metaDbFlavour: 'sqlite',
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
      metaDbFlavour: 'sqlite',
      spaces: [],
    })
    expect(h.search.graphBoost).toBe(false)
  })

  it('keeps graphBoost inert without an embedder even if the tuning leaves it on', () => {
    const h = hostInfoFrom({
      searchTuning: undefined,
      authMode: 'none',
      metaDbFlavour: 'none',
      spaces: [],
    })
    expect(h.search.graphBoost).toBe(false)
  })

  it('publishes the flavour the composition root classified, under the wire name', () => {
    // It no longer reads a URL at all — `metaDbFlavourOf` owns that, with its own
    // cases. What is left to pin here is the rename across the boundary: the input is
    // `metaDbFlavour`, the wire field stays `deployment.metaDb`.
    const mk = (metaDbFlavour: 'sqlite' | 'postgres' | 'none') =>
      hostInfoFrom({ authMode: 'none', metaDbFlavour, spaces: [] }).deployment.metaDb
    expect(mk('sqlite')).toBe('sqlite')
    expect(mk('postgres')).toBe('postgres')
    expect(mk('none')).toBe('none')
  })

  it('maps per-space engines, defaulting an unset engine to notarium', () => {
    const h = hostInfoFrom({
      authMode: 'none',
      metaDbFlavour: 'none',
      spaces: [{ slug: 'a', engine: 'notarium' }, { slug: 'b' }],
    })
    expect(h.deployment.engines).toEqual([
      { slug: 'a', engine: 'notarium' },
      { slug: 'b', engine: 'notarium' },
    ])
  })

  it('passes the auth mode through', () => {
    expect(
      hostInfoFrom({ authMode: 'password', metaDbFlavour: 'sqlite', spaces: [] }).deployment
        .authMode,
    ).toBe('password')
  })
})
