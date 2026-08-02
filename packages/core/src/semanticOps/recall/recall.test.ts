import { describe, expect, it } from 'vitest'

import type {
  Graph,
  GraphGhostNode,
  GraphRealNode,
  KnowledgeStore,
  NoteClass,
  NoteContent,
  NoteMeta,
  SearchResult,
} from '../../knowledgeStore'
import { planNeighbours, rankScore, recall } from './recall'
import type { RecallTarget } from './types'

// ── pure helpers ─────────────────────────────────────────────────────────────

describe('rankScore', () => {
  it('every seed outranks every neighbour (hop dominates)', () => {
    const seed = { noteId: 's', hop: 0, score: 0, sameCommunity: false }
    const neighbour = { noteId: 'n', hop: 1, score: 0, sameCommunity: true }
    expect(rankScore(seed)).toBeGreaterThan(rankScore(neighbour))
  })

  it('orders seeds by their FTS score', () => {
    const hi = { noteId: 'a', hop: 0, score: 9, sameCommunity: false }
    const lo = { noteId: 'b', hop: 0, score: 2, sameCommunity: false }
    expect(rankScore(hi)).toBeGreaterThan(rankScore(lo))
  })

  it('boosts a same-community neighbour above a same-hop stranger', () => {
    const inComm = { noteId: 'a', hop: 1, score: 0, sameCommunity: true }
    const stranger = { noteId: 'b', hop: 1, score: 0, sameCommunity: false }
    expect(rankScore(inComm)).toBeGreaterThan(rankScore(stranger))
  })

  it('does not boost a seed for community (the boost is a neighbour signal)', () => {
    const a = { noteId: 'a', hop: 0, score: 1, sameCommunity: true }
    const b = { noteId: 'b', hop: 0, score: 1, sameCommunity: false }
    expect(rankScore(a)).toBe(rankScore(b))
  })

  it('survives the RRF-scale score change: a tiny seed score still beats a boosted neighbour (#81)', () => {
    // Hybrid search emits RRF scores (~0.01–0.03 = 1/(60+rank)), far smaller than
    // the bm25-flip scale (~0.5–20) this ranker was first tuned against. HOP_PENALTY
    // (1000) dwarfs BOTH scales, so a seed (hop 0) still outranks every neighbour
    // (hop ≥1) regardless of the search backend — no recalibration needed.
    const rrfSeed = { noteId: 's', hop: 0, score: 1 / (60 + 1), sameCommunity: false } // best RRF rank
    const boostedNeighbour = { noteId: 'n', hop: 1, score: 0, sameCommunity: true }
    expect(rankScore(rrfSeed)).toBeGreaterThan(rankScore(boostedNeighbour))
    // And RRF scores still order seeds relative to each other (rank 1 above rank 5).
    const rank1 = { noteId: 'a', hop: 0, score: 1 / (60 + 1), sameCommunity: false }
    const rank5 = { noteId: 'b', hop: 0, score: 1 / (60 + 5), sameCommunity: false }
    expect(rankScore(rank1)).toBeGreaterThan(rankScore(rank5))
  })
})

// ── planNeighbours: the pure BFS over the space graph ─────────────────────────

const rnode = (id: string, community?: number): GraphRealNode => ({
  id,
  title: id,
  filePath: `${id}.md`,
  folder: '',
  ghost: false,
  degree: 0,
  community,
})
const ghost = (id: string): GraphGhostNode => ({
  id,
  title: id,
  ghost: true,
  folder: '',
  degree: 0,
  target: id,
  prefillTitle: id,
})
const graphOf = (
  nodes: Array<GraphRealNode | GraphGhostNode>,
  links: Array<[string, string]>,
): Graph => ({
  nodes,
  links: links.map(([source, target]) => ({ source, target, type: 'links_to' })),
})

