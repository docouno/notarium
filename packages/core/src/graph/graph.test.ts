import { describe, expect, it } from 'vitest'

import {
  type Graph,
  GRAPH_GHOST_TARGET,
  type GraphLink,
  type NoteMeta,
  type ResolvedVia,
} from '../knowledgeStore'
import { encodeWikilinkIdentity } from '../libs/markdown'
import { buildLinkIndex, resolveLink } from '../referenceResolver'
import { aggregateGraphHealth, dedupeEdges, deriveNoteEdges, shapeGraph } from './graph'

describe('dedupeEdges', () => {
  it('keeps first occurrence, preserves order, distinguishes by type', () => {
    const edges = [
      { source: 'a', target: 'b', type: 'links_to' },
      { source: 'a', target: 'b', type: 'links_to' },
      { source: 'a', target: 'b', type: 'mentions' },
      { source: 'b', target: 'a', type: 'links_to' },
    ]
    expect(dedupeEdges(edges)).toEqual([
      { source: 'a', target: 'b', type: 'links_to' },
      { source: 'a', target: 'b', type: 'mentions' },
      { source: 'b', target: 'a', type: 'links_to' },
    ])
  })
})

const meta = (filePath: string, title: string): NoteMeta => ({
  title,
  filePath,
  modifiedAt: '2026-06-10T00:00:00.000Z',
  createdAt: null,
})

const NOTES = [
  meta('demo/Titanium.md', 'Titanium'),
  meta('demo/Carbon.md', 'Carbon'),
  meta('BookStack.md', 'BookStack'),
]

describe('deriveNoteEdges', () => {
  const index = buildLinkIndex(NOTES)

  it('turns a note body into deduped edges, no self-loops, ghosts for misses', () => {
    const { edges, ghosts } = deriveNoteEdges(
      'demo/Titanium.md',
      'links [[Carbon]] twice [[Carbon]], itself [[Titanium]] and [[Nowhere]]',
      index,
      'links-to',
    )
    expect(edges).toEqual([
      { source: 'demo/Titanium.md', target: 'demo/Carbon.md', type: 'links-to' },
      {
        source: 'demo/Titanium.md',
        target: 'ghost:nowhere',
        type: 'links-to',
        [GRAPH_GHOST_TARGET]: true,
      },
    ])
    expect(ghosts.map((g) => g.id)).toEqual(['ghost:nowhere'])
  })
})

