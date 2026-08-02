import { META_DB } from '@notarium/contract'

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
    metaDb: 'sqlite' | 'postgres' | 'none'
    engines: { slug: string; engine: 'notarium' }[]
  }
}

/** Build the /api/about HostInfo. Structurally typed (no @notarium/engine import)
 *  so it unit-tests without booting a server. */
export const hostInfoFrom = (opts: {
  embedder?: { id: string; dimensions: number }
  searchTuning?: { wGraph?: number }
  authMode: 'password' | 'none'
  metaDbUrl?: string
  spaces: { slug: string; engine?: 'notarium' }[]
}): HostInfo => {
  const { embedder, searchTuning, authMode, metaDbUrl, spaces } = opts
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
      metaDb: metaDbUrl?.startsWith('postgres')
        ? META_DB.postgres
        : metaDbUrl?.startsWith('sqlite')
          ? META_DB.sqlite
          : META_DB.none,
      engines: spaces.map((s) => ({ slug: s.slug, engine: s.engine ?? 'notarium' })),
    },
  }
}