describe('planNeighbours', () => {
  it('depth 0 = the seeds only, keeping their FTS score', () => {
    const out = planNeighbours(
      [
        { id: 'a', score: 5 },
        { id: 'b', score: 3 },
      ],
      { nodes: [], links: [] },
      0,
    )
    expect(out).toEqual([
      { noteId: 'a', hop: 0, score: 5, sameCommunity: false },
      { noteId: 'b', hop: 0, score: 3, sameCommunity: false },
    ])
  })

  it('depth 1 pulls graph neighbours in BOTH directions (undirected)', () => {
    // a → c (out), d → b (in). Both c and d are 1-hop context of {a, b}.
    const graph = graphOf(
      [rnode('a'), rnode('b'), rnode('c'), rnode('d')],
      [
        ['a', 'c'],
        ['d', 'b'],
      ],
    )
    const out = planNeighbours(
      [
        { id: 'a', score: 1 },
        { id: 'b', score: 1 },
      ],
      graph,
      1,
    )
    const byId = new Map(out.map((c) => [c.noteId, c]))
    expect(byId.get('c')?.hop).toBe(1)
    expect(byId.get('d')?.hop).toBe(1)
    expect(byId.get('a')?.hop).toBe(0)
  })

  it('flags a neighbour that shares a seed community', () => {
    const graph = graphOf(
      [rnode('a', 1), rnode('c', 1), rnode('e', 2)],
      [
        ['a', 'c'],
        ['a', 'e'],
      ],
    )
    const out = planNeighbours([{ id: 'a', score: 1 }], graph, 1)
    const byId = new Map(out.map((c) => [c.noteId, c]))
    expect(byId.get('c')?.sameCommunity).toBe(true) // community 1, same as seed a
    expect(byId.get('e')?.sameCommunity).toBe(false) // community 2
  })

  it('skips ghost targets (an unresolved wikilink has no note to read)', () => {
    const graph = graphOf([rnode('a'), ghost('ghost:x')], [['a', 'ghost:x']])
    const out = planNeighbours([{ id: 'a', score: 1 }], graph, 1)
    expect(out.map((c) => c.noteId)).toEqual(['a']) // the ghost is not a candidate
  })

  it('a note reachable as both a seed and a neighbour stays a seed (no duplicate)', () => {
    const graph = graphOf([rnode('a'), rnode('b')], [['a', 'b']])
    const out = planNeighbours(
      [
        { id: 'a', score: 1 },
        { id: 'b', score: 1 },
      ],
      graph,
      1,
    )
    expect(out.filter((c) => c.noteId === 'b')).toHaveLength(1)
    expect(out.find((c) => c.noteId === 'b')?.hop).toBe(0) // seed wins
  })

  it('depth 2 reaches two hops out', () => {
    const graph = graphOf(
      [rnode('a'), rnode('b'), rnode('c')],
      [
        ['a', 'b'],
        ['b', 'c'],
      ],
    )
    const out = planNeighbours([{ id: 'a', score: 1 }], graph, 2)
    const byId = new Map(out.map((c) => [c.noteId, c]))
    expect(byId.get('b')?.hop).toBe(1)
    expect(byId.get('c')?.hop).toBe(2)
  })
})

// ── recall: search → graph → read → rank → budget-assemble ───────────────────

type FakeNote = {
  id: string
  title: string
  content: string
  class?: NoteClass
  score?: number
  /** The agent-memory `muted` opt-out — served back via read.frontmatter. */
  muted?: boolean
  /** Storage path; defaults to `${id}.md` at the root. Drives the project-scope narrow
   *  filter (subtree match) and the projectOf resolver. */
  filePath?: string
}

const fpOf = (n: FakeNote): string => n.filePath ?? `${n.id}.md`

/** A minimal read-model-shaped store for recall: list + search (substring, scope
 *  ignored as a bare engine would), graph (static) and read (by id). `failRead`
 *  models a note that vanished between the snapshot and the read. */
const fakeStore = (
  notes: FakeNote[],
  graph: Graph = { nodes: [], links: [] },
  opts: { failRead?: Set<string> } = {},
): KnowledgeStore =>
  ({
    list: async (): Promise<NoteMeta[]> =>
      notes.map((n) => ({
        id: n.id,
        title: n.title,
        class: n.class,
        filePath: fpOf(n),
        modifiedAt: null,
        createdAt: null,
      })),
    search: async (q: string): Promise<SearchResult[]> => {
      const needle = q.toLowerCase()
      return notes
        .filter(
          (n) => n.title.toLowerCase().includes(needle) || n.content.toLowerCase().includes(needle),
        )
        .map((n) => ({
          id: n.id,
          title: n.title,
          snippet: n.content.slice(0, 40),
          score: n.score ?? 1,
          class: n.class,
        }))
    },
    graph: async (): Promise<Graph> => graph,
    read: async (id: string): Promise<NoteContent> => {
      if (opts.failRead?.has(id)) {
        throw new Error('gone')
      }
      const n = notes.find((x) => x.id === id)

      if (!n) {
        throw new Error('not found')
      }

      return {
        id: n.id,
        title: n.title,
        content: n.content,
        class: n.class,
        filePath: fpOf(n),
        frontmatter: n.muted ? { muted: true } : {},
        versionToken: 't',
      }
    },
  }) as unknown as KnowledgeStore