describe('shapeGraph', () => {
  it('builds nodes with degree, ghosts with sources; drops stale sources', () => {
    const edges = new Map([
      [
        'demo/Titanium.md',
        [
          { source: 'demo/Titanium.md', target: 'demo/Carbon.md', type: 'links-to' },
          { source: 'demo/Titanium.md', target: 'ghost:missing', type: 'links-to' },
        ],
      ],
      // a source that no longer exists — its edges must vanish
      ['gone.md', [{ source: 'gone.md', target: 'demo/Carbon.md', type: 'links-to' }]],
    ])
    const ghosts = new Map([
      [
        'ghost:missing',
        {
          id: 'ghost:missing',
          title: 'Missing',
          target: 'missing',
          prefillTitle: 'Missing',
          creatable: true,
        },
      ],
    ])
    const g = shapeGraph(NOTES, edges, ghosts)

    expect(g.links).toHaveLength(2)
    const titanium = g.nodes.find((n) => n.id === 'demo/Titanium.md')!
    const carbon = g.nodes.find((n) => n.id === 'demo/Carbon.md')!
    expect(titanium.degree).toBe(2)
    expect(carbon.degree).toBe(1)
    const ghost = g.nodes.find((n) => n.id === 'ghost:missing')!
    expect(ghost.ghost).toBe(true)
    expect(ghost.ghost && ghost.sources).toEqual([
      { id: 'demo/Titanium.md', title: 'Titanium', folder: 'demo' },
    ])
  })

  it('an edge to a vanished real note becomes a synthesized ghost', () => {
    const edges = new Map([
      [
        'demo/Titanium.md',
        [{ source: 'demo/Titanium.md', target: 'demo/Removed.md', type: 'links-to' }],
      ],
    ])
    const g = shapeGraph(NOTES, edges, new Map())
    const ghost = g.nodes.find((n) => n.id === 'demo/Removed.md')!
    expect(ghost.ghost).toBe(true)
    expect(ghost.title).toBe('Removed')
  })

  it('keeps a synthetic ghost distinct from a real opaque id with the same spelling', () => {
    const metas: NoteMeta[] = [
      { ...meta('source.md', 'Source'), id: 'source' },
      { ...meta('unrelated.md', 'Unrelated'), id: 'ghost:missing' },
    ]
    const index = buildLinkIndex(metas)
    const { edges, ghosts } = deriveNoteEdges('source', '[[missing]]', index, 'links-to')
    const edgeBuckets: Iterable<[string, GraphLink[]]> = (function* () {
      yield ['source', edges]
    })()
    const graph = shapeGraph(metas, edgeBuckets, new Map(ghosts.map((ghost) => [ghost.id, ghost])))
    const edge = graph.links.find((candidate) => candidate.source === 'source')!
    const target = graph.nodes.find((candidate) => candidate.id === edge.target)!
    const unrelated = graph.nodes.find((candidate) => candidate.id === 'ghost:missing')!

    expect(edge.target).not.toBe('ghost:missing')
    expect(target).toMatchObject({ ghost: true, target: 'missing', creatable: true })
    expect(unrelated).toMatchObject({ ghost: false, title: 'Unrelated', degree: 0 })
  })

  it('keeps real and ghost provenance when both share one raw target string', () => {
    const opaqueId = 'ghost:missing'
    const metas: NoteMeta[] = [
      { ...meta('source.md', 'Source'), id: 'source' },
      { ...meta('opaque.md', 'Opaque'), id: opaqueId },
    ]
    const index = buildLinkIndex(metas)
    const { edges, ghosts } = deriveNoteEdges(
      'source',
      `[[${encodeWikilinkIdentity(opaqueId)}|Opaque]]\n[[missing]]`,
      index,
      'links-to',
    )
    const graph = shapeGraph(
      metas,
      new Map([['source', edges]]),
      new Map(ghosts.map((ghost) => [ghost.id, ghost])),
    )
    const outgoing = graph.links.filter((edge) => edge.source === 'source')
    const real = graph.nodes.find((node) => node.id === opaqueId)!
    const ghost = graph.nodes.find(
      (node) => node.ghost && node.target === 'missing' && node.id !== opaqueId,
    )!

    expect(outgoing).toHaveLength(2)
    expect(outgoing.map((edge) => edge.target)).toEqual(expect.arrayContaining([real.id, ghost.id]))
    expect(real).toMatchObject({ ghost: false, degree: 1 })
    expect(ghost).toMatchObject({ ghost: true, degree: 1 })
  })

  it('skips self-loops and duplicate edges defensively', () => {
    const edges = new Map([
      [
        'demo/Titanium.md',
        [
          { source: 'demo/Titanium.md', target: 'demo/Titanium.md', type: 'links-to' },
          { source: 'demo/Titanium.md', target: 'demo/Carbon.md', type: 'links-to' },
          { source: 'demo/Titanium.md', target: 'demo/Carbon.md', type: 'links-to' },
        ],
      ],
    ])
    const g = shapeGraph(NOTES, edges, new Map())
    expect(g.links).toHaveLength(1)
  })
})

describe('resolvedVia provenance (#100)', () => {
  const notes: NoteMeta[] = [
    { ...meta('Gagarin.md', 'Гагарин'), aliases: ['Королёв'] }, // renamed: alias of a former title
    // A custom display slug that DIFFERS from the filename/title slug — else [[q3]]
    // would resolve via the filename ('current'), not the slug axis.
    { ...meta('q3-2024-report-final.md', 'Q3 2024 Report (Final)'), slug: 'q3' },
    meta('archive/Carbon.md', 'Carbon'), // moved out of demo/
  ]
  const folderAliases = [{ current: 'archive', alias: 'demo' }]

  it('omitting the provenance map leaves edges lean — the hot path pays nothing', () => {
    const index = buildLinkIndex(notes, folderAliases)
    expect(resolveLink('Королёв', index).resolvedVia).toBeUndefined()
    const { edges } = deriveNoteEdges('hub.md', 'see [[Королёв]]', index, 'links-to')
    expect(edges[0]).not.toHaveProperty('resolvedVia')
  })

  it('a note linking a target by BOTH current and former name collapses to current — order-independent', () => {
    // [[Гагарин]] (current) and [[Королёв]] (alias) hit the same note. The edge
    // dedups to ONE; the metric must not flip stale/healthy on which wikilink the
    // author happened to write first, and a body that already names the live note
    // isn't a back-fill target — so `current` wins either way.
    const expected = [
      { source: 'hub.md', target: 'Gagarin.md', type: 'links-to', resolvedVia: 'current' },
    ]
    const viaA = new Map<string, ResolvedVia>()
    const idxA = buildLinkIndex(notes, folderAliases, viaA)
    expect(
      deriveNoteEdges('hub.md', 'see [[Гагарин]] then [[Королёв]]', idxA, 'links-to', viaA).edges,
    ).toEqual(expected)
    const viaB = new Map<string, ResolvedVia>()
    const idxB = buildLinkIndex(notes, folderAliases, viaB)
    expect(
      deriveNoteEdges('hub.md', 'see [[Королёв]] then [[Гагарин]]', idxB, 'links-to', viaB).edges,
    ).toEqual(expected)
  })

  it('deriveNoteEdges stamps resolvedVia per edge when given the provenance map', () => {
    const via = new Map<string, ResolvedVia>()
    const index = buildLinkIndex(notes, folderAliases, via)
    const { edges } = deriveNoteEdges(
      'hub.md',
      'see [[Королёв]] and [[q3]]',
      index,
      'links-to',
      via,
    )
    expect(edges).toEqual([
      { source: 'hub.md', target: 'Gagarin.md', type: 'links-to', resolvedVia: 'note-alias' },
      {
        source: 'hub.md',
        target: 'q3-2024-report-final.md',
        type: 'links-to',
        resolvedVia: 'slug',
      },
    ])
  })
})

