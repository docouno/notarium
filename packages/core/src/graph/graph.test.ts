import { describe, expect, it } from 'vitest'

import type { Graph, GraphLink, NoteMeta, ResolvedVia } from '../knowledgeStore'
import {
  aggregateGraphHealth,
  buildLinkIndex,
  dedupeEdges,
  deriveNoteEdges,
  resolveLink,
  shapeGraph,
} from './graph'

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

describe('resolveLink', () => {
  const index = buildLinkIndex(NOTES)

  it('resolves by title, filename and full path — case/spacing-insensitively', () => {
    expect(resolveLink('Titanium', index).targetId).toBe('demo/Titanium.md')
    expect(resolveLink('titanium', index).targetId).toBe('demo/Titanium.md')
    expect(resolveLink('demo/Titanium', index).targetId).toBe('demo/Titanium.md')
    // camelCase splits the same way on both sides of the index
    expect(resolveLink('Book Stack', index).targetId).toBe('BookStack.md')
  })

  it('falls back to the last path segment for a pathed link', () => {
    expect(resolveLink('elsewhere/Carbon', index).targetId).toBe('demo/Carbon.md')
  })

  it('misses become ghosts whose prefill slugs back to the target (#25)', () => {
    const { targetId, ghost } = resolveLink('Missing Element', index)
    expect(targetId).toBe('ghost:missing-element')
    expect(ghost).toMatchObject({ target: 'missing-element', prefillTitle: 'Missing Element' })
  })

  it('derives a readable prefill when the label cannot reproduce the slug', () => {
    const { ghost } = resolveLink('dir/missing-note', index)
    expect(ghost?.prefillTitle).toBe('Missing Note')
  })
})

describe('buildLinkIndex — alias-history (#100)', () => {
  const withAliases = (filePath: string, title: string, aliases: string[]): NoteMeta => ({
    ...meta(filePath, title),
    aliases,
  })

  it('registers each alias slug, so a renamed note resolves by its old name', () => {
    // 'Гагарин' was once 'Королёв'; 'Reading List' was once 'BookStack'.
    const index = buildLinkIndex([
      withAliases('Gagarin.md', 'Гагарин', ['Королёв']),
      withAliases('reading-list.md', 'Reading List', ['BookStack']),
    ])
    expect(resolveLink('Королёв', index).targetId).toBe('Gagarin.md')
    expect(resolveLink('Гагарин', index).targetId).toBe('Gagarin.md')
    // camelCase alias splits the SAME way (core slugify) on lookup
    expect(resolveLink('BookStack', index).targetId).toBe('reading-list.md')
    expect(resolveLink('Book Stack', index).targetId).toBe('reading-list.md')
  })

  it('collision rule: a live note is never shadowed by another note’s stale alias', () => {
    // 'Foo' is the CURRENT title of one note and a former alias of another.
    const index = buildLinkIndex([meta('foo.md', 'Foo'), withAliases('bar.md', 'Bar', ['Foo'])])
    // current name wins — [[Foo]] opens the live Foo, not Bar's history.
    expect(resolveLink('Foo', index).targetId).toBe('foo.md')
  })

  it('an alias only fills a key no current name claimed', () => {
    const index = buildLinkIndex([withAliases('bar.md', 'Bar', ['Unclaimed'])])
    expect(resolveLink('Unclaimed', index).targetId).toBe('bar.md')
    expect(resolveLink('Bar', index).targetId).toBe('bar.md')
  })
})

describe('buildLinkIndex — custom slug (#100)', () => {
  const withSlug = (filePath: string, title: string, slug: string): NoteMeta => ({
    ...meta(filePath, title),
    slug,
  })
  const withAlias = (filePath: string, title: string, aliases: string[]): NoteMeta => ({
    ...meta(filePath, title),
    aliases,
  })

  it('registers a custom slug as a resolve key, so [[my-slug]] reaches the note', () => {
    const index = buildLinkIndex([withSlug('q3.md', 'Q3 2024 Report (Final)', 'q3-report')])
    expect(resolveLink('q3-report', index).targetId).toBe('q3.md')
    expect(resolveLink('Q3 2024 Report (Final)', index).targetId).toBe('q3.md') // the title still resolves
  })

  it('a custom slug never shadows another live note’s title (primary > slug)', () => {
    // note B's custom slug equals note A's current title's slug.
    const index = buildLinkIndex([
      meta('a.md', 'Reading List'), // title slugs to 'reading-list'
      withSlug('b.md', 'B', 'reading-list'),
    ])
    expect(resolveLink('Reading List', index).targetId).toBe('a.md') // A's live title wins
  })

  it('a custom slug beats a stale alias (current > slug > alias)', () => {
    const index = buildLinkIndex([
      withSlug('live.md', 'Live', 'shared'),
      withAlias('old.md', 'Old', ['shared']),
    ])
    expect(resolveLink('shared', index).targetId).toBe('live.md') // the live slug, not the alias
  })
})