const target = (slug: string, store: KnowledgeStore, isPersonal = false): RecallTarget => ({
  slug,
  isPersonal,
  store,
})

describe('recall', () => {
  it('assembles a context bundle from the FTS seeds, highest score first', async () => {
    const store = fakeStore([
      { id: 'a', title: 'Alpha', content: 'topic alpha', score: 2 },
      { id: 'b', title: 'Beta', content: 'topic beta', score: 9 },
    ])
    const res = await recall([target('team', store)], {
      query: 'topic',
      budgetTokens: 4000,
      depth: 0,
    })
    expect(res.sources.map((s) => s.noteId)).toEqual(['b', 'a']) // score 9 before 2
    expect(res.context).toContain('## Alpha (team)')
    expect(res.context).toContain('## Beta (team)')
    expect(res.truncated).toBe(false)
  })

  it('pulls a graph neighbour into the bundle at depth 1', async () => {
    const graph = graphOf([rnode('a'), rnode('n')], [['a', 'n']])
    const store = fakeStore(
      [
        { id: 'a', title: 'Seed', content: 'find me' },
        { id: 'n', title: 'Neighbour', content: 'unrelated body' }, // not an FTS hit; reached by graph
      ],
      graph,
    )
    const res = await recall([target('team', store)], {
      query: 'find me',
      budgetTokens: 4000,
      depth: 1,
    })
    expect(res.sources.map((s) => s.noteId)).toContain('n')
    expect(res.sources[0].noteId).toBe('a') // the seed ranks above its neighbour
  })

  it('marks a personal-domain source with no space, a non-personal source with its space', async () => {
    const personal = fakeStore([{ id: 'p', title: 'Mem', content: 'topic here' }])
    const project = fakeStore([{ id: 'k', title: 'Doc', content: 'topic here' }])
    const res = await recall([target('alice-personal', personal, true), target('team', project)], {
      query: 'topic',
      budgetTokens: 4000,
      depth: 0,
    })
    const p = res.sources.find((s) => s.noteId === 'p')
    const k = res.sources.find((s) => s.noteId === 'k')
    expect(p?.space).toBeUndefined()
    expect(k?.space).toBe('team')
    expect(res.context).toContain('## Mem (personal)')
  })

  it('drops a muted agent-memory category — the human opt-out hides it from recall (#207)', async () => {
    const store = fakeStore([
      { id: 'live', title: 'decisions', content: 'topic kept', class: 'agent-memory', score: 5 },
      {
        id: 'hush',
        title: 'stale',
        content: 'topic muted',
        class: 'agent-memory',
        score: 9,
        muted: true,
      },
      { id: 'doc', title: 'Doc', content: 'topic doc', class: 'user-doc', score: 1 },
    ])
    const res = await recall([target('team', store)], {
      query: 'topic',
      budgetTokens: 4000,
      depth: 0,
    })
    const ids = res.sources.map((s) => s.noteId)
    expect(ids).toContain('live') // a non-muted memory category is recalled
    expect(ids).toContain('doc') // user-docs are never affected by mute
    expect(ids).not.toContain('hush') // the muted category is hidden despite its top FTS score
  })

  it('truncates honestly: fits the top note whole, drops the rest', async () => {
    // Each block is ~222 chars; budgetTokens 60 (240 chars) holds one whole note
    // but not two.
    const big = 'x'.repeat(200)
    const store = fakeStore([
      { id: 'a', title: 'A', content: big, score: 9 },
      { id: 'b', title: 'B', content: big, score: 1 },
    ])
    const res = await recall([target('team', store)], { query: 'x', budgetTokens: 60, depth: 0 })
    expect(res.truncated).toBe(true)
    expect(res.sources.map((s) => s.noteId)).toEqual(['a']) // only the top one fit
    expect(res.context).toContain(big) // included WHOLE, not sliced
  })

  it('never exceeds budgetTokens × 4 chars — the "\\n\\n" separators are counted', async () => {
    // Many small blocks whose lengths leave zero ceil-slack, so an uncounted
    // separator would push the joined bundle over the cap.
    const notes = Array.from({ length: 20 }, (_, i) => ({
      id: `n${i}`,
      title: 'TT',
      content: 'topiccc!',
    }))
    const budgetTokens = 40
    const res = await recall([target('team', fakeStore(notes))], {
      query: 'topiccc',
      budgetTokens,
      depth: 0,
    })
    expect(res.truncated).toBe(true) // more notes than fit
    expect(res.context.length).toBeLessThanOrEqual(budgetTokens * 4) // cap honoured, separators included
  })

  it('includes the top note sliced to budget when it alone overflows (never empty)', async () => {
    const huge = 'y'.repeat(10_000)
    const store = fakeStore([{ id: 'a', title: 'A', content: huge, score: 9 }])
    const res = await recall([target('team', store)], { query: 'y', budgetTokens: 10, depth: 0 })
    expect(res.truncated).toBe(true)
    expect(res.sources.map((s) => s.noteId)).toEqual(['a'])
    expect(res.context.length).toBeLessThanOrEqual(10 * 4) // capped at budget × 4 chars
    expect(res.context.endsWith('…')).toBe(true)
  })

  it('maxPerSource trims each source so a large note does not starve a neighbour (#102 width)', async () => {
    const big = `topic ${'z'.repeat(4000)}`
    const store = fakeStore([
      { id: 'a', title: 'A', content: big, score: 9 },
      { id: 'b', title: 'B', content: 'topic small companion', score: 1 },
    ])
    // Budget chosen so WITHOUT the cap 'a' (block ~4kB) alone fills it and 'b' drops —
    // the cap is what lets the neighbour in (the test fails if the feature is removed).
    const res = await recall([target('team', store)], {
      query: 'topic',
      budgetTokens: 1010,
      depth: 0,
      maxPerSource: 200,
    })
    expect(res.sources.map((s) => s.noteId).sort()).toEqual(['a', 'b'])
    expect(res.truncated).toBe(true) // 'a' was trimmed
    expect(res.context).toContain('…') // the ellipsis marking 'a''s cut
  })

  it('the default per-source cap protects against a hyper-large note when none is passed (#102)', async () => {
    // 'a' alone (block ~10kB) would fill the 2500-token (10kB) budget and drop 'b'.
    const big = `topic ${'z'.repeat(9971)}`
    const store = fakeStore([
      { id: 'a', title: 'A', content: big, score: 9 },
      { id: 'b', title: 'B', content: 'topic small companion', score: 1 },
    ])
    const res = await recall([target('team', store)], {
      query: 'topic',
      budgetTokens: 2500,
      depth: 0,
    })
    // The default cap (half the budget) trims 'a' so the neighbour still fits.
    expect(res.sources.map((s) => s.noteId).sort()).toEqual(['a', 'b'])
    expect(res.truncated).toBe(true)
  })

  it('drops a non-agentRecall class even if it surfaced (defence-in-depth)', async () => {
    const store = fakeStore([
      { id: 'a', title: 'Doc', content: 'topic', class: 'user-doc' },
      { id: 'd', title: 'Derived', content: 'topic', class: 'derived' }, // not an agentRecall class
    ])
    const res = await recall([target('team', store)], {
      query: 'topic',
      budgetTokens: 4000,
      depth: 0,
    })
    expect(res.sources.map((s) => s.noteId)).toEqual(['a']) // derived excluded
  })

  it('skips a candidate that vanished between snapshot and read, without failing', async () => {
    const store = fakeStore(
      [
        { id: 'a', title: 'A', content: 'topic', score: 9 },
        { id: 'b', title: 'B', content: 'topic', score: 1 },
      ],
      { nodes: [], links: [] },
      { failRead: new Set(['a']) }, // top hit is gone
    )
    const res = await recall([target('team', store)], {
      query: 'topic',
      budgetTokens: 4000,
      depth: 0,
    })
    expect(res.sources.map((s) => s.noteId)).toEqual(['b']) // a skipped, b still returned
    expect(res.truncated).toBe(false) // a vanished note is not budget truncation
  })

  it('fans out across spaces and ranks globally', async () => {
    const s1 = fakeStore([{ id: 'x', title: 'X', content: 'topic', score: 3 }])
    const s2 = fakeStore([{ id: 'y', title: 'Y', content: 'topic', score: 8 }])
    const res = await recall([target('one', s1), target('two', s2)], {
      query: 'topic',
      budgetTokens: 4000,
      depth: 0,
    })
    expect(res.sources.map((s) => s.noteId)).toEqual(['y', 'x']) // global score order
  })

  it('returns an empty bundle (no sources) when nothing matches', async () => {
    const store = fakeStore([{ id: 'a', title: 'A', content: 'something else' }])
    const res = await recall([target('team', store)], {
      query: 'nomatch',
      budgetTokens: 4000,
      depth: 0,
    })
    expect(res.sources).toEqual([])
    expect(res.context).toBe('')
    expect(res.truncated).toBe(false)
  })

  // ── project-scope narrowing + project labelling ────────────────────
  describe('narrow (project-scope #13 I2)', () => {
    // One space holding two projects' content + about-user memory, all matching the
    // query — the narrow must keep ONLY the hinted project's slice.
    const space = (): KnowledgeStore =>
      fakeStore([
        {
          id: 'doc-a',
          title: 'A doc',
          content: 'topic',
          filePath: 'projA/a.md',
          class: 'user-doc',
        },
        {
          id: 'doc-b',
          title: 'B doc',
          content: 'topic',
          filePath: 'projB/b.md',
          class: 'user-doc',
        },
        {
          id: 'mem-a',
          title: 'decisions',
          content: 'topic',
          filePath: 'pA/decisions.md',
          class: 'agent-memory',
        },
        {
          id: 'mem-b',
          title: 'decisions',
          content: 'topic',
          filePath: 'pB/decisions.md',
          class: 'agent-memory',
        },
        {
          id: 'mem-user',
          title: 'prefs',
          content: 'topic',
          filePath: 'prefs.md',
          class: 'agent-memory',
        }, // root = about-user
      ])

    it('keeps the project subtree user-docs + its memory subdir, drops siblings AND about-user', async () => {
      const res = await recall(
        [
          {
            slug: 'team',
            isPersonal: false,
            store: space(),
            narrow: { pathPrefix: 'projA', memorySubdir: 'pA' },
          },
        ],
        { query: 'topic', budgetTokens: 4000, depth: 0 },
      )
      // projA's doc + pA's memory only — projB's doc, pB's memory, and the root
      // about-user memory (subdir '') are all narrowed out.
      expect(res.sources.map((s) => s.noteId).sort()).toEqual(['doc-a', 'mem-a'])
    })

    it('a root project (pathPrefix "") keeps the whole space, still only its memory subdir', async () => {
      const res = await recall(
        [
          {
            slug: 'team',
            isPersonal: false,
            store: space(),
            narrow: { pathPrefix: '', memorySubdir: 'pA' },
          },
        ],
        { query: 'topic', budgetTokens: 4000, depth: 0 },
      )
      // All user-docs (root owns the whole subtree) + pA memory; sibling pB memory
      // and root about-user memory still excluded (only memorySubdir 'pA' admitted).
      expect(res.sources.map((s) => s.noteId).sort()).toEqual(['doc-a', 'doc-b', 'mem-a'])
    })

    it('resolves the three-state project via projectOf, into the source AND the context label', async () => {
      const store = fakeStore([
        { id: 'k', title: 'Doc', content: 'topic', filePath: 'billing/k.md', class: 'user-doc' },
        {
          id: 'm',
          title: 'decisions',
          content: 'topic',
          filePath: 'mid42/decisions.md',
          class: 'agent-memory',
        },
      ])

      const projectOf = (fp: string, cls: NoteClass | undefined): string | undefined => {
        if (cls === 'agent-memory') {
          return fp.startsWith('mid42/') ? 'team/billing' : undefined
        }

        return fp.startsWith('billing/') ? 'team/billing' : undefined
      }
      const res = await recall([{ slug: 'team', isPersonal: false, store, projectOf }], {
        query: 'topic',
        budgetTokens: 4000,
        depth: 0,
      })
      expect(res.sources.find((s) => s.noteId === 'k')?.project).toBe('team/billing')
      expect(res.sources.find((s) => s.noteId === 'm')?.project).toBe('team/billing')
      expect(res.context).toContain('(project: team/billing)') // labelled most-specific-first
    })
  })
})