describe('aggregateGraphHealth (#100)', () => {
  it('counts links resolving through a former name and lists the broken links', () => {
    const metas: NoteMeta[] = [
      { ...meta('Gagarin.md', 'Гагарин'), aliases: ['Королёв'] },
      { ...meta('q3-2024-report-final.md', 'Q3 2024 Report (Final)'), slug: 'q3' },
      meta('archive/Carbon.md', 'Carbon'),
      meta('plain.md', 'Plain'),
      meta('hub.md', 'Hub'),
    ]
    const folderAliases = [{ current: 'archive', alias: 'demo' }]
    const via = new Map<string, ResolvedVia>()
    const index = buildLinkIndex(metas, folderAliases, via)
    const body = 'see [[Королёв]], [[q3]], [[demo/Carbon]], [[Plain]] and [[Nowhere]]'
    const { edges, ghosts } = deriveNoteEdges('hub.md', body, index, 'links-to', via)
    const edgesBySource = new Map<string, GraphLink[]>([['hub.md', edges]])
    const ghostMap = new Map(ghosts.map((g) => [g.id, g]))
    const health = aggregateGraphHealth(shapeGraph(metas, edgesBySource, ghostMap))

    // 4 resolved (non-ghost) edges; one each via slug / note-alias / folder-alias.
    expect(health.totalLinks).toBe(4)
    expect(health.via).toEqual({ slug: 1, noteAlias: 1, folderAlias: 1 })
    expect(health.staleNamed).toBe(2) // note-alias + folder-alias (a live slug is NOT stale)
    // The non-current edges, titled both ends for the card.
    expect(health.edges).toEqual(
      expect.arrayContaining([
        {
          source: { id: 'hub.md', title: 'Hub' },
          target: { id: 'Gagarin.md', title: 'Гагарин' },
          via: 'note-alias',
        },
        {
          source: { id: 'hub.md', title: 'Hub' },
          target: { id: 'archive/Carbon.md', title: 'Carbon' },
          via: 'folder-alias',
        },
        {
          source: { id: 'hub.md', title: 'Hub' },
          target: { id: 'q3-2024-report-final.md', title: 'Q3 2024 Report (Final)' },
          via: 'slug',
        },
      ]),
    )
    // [[Plain]] resolved via the current name → NOT in the stale list.
    expect(health.edges.some((e) => e.target.id === 'plain.md')).toBe(false)
    // The broken link + who points at it.
    expect(health.ghosts).toHaveLength(1)
    expect(health.ghosts[0]).toMatchObject({
      target: 'nowhere',
      refCount: 1,
      sources: [{ id: 'hub.md', title: 'Hub', folder: '' }],
    })
  })

  it('prioritizes broken links by unique source count, then stable target order', () => {
    const metas: NoteMeta[] = [
      meta('z/beta.md', 'Beta'),
      meta('a/alpha.md', 'Alpha'),
      meta('c/gamma.md', 'Gamma'),
      meta('d/delta.md', 'Delta'),
    ]
    const ghostMap = new Map([
      [
        'ghost:roadmap',
        {
          id: 'ghost:roadmap',
          title: 'Roadmap',
          target: 'roadmap',
          prefillTitle: 'Roadmap',
          creatable: true,
        },
      ],
      [
        'ghost:todo',
        {
          id: 'ghost:todo',
          title: 'Todo',
          target: 'todo',
          prefillTitle: 'Todo',
          creatable: true,
        },
      ],
      [
        'ghost:random-typo',
        {
          id: 'ghost:random-typo',
          title: 'Random typo',
          target: 'random-typo',
          prefillTitle: 'Random typo',
          creatable: true,
        },
      ],
    ])
    const edgesBySource = new Map<string, GraphLink[]>([
      [
        'z/beta.md',
        [
          { source: 'z/beta.md', target: 'ghost:roadmap', type: 'links-to' },
          { source: 'z/beta.md', target: 'ghost:todo', type: 'links-to' },
        ],
      ],
      [
        'a/alpha.md',
        [
          { source: 'a/alpha.md', target: 'ghost:roadmap', type: 'links-to' },
          { source: 'a/alpha.md', target: 'ghost:todo', type: 'links-to' },
        ],
      ],
      ['c/gamma.md', [{ source: 'c/gamma.md', target: 'ghost:roadmap', type: 'links-to' }]],
      ['d/delta.md', [{ source: 'd/delta.md', target: 'ghost:random-typo', type: 'links-to' }]],
    ])

    const health = aggregateGraphHealth(shapeGraph(metas, edgesBySource, ghostMap))

    expect(health.ghosts.map((g) => [g.target, g.refCount])).toEqual([
      ['roadmap', 3],
      ['todo', 2],
      ['random-typo', 1],
    ])
    expect(health.ghosts[0].sources.map((s) => `${s.folder}/${s.title}`)).toEqual([
      'a/Alpha',
      'c/Gamma',
      'z/Beta',
    ])
  })

  it('sorts equally referenced broken links by title, target and id', () => {
    const graph: Graph = {
      nodes: [
        {
          id: 'ghost:b',
          title: 'Beta',
          ghost: true,
          folder: '',
          degree: 1,
          target: 'beta',
          prefillTitle: 'Beta',
          creatable: true,
          sources: [{ id: 's', title: 'Source', folder: '' }],
        },
        {
          id: 'ghost:a',
          title: 'Alpha',
          ghost: true,
          folder: '',
          degree: 1,
          target: 'alpha',
          prefillTitle: 'Alpha',
          creatable: true,
          sources: [{ id: 's', title: 'Source', folder: '' }],
        },
      ],
      links: [],
    }

    const health = aggregateGraphHealth(graph)

    expect(health.ghosts.map((g) => g.target)).toEqual(['alpha', 'beta'])
  })

  it('a healthy graph reports zero stale and no ghosts', () => {
    const metas: NoteMeta[] = [meta('a.md', 'Alpha'), meta('b.md', 'Beta')]
    const via = new Map<string, ResolvedVia>()
    const index = buildLinkIndex(metas, [], via)
    const { edges, ghosts } = deriveNoteEdges('a.md', 'links [[Beta]]', index, 'links-to', via)
    const health = aggregateGraphHealth(
      shapeGraph(metas, new Map([['a.md', edges]]), new Map(ghosts.map((g) => [g.id, g]))),
    )
    expect(health).toMatchObject({
      totalLinks: 1,
      staleNamed: 0,
      via: { slug: 0, noteAlias: 0, folderAlias: 0 },
      edges: [],
      ghosts: [],
    })
  })
})

// #296 — a body whose links name notes in a script the slug algebra cannot
// romanise. Edge derivation is the surface here: every unsluggable ghost used to
// key on '', so all broken non-Latin links merged into one node. The resolver's
// own #296 cases live with their owner (referenceResolver.test.ts).
describe('non-Latin names in edge derivation (#296)', () => {
  it('keeps two broken non-Latin links as two distinct ghosts', () => {
    const index = buildLinkIndex([meta('a.md', 'Alpha')])
    const { edges, ghosts } = deriveNoteEdges(
      'a.md',
      'see [[缺失的笔记]] and [[遗失的另一篇]] and [[🎉/🚀]] and [[✨/💫]]',
      index,
      'links-to',
    )

    // Four missing notes, four ghosts — the multi-segment pair too: their slug is the
    // bare separator '/', which is truthy and used to merge them back together.
    expect(new Set(edges.map((e) => e.target)).size).toBe(4)
    expect(new Set(ghosts.map((g) => g.id)).size).toBe(4)
    expect(ghosts.some((g) => g.id === 'ghost:')).toBe(false)
    expect(ghosts.some((g) => g.id === 'ghost:/')).toBe(false)
  })
})
