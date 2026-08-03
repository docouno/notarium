import type { MetaDb } from '@notarium/contract'

/** /api/about diagnostics the composition root knows but a request handler can't
 *  compute: effective search capability + deployment shape. */
export type HostInfo = {
  search: {
    vector: boolean
    embedderId: string | null
    embedderDims: number | null
    graphBoost: boolean
  }
  deployment: {
    authMode: 'password' | 'none'
    metaDb: MetaDb
    engines: { slug: string; engine: 'notarium' }[]
  }
}

/** Build the /api/about HostInfo. Structurally typed (no @notarium/engine import)
 *  so it unit-tests without booting a server. */
export const hostInfoFrom = (opts: {
  embedder?: { id: string; dimensions: number }
  searchTuning?: { wGraph?: number }
  authMode: 'password' | 'none'
  /** Which driver backs this host, already classified by the composition root
   *  (`services/metaDb`) — never re-derived from a URL here, where a second reading
   *  of the scheme would drift from the driver's own. */
  metaDbFlavour: MetaDb
  spaces: { slug: string; engine?: 'notarium' }[]
}): HostInfo => {
  const { embedder, searchTuning, authMode, metaDbFlavour, spaces } = opts
  return {
    search: {
      vector: Boolean(embedder),
      embedderId: embedder?.id ?? null,
      embedderDims: embedder?.dimensions ?? null,
      // undefined tuning ⇒ engine default wGraph 0.5 engages; { wGraph: 0 } ⇒ graph off.
      // canon: docs/search.md#graph-channel-hub-robust-1-hop
      graphBoost: Boolean(embedder) && !(searchTuning && searchTuning.wGraph === 0),
    },
    deployment: {
      authMode,
      metaDb: metaDbFlavour,
      engines: spaces.map((s) => ({ slug: s.slug, engine: s.engine ?? 'notarium' })),
    },
  }
}