describe('buildLinkIndex — folder path-aliases (#100)', () => {
  it('resolves a path-form [[oldpath/note]] after the folder was renamed', () => {
    // The note now lives under `archive/`; it was once under `demo/`.
    const index = buildLinkIndex(
      [meta('archive/Carbon.md', 'Carbon')],
      [{ current: 'archive', alias: 'demo' }],
    )
    expect(resolveLink('demo/Carbon', index).targetId).toBe('archive/Carbon.md') // old path resolves
    expect(resolveLink('archive/Carbon', index).targetId).toBe('archive/Carbon.md') // current path too
  })

  it('disambiguates an ambiguous filename across the rename (the case last-segment can’t)', () => {
    // Two notes named `Note`; only the one MOVED from `a/` carries the folder-alias.
    const index = buildLinkIndex(
      [meta('a-new/Note.md', 'Note'), meta('b/Note.md', 'Note')],
      [{ current: 'a-new', alias: 'a' }],
    )
    // [[a/Note]] (the OLD full path) resolves to the moved note, NOT b/Note.
    expect(resolveLink('a/Note', index).targetId).toBe('a-new/Note.md')
  })

  it('rewrites a descendant path: [[old/sub/note]] after old→new', () => {
    const index = buildLinkIndex(
      [meta('new/sub/Carbon.md', 'Carbon')],
      [{ current: 'new', alias: 'old' }],
    )
    expect(resolveLink('old/sub/Carbon', index).targetId).toBe('new/sub/Carbon.md')
  })

  it('a folder-alias never shadows a LIVE note at that path (current > … > folder-alias)', () => {
    // A live note already sits at `demo/Carbon`; the folder-alias would map there too.
    const index = buildLinkIndex(
      [meta('demo/Carbon.md', 'Carbon'), meta('archive/Carbon.md', 'Carbon')],
      [{ current: 'archive', alias: 'demo' }],
    )
    // [[demo/Carbon]] opens the live one, not the archived note's old path.
    expect(resolveLink('demo/Carbon', index).targetId).toBe('demo/Carbon.md')
  })

  it('no folder-aliases ⇒ identical to the plain index (the engine passes none)', () => {
    expect([...buildLinkIndex(NOTES).entries()]).toEqual([...buildLinkIndex(NOTES, []).entries()])
  })
})

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
      { source: 'demo/Titanium.md', target: 'ghost:nowhere', type: 'links-to' },
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
        { id: 'ghost:missing', title: 'Missing', target: 'missing', prefillTitle: 'Missing' },
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

  it('buildLinkIndex records which axis claimed each resolved key', () => {
    const via = new Map<string, ResolvedVia>()
    const index = buildLinkIndex(notes, folderAliases, via)
    expect(resolveLink('Гагарин', index, via).resolvedVia).toBe('current')
    expect(resolveLink('Королёв', index, via).resolvedVia).toBe('note-alias')
    expect(resolveLink('q3', index, via).resolvedVia).toBe('slug')
    expect(resolveLink('demo/Carbon', index, via).resolvedVia).toBe('folder-alias')
    expect(resolveLink('archive/Carbon', index, via).resolvedVia).toBe('current') // current path beats the alias
  })

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

  it('a ghost (miss) carries no resolvedVia', () => {
    const via = new Map<string, ResolvedVia>()
    const index = buildLinkIndex(notes, folderAliases, via)
    expect(resolveLink('Nowhere', index, via).resolvedVia).toBeUndefined()
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
        { id: 'ghost:roadmap', title: 'Roadmap', target: 'roadmap', prefillTitle: 'Roadmap' },
      ],
      ['ghost:todo', { id: 'ghost:todo', title: 'Todo', target: 'todo', prefillTitle: 'Todo' }],
      [
        'ghost:random-typo',
        {
          id: 'ghost:random-typo',
          title: 'Random typo',
          target: 'random-typo',
          prefillTitle: 'Random typo',
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
