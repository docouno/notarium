import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  ActivityEventsResponseSchema,
  ActivityProjectsResponseSchema,
  ActivityResponseSchema,
  BucketsResponseSchema,
  ConfigSchema,
  ErrorResponseSchema,
  GraphHealthResponseSchema,
  GraphResponseSchema,
  MoveResponseSchema,
  NoteDetailResponseSchema,
  NoteExistsResponseSchema,
  NotesResponseSchema,
  PreviewsResponseSchema,
  RemoveResponseSchema,
  SaveResponseSchema,
  SearchResponseSchema,
  SpacesResponseSchema,
  StatusResponseSchema,
  StoreEventSchema,
  TagsResponseSchema,
  TreeChildrenResponseSchema,
  TreeResponseSchema,
} from '@notarium/contract'
import { createApp, type Fixture } from './app.js'

// The fake backend (#45) must satisfy the /api/* contract (@notarium/contract) AND
// behave statefully (journeys mutate the store and later reads reflect it).
// Since #19 the fake IS the production Fastify app with InMemoryStore wired in,
// so this suite exercises the real transport + the reference engine end to end.

const here = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(here, '..', 'fixtures', 'base.json')
// Fresh fixture per test so mutations don't leak between cases.
const loadFixture = (): Fixture => JSON.parse(readFileSync(FIXTURE, 'utf8'))

let app: FastifyInstance
beforeEach(async () => {
  app = await createApp(loadFixture())
})

const get = async (url: string) => (await app.inject({ method: 'GET', url })).json()
const post = (url: string, payload: object): Promise<LightMyRequestResponse> =>
  app.inject({ method: 'POST', url, payload })
const del = (url: string): Promise<LightMyRequestResponse> => app.inject({ method: 'DELETE', url })

describe('contract conformance over the seed fixture', () => {
  it('GET /api/config — just the capability facts (#99 dropped the default-space pointer)', async () => {
    const cfg = await get('/api/config')
    expect(ConfigSchema.safeParse(cfg).success).toBe(true)
    expect(cfg.defaultSpace).toBeUndefined() // no host-global default anymore
    expect(cfg.capabilities.spaceCreate).toBe(false) // base fixture: static host
  })
  it('GET /api/spaces — the host lists its spaces (slug on the wire, id opaque #100 phase 4)', async () => {
    const body = await get('/api/spaces')
    expect(SpacesResponseSchema.safeParse(body).success).toBe(true)
    expect(body.spaces).toHaveLength(1)
    const [main] = body.spaces
    // Exact wire shape (the never-renamed base space omits `aliases`) — restores the
    // "no stray field" guard the old toEqual gave, now that the id can't be hardcoded.
    expect(Object.keys(main).sort()).toEqual(['displayName', 'id', 'slug'])
    expect(main.slug).toBe('main')
    expect(main.displayName).toBe('Main')
    // #127: the fake now mints an opaque space id (id ≠ slug), so the wire's id→slug
    // projection is actually exercised — a row leaking the raw id where a slug belongs
    // would no longer pass here (or anywhere the seam projects).
    expect(main.id).not.toBe('main')
    expect(typeof main.id).toBe('string')
    expect(main.id.length).toBeGreaterThan(0)
  })
  it('space-scoped surfaces have no spaceless routes — fail-closed by construction (#16)', async () => {
    for (const url of ['/api/notes', '/api/tree', '/api/graph', '/api/search?q=x', '/api/status']) {
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(404)
    }
  })
  it('an unknown space is a 404, indistinguishable from nothing (#16)', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/s/nope/notes' })).statusCode).toBe(404)
  })
  it('GET /api/notes — every note validates; createdAt may be null', async () => {
    const r = NotesResponseSchema.safeParse(await get('/api/s/main/notes'))
    expect(r.success).toBe(true)
    expect(r.success && r.data.notes).toHaveLength(5)
    // The one list carries createdAt since #60 (/api/recent is gone); null is
    // the honest "engine doesn't know" for notes outside its window.
    const myNote = r.success && r.data.notes.find((n) => n.filePath === 'demo/My Note.md')
    expect(myNote && myNote.createdAt).toBeNull()
  })
  it('GET /api/recent — removed with #60 (folded into /api/notes)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/recent' })
    expect(res.statusCode).toBe(404)
  })
  // #64: the list endpoint is windowed — filter+sort+slice happen server-side,
  // `total` is the filtered population before the slice.
  it('GET /api/notes — sort=created window: dated notes only, newest first, honest total', async () => {
    const r = await get('/api/s/main/notes?sort=created&offset=1&limit=2')
    expect(NotesResponseSchema.safeParse(r).success).toBe(true)
    expect(r.total).toBe(3) // 2 of 5 fixture notes carry no created_at
    expect(r.notes.map((n: { filePath: string }) => n.filePath)).toEqual([
      'demo/Carbon.md', // root.md (June 5) is newest and sliced off by offset=1
      'demo/Titanium.md',
    ])
  })
  it('GET /api/notes — folder scope: subtree vs direct children', async () => {
    const subtree = await get('/api/s/main/notes?folder=archive')
    expect(subtree.total).toBe(1) // archive/2020/old.md via the prefix
    const direct = await get('/api/s/main/notes?folder=archive&depth=direct')
    expect(direct.total).toBe(0) // nothing lives immediately in archive/
    expect(direct.notes).toEqual([])
  })
  it('GET /api/notes — folders keeps subtrees (#93/#109 inclusion); repeated key → array', async () => {
    // one selected subtree (prefix-cascade): only demo (3 notes)
    const one = await get('/api/s/main/notes?folders=demo')
    expect(NotesResponseSchema.safeParse(one).success).toBe(true)
    expect(one.total).toBe(3) // the demo subtree
    // a repeated query key must parse to an ARRAY (Fastify querystring) — OR/union
    const two = await get('/api/s/main/notes?folders=demo&folders=archive')
    expect(two.total).toBe(4) // demo (3) ∪ archive (1); root.md stays out
    expect(two.notes.map((n: { filePath: string }) => n.filePath)).not.toContain('root.md')
  })
  it('GET /api/notes/buckets — folders keeps the histogram total in lockstep (#93/#109)', async () => {
    const b = await get('/api/s/main/notes/buckets?sort=modified&group=month&folders=demo')
    expect(BucketsResponseSchema.safeParse(b).success).toBe(true)
    const notes = await get('/api/s/main/notes?sort=modified&folders=demo')
    expect(b.total).toBe(notes.total)
    expect(b.buckets.reduce((acc: number, x: { count: number }) => acc + x.count, 0)).toBe(b.total)
  })
  it('GET /api/notes — a malformed window param is the caller’s fault (400)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/s/main/notes?limit=0' })
    expect(res.statusCode).toBe(400)
    expect(ErrorResponseSchema.safeParse(res.json()).success).toBe(true)
  })
  // #109: the tag axis on the read-model snapshot — filter, facet, histogram.
  it('GET /api/s/:space/tags — the tag facet with counts (#109)', async () => {
    const t = await get('/api/s/main/tags')
    expect(TagsResponseSchema.safeParse(t).success).toBe(true)
    const by = Object.fromEntries(t.tags.map((x: { tag: string }) => [x.tag, x]))
    // fixture: Titanium[metal,element] Carbon[element] root[intro]
    expect(by.element).toMatchObject({ count: 2, direct: 2 })
    expect(by.metal).toMatchObject({ count: 1 })
    expect(by.intro).toMatchObject({ count: 1 })
    expect(t.total).toBe(3) // element, metal, intro
  })
  it('GET /api/notes?tags= — keeps only notes carrying the tag, case-insensitive (#109)', async () => {
    const one = await get('/api/s/main/notes?tags=element')
    expect(NotesResponseSchema.safeParse(one).success).toBe(true)
    expect(one.total).toBe(2)
    expect(one.notes.map((n: { filePath: string }) => n.filePath).sort()).toEqual([
      'demo/Carbon.md',
      'demo/Titanium.md',
    ])
    // folding: an upper-case query lands on the same population
    expect((await get('/api/s/main/notes?tags=ELEMENT')).total).toBe(2)
    // OR/union across a repeated key (#109 unified "add widens"): element ∪ metal →
    // Carbon (element) + Titanium (element+metal).
    const both = await get('/api/s/main/notes?tags=element&tags=metal')
    expect(both.notes.map((n: { filePath: string }) => n.filePath).sort()).toEqual([
      'demo/Carbon.md',
      'demo/Titanium.md',
    ])
  })
  it('GET /api/notes/buckets?tags= — histogram total tracks the tag-filtered window (#109)', async () => {
    const b = await get('/api/s/main/notes/buckets?sort=modified&group=month&tags=element')
    expect(BucketsResponseSchema.safeParse(b).success).toBe(true)
    const notes = await get('/api/s/main/notes?sort=modified&tags=element')
    expect(b.total).toBe(notes.total) // == 2, the lockstep invariant
    expect(b.buckets.reduce((acc: number, x: { count: number }) => acc + x.count, 0)).toBe(b.total)
  })
  // #190: the full-text membership filter `q` — one more axis (folder ∧ tag ∧ q).
  it('GET /api/notes?q= — narrows to notes the engine matches (#190)', async () => {
    // 'metal' lives only in Titanium's body — q narrows the window to it.
    const hit = await get('/api/s/main/notes?q=metal')
    expect(NotesResponseSchema.safeParse(hit).success).toBe(true)
    expect(hit.total).toBe(1)
    expect(hit.notes.map((n: { filePath: string }) => n.filePath)).toEqual(['demo/Titanium.md'])
    // A query nothing matches is an empty population, not an error.
    expect((await get('/api/s/main/notes?q=zzznomatch')).total).toBe(0)
    // Empty q is no filter at all — the whole base.
    expect((await get('/api/s/main/notes?q=')).total).toBe(5)
  })
  it('GET /api/notes/buckets?q= — histogram total tracks the q-filtered window (#190)', async () => {
    const b = await get('/api/s/main/notes/buckets?sort=modified&group=month&q=metal')
    expect(BucketsResponseSchema.safeParse(b).success).toBe(true)
    const notes = await get('/api/s/main/notes?sort=modified&q=metal')
    expect(b.total).toBe(notes.total) // == 1, the lockstep invariant
    expect(b.buckets.reduce((acc: number, x: { count: number }) => acc + x.count, 0)).toBe(b.total)
  })
  // #201: date range is one more server-side filter axis (folder ∧ tag ∧ q ∧ date).
  it('GET /api/notes?from=&to= — narrows by inclusive local date range (#201)', async () => {
    const r = await get('/api/s/main/notes?sort=created&from=2026-06-02&to=2026-06-02&tz=0')
    expect(NotesResponseSchema.safeParse(r).success).toBe(true)
    expect(r.total).toBe(1)
    expect(r.notes.map((n: { filePath: string }) => n.filePath)).toEqual(['demo/Carbon.md'])
  })
  it('GET /api/notes dateField=created filters created dates while preserving modified sort (#201)', async () => {
    const r = await get(
      '/api/s/main/notes?sort=modified&dateField=created&from=2026-06-01&to=2026-06-02&tz=0',
    )
    expect(NotesResponseSchema.safeParse(r).success).toBe(true)
    expect(r.total).toBe(2)
    expect(r.notes.map((n: { filePath: string }) => n.filePath)).toEqual([
      'demo/Titanium.md',
      'demo/Carbon.md',
    ])
  })
  it('GET /api/notes/buckets?from=&to= — histogram total tracks the date-filtered window (#201)', async () => {
    const b = await get(
      '/api/s/main/notes/buckets?sort=created&group=month&from=2026-06-01&to=2026-06-02&tz=0',
    )
    expect(BucketsResponseSchema.safeParse(b).success).toBe(true)
    const notes = await get('/api/s/main/notes?sort=created&from=2026-06-01&to=2026-06-02&tz=0')
    expect(b.total).toBe(notes.total) // == 2, the lockstep invariant
    expect(b.buckets.reduce((acc: number, x: { count: number }) => acc + x.count, 0)).toBe(b.total)
  })
  it('GET /api/notes/buckets dateField=created filters created dates but groups modified dates (#201)', async () => {
    const b = await get(
      '/api/s/main/notes/buckets?sort=modified&group=day&dateField=created&from=2026-06-01&to=2026-06-02&tz=0',
    )
    expect(BucketsResponseSchema.safeParse(b).success).toBe(true)
    const notes = await get(
      '/api/s/main/notes?sort=modified&dateField=created&from=2026-06-01&to=2026-06-02&tz=0',
    )
    expect(b.total).toBe(notes.total) // == 2, Titanium + Carbon by createdAt.
    expect(b.buckets).toEqual([
      { key: '2026-06-08', count: 1 },
      { key: '2026-06-07', count: 1 },
    ])
  })
  it('GET /api/tree — folder skeleton with subtree/direct counts + stats', async () => {
    const t = await get('/api/s/main/tree')
    expect(TreeResponseSchema.safeParse(t).success).toBe(true)
    const byPath = Object.fromEntries(t.folders.map((f: { path: string }) => [f.path, f]))
    expect(byPath['demo']).toMatchObject({ name: 'demo', count: 3, direct: 3 })
    expect(byPath['archive']).toMatchObject({ count: 1, direct: 0 }) // only the nested note
    expect(byPath['archive/2020']).toMatchObject({ name: '2020', count: 1, direct: 1 })
    expect(t.stats.total).toBe(5)
    expect(t.stats.root).toBe(1) // root.md
  })
  it('GET /api/tree/children — one expand step: subfolders with counts + direct notes, title-ordered', async () => {
    const root = await get('/api/s/main/tree/children?path=')
    expect(TreeChildrenResponseSchema.safeParse(root).success).toBe(true)
    expect(root.folders.map((f: { path: string }) => f.path)).toEqual(['archive', 'demo'])
    expect(root.notes.map((n: { filePath: string }) => n.filePath)).toEqual(['root.md'])
    expect(root.total).toBe(1)
    const archive = await get('/api/s/main/tree/children?path=archive')
    expect(archive.folders).toEqual([{ path: 'archive/2020', name: '2020', count: 1, direct: 1 }])
    expect(archive.notes).toEqual([])
    expect(archive.total).toBe(0)
  })
  it('GET /api/tree/children — offset/limit window the notes, total stays honest', async () => {
    const demo = await get('/api/s/main/tree/children?path=demo&offset=1&limit=1')
    expect(demo.total).toBe(3)
    expect(demo.notes).toHaveLength(1)
  })
  it('GET /api/notes/buckets — counts sum to the matching window total', async () => {
    const b = await get('/api/s/main/notes/buckets?sort=created&group=day')
    expect(BucketsResponseSchema.safeParse(b).success).toBe(true)
    const notes = await get('/api/s/main/notes?sort=created')
    expect(b.total).toBe(notes.total)
    expect(b.buckets.reduce((acc: number, x: { count: number }) => acc + x.count, 0)).toBe(b.total)
    // created sort excludes undated notes — no '' bucket.
    expect(b.buckets.every((x: { key: string }) => x.key !== '')).toBe(true)
  })
  it('GET /api/notes/buckets — modified sort ends with the undated tail when notes lack dates', async () => {
    const b = await get('/api/s/main/notes/buckets?sort=modified&group=month')
    const keys = b.buckets.map((x: { key: string }) => x.key)
    // undated (if any) is one trailing run, never interleaved
    expect(keys.filter((k: string) => k === '').length).toBeLessThanOrEqual(1)
    if (keys.includes('')) {
      expect(keys[keys.length - 1]).toBe('')
    }
  })
  it('GET /api/graph — real + ghost nodes validate; real nodes carry tags (#109)', async () => {
    const g = await get('/api/s/main/graph')
    expect(GraphResponseSchema.safeParse(g).success).toBe(true)
    // The tag axis rides the node now (#109) — the graph facet reads it, no preview
    // sweep. Titanium carries [metal, element] in the fixture.
    const titanium = g.nodes.find((n: { title?: string }) => n.title === 'Titanium')
    expect(titanium?.tags).toEqual(['metal', 'element'])
  })
  it('GET /api/notes?preview=1 — warm previews ride the window inline', async () => {
    const r = await get('/api/s/main/notes?preview=1&sort=modified&limit=2')
    expect(NotesResponseSchema.safeParse(r).success).toBe(true)
    // The in-memory engine peeks straight off its bodies — always warm.
    for (const n of r.notes) {
      expect(n.preview).toBeTruthy()
    }
    // Without the flag the field stays off the wire.
    const bare = await get('/api/s/main/notes?limit=1')
    expect(bare.notes[0].preview).toBeUndefined()
  })
  it('POST /api/previews — batch resolution by note-id validates and surfaces the image', async () => {
    const res = await post('/api/previews', { ids: ['fake-root', 'fake-demo-carbon'] })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(PreviewsResponseSchema.safeParse(body).success).toBe(true)
    expect(body.previews['fake-root'].image).toBe('https://example.test/cover.png')
  })
  it('POST /api/previews — an empty/oversized batch is the caller’s fault (400)', async () => {
    expect((await post('/api/previews', { ids: [] })).statusCode).toBe(400)
    expect(
      (await post('/api/previews', { ids: Array.from({ length: 101 }, (_, i) => `x${i}`) }))
        .statusCode,
    ).toBe(400)
  })
  it('GET /api/snippet — removed with #64 (folded into /api/previews + inline previews)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/snippet?id=main%2Froot' })
    expect(res.statusCode).toBe(404)
  })
  it('GET /api/note — content + frontmatter + note-id + space; ids only', async () => {
    const byId = await get('/api/note?id=fake-demo-carbon')
    expect(NoteDetailResponseSchema.safeParse(byId).success).toBe(true)
    expect(byId.id).toBe('fake-demo-carbon')
    expect(byId.space).toBe('main') // #16: the chrome scopes to the note's space
    // A storage key is NOT a note URL — the global channel serves ids only.
    const byPath = await app.inject({
      method: 'GET',
      url: '/api/note?id=' + encodeURIComponent('demo/Carbon'),
    })
    expect(byPath.statusCode).toBe(404)
  })
  it('GET /api/s/:space/note?ref — the wiki-resolver channel answers within the space (#16)', async () => {
    const byPath = await get('/api/s/main/note?ref=' + encodeURIComponent('demo/Carbon'))
    expect(NoteDetailResponseSchema.safeParse(byPath).success).toBe(true)
    expect(byPath.id).toBe('fake-demo-carbon')
    expect(byPath.space).toBe('main')
  })
  it('GET /api/s/:space/note?ref normalizes wikilink syntax before exact storage paths', async () => {
    const fixture = loadFixture()
    fixture.spaces[0].notes.push(
      { id: 'plain', title: 'Plain', filePath: 'Foo.md', content: 'plain' },
      { id: 'literal', title: 'Literal Hash', filePath: 'Foo#section.md', content: 'literal' },
    )
    const isolated = await createApp(fixture)

    try {
      const response = await isolated.inject({
        method: 'GET',
        url: '/api/s/main/note?ref=' + encodeURIComponent('Foo#section.md'),
      })

      expect(response.statusCode).toBe(200)
      expect(response.json().id).toBe('plain')
    } finally {
      await isolated.close()
    }
  })
  it('GET /api/search', async () => {
    expect(SearchResponseSchema.safeParse(await get('/api/s/main/search?q=titanium')).success).toBe(
      true,
    )
  })
  it('GET /api/status — a live-serving store reports a permanently-ready scan', async () => {
    const body = await get('/api/s/main/status')
    expect(StatusResponseSchema.safeParse(body).success).toBe(true)
    expect(body.scan.phase).toBe('ready')
  })
  it('GET /api/events — SSE stream opens with a contract-valid status event', async () => {
    await app.listen({ port: 0, host: '127.0.0.1' })
    const { port } = app.server.address() as { port: number }
    const ctrl = new AbortController()
    const res = await fetch(`http://127.0.0.1:${port}/api/s/main/events`, { signal: ctrl.signal })
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const reader = res.body!.getReader()
    const { value } = await reader.read()
    ctrl.abort()
    const line = new TextDecoder()
      .decode(value)
      .split('\n')
      .find((l) => l.startsWith('data:'))!
    const event = JSON.parse(line.slice(5))
    expect(StoreEventSchema.safeParse(event).success).toBe(true)
    expect(event.type).toBe('status')
  })
})

describe('graph derivation', () => {
  // Graph node ids (and link endpoints) are note-ids since #51. InMemoryStore
  // derives deterministic `fake-<slugged-path>` ids for seeded notes, so the
  // fixture's ids are hardcodable.
  it('resolves a two-way link Titanium ↔ Carbon', async () => {
    const g = await get('/api/s/main/graph')
    const ids = g.links.map((l: { source: string; target: string }) => `${l.source}->${l.target}`)
    expect(ids).toContain('fake-demo-titanium->fake-demo-carbon')
    expect(ids).toContain('fake-demo-carbon->fake-demo-titanium')
  })
  it('real nodes carry the deterministic fake-* note-ids', async () => {
    const g = await get('/api/s/main/graph')
    const real = g.nodes
      .filter((n: { ghost: boolean }) => !n.ghost)
      .map((n: { id: string }) => n.id)
      .sort()
    expect(real).toEqual([
      'fake-archive-2020-old',
      'fake-demo-carbon',
      'fake-demo-my-note',
      'fake-demo-titanium',
      'fake-root',
    ])
  })
  it('emits a ghost node with prefill + sources for an unwritten target', async () => {
    const g = await get('/api/s/main/graph')
    const ghost = g.nodes.find((n: { id: string }) => n.id === 'ghost:missing-element')
    expect(ghost).toBeTruthy()
    expect(ghost.ghost).toBe(true)
    expect(ghost.prefillTitle).toBe('Missing Element')
    expect(ghost.sources).toEqual([{ id: 'fake-demo-titanium', title: 'Titanium', folder: 'demo' }])
  })
})

describe('graph health — grooming surface (#100 phase 5)', () => {
  it('GET /graph/health validates; a pristine fixture surfaces the ghost, nothing stale', async () => {
    const h = await get('/api/s/main/graph/health')
    expect(GraphHealthResponseSchema.safeParse(h).success).toBe(true)
    // Titanium links [[Missing Element]] in the fixture → a broken link with its source.
    const ghost = h.ghosts.find((g: { target: string }) => g.target === 'missing-element')
    expect(ghost).toBeTruthy()
    expect(ghost.refCount).toBeGreaterThanOrEqual(1)
    expect(ghost.sources.some((s: { id: string }) => s.id === 'fake-demo-titanium')).toBe(true)
    // No rename has happened yet → no link resolves through a former name.
    expect(h.staleNamed).toBe(0)
    expect(h.via).toEqual({ slug: 0, noteAlias: 0, folderAlias: 0 })
  })

  it('GET /graph/health orders broken targets by visible source count', async () => {
    for (const content of [
      '# Source Alpha\n\nSee [[Roadmap]] and [[Todo]].',
      '# Source Beta\n\nSee [[Roadmap]] and [[Todo]].',
      '# Source Gamma\n\nSee [[Roadmap]].',
      '# Source Delta\n\nSee [[Random typo]].',
    ]) {
      const res = await post('/api/s/main/notes', { directory: 'graph-health-order', content })
      expect(res.statusCode).toBe(200)
    }

    const h = await get('/api/s/main/graph/health')
    expect(GraphHealthResponseSchema.safeParse(h).success).toBe(true)
    expect(
      h.ghosts.map((g: { target: string; refCount: number }) => [g.target, g.refCount]).slice(0, 2),
    ).toEqual([
      ['roadmap', 3],
      ['todo', 2],
    ])
    expect(h.ghosts.find((g: { target: string }) => g.target === 'random-typo')).toMatchObject({
      refCount: 1,
      sources: [{ title: 'Source Delta' }],
    })
    for (let i = 1; i < h.ghosts.length; i++) {
      expect(h.ghosts[i - 1].refCount).toBeGreaterThanOrEqual(h.ghosts[i].refCount)
    }
  })

  it('after a note is renamed, its inbound link is counted as resolved via a former name', async () => {
    // Carbon links [[Titanium]]. Rename Titanium → "Titanium Alloy": the old title
    // joins the note's alias history (#100 phase 0), so Carbon's [[Titanium]] now resolves
    // through that former name — exactly what the metric must catch on a FRESH derive.
    const t = await get('/api/note?id=fake-demo-titanium')
    const res = await post('/api/note', {
      title: 'Titanium Alloy',
      content: t.content,
      originalId: 'fake-demo-titanium',
      versionToken: t.versionToken,
    })
    expect(res.statusCode).toBe(200)

    const h = await get('/api/s/main/graph/health')
    expect(GraphHealthResponseSchema.safeParse(h).success).toBe(true)
    expect(h.via.noteAlias).toBeGreaterThanOrEqual(1)
    expect(h.staleNamed).toBeGreaterThanOrEqual(1)
    const edge = h.edges.find(
      (e: { source: { id: string }; via: string }) =>
        e.source.id === 'fake-demo-carbon' && e.via === 'note-alias',
    )
    expect(edge).toBeTruthy()
    expect(edge.target.title).toBe('Titanium Alloy')
  })
})

describe('journey — create a note', () => {
  it('appears in /notes and the graph edge resolves', async () => {
    const res = await post('/api/s/main/notes', {
      title: 'New Idea',
      directory: 'demo',
      content: 'builds on [[Titanium]]',
    })
    expect(res.statusCode).toBe(200)
    expect(SaveResponseSchema.safeParse(res.json()).success).toBe(true)
    expect(res.json().filePath).toBe('demo/new-idea.md')
    // #51: the save response reports the minted note-id — what the client navigates to.
    expect(res.json().id).toBe('fake-demo-new-idea')

    const notes = await get('/api/s/main/notes')
    expect(notes.notes.some((n: { filePath: string }) => n.filePath === 'demo/new-idea.md')).toBe(
      true,
    )

    const g = await get('/api/s/main/graph')
    expect(
      g.links.some(
        (l: { source: string; target: string }) =>
          l.source === 'fake-demo-new-idea' && l.target === 'fake-demo-titanium',
      ),
    ).toBe(true)
  })

  it('body-first: a create with NO title field derives it from the leading # H1, body stays single-titled (#156)', async () => {
    // The web editor path: the document (with its `# H1`) is posted as `content`, no
    // `title` field. The server derives the title at the write chokepoint and stores
    // the body without the duplicate heading.
    const res = await post('/api/s/main/notes', {
      directory: 'demo',
      content: '# Body First\n\nthe real body',
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().filePath).toBe('demo/body-first.md') // slug derived from the H1 title

    const note = await get('/api/note?id=' + res.json().id)
    expect(note.title).toBe('Body First')
    expect(note.content).toContain('the real body')
    expect(note.content).not.toMatch(/#\s+Body First/) // no duplicate heading on read
  })

  it('body-first: a create with neither title nor derivable first line is rejected (#156)', async () => {
    const res = await post('/api/s/main/notes', { directory: 'demo', content: '   ' })
    expect(res.statusCode).toBe(400)
  })

  // canon: docs/note-model.md#create-collisions
  it('a taken title is a 409 naming the occupant, and the occupant keeps its bytes', async () => {
    const first = await post('/api/s/main/notes', {
      directory: 'demo',
      content: '# Plans\n\nthe body that must survive',
    })
    expect(first.statusCode).toBe(200)

    const clash = await post('/api/s/main/notes', {
      directory: 'demo',
      content: '# Plans\n\nsomething else entirely',
    })
    expect(clash.statusCode).toBe(409)
    expect(NoteExistsResponseSchema.safeParse(clash.json()).success).toBe(true)
    // The occupant is named, so the client can offer to open it rather than making
    // the user hunt for the note they were told about.
    expect(clash.json().existing).toMatchObject({
      id: first.json().id,
      title: 'Plans',
      filePath: 'demo/plans.md',
    })
    expect((await get('/api/note?id=' + first.json().id)).content).toContain(
      'the body that must survive',
    )
    // The refusal also previews the name a uniquify retry would take, so the client can
    // offer it by name instead of "some free name".
    expect(clash.json().suggestedTitle).toBe('Plans 2')
  })

  it('ifExists:uniquify lands beside the occupant and reports the name it got', async () => {
    const first = await post('/api/s/main/notes', { directory: 'demo', content: '# Plans\n\na' })
    const second = await post('/api/s/main/notes', {
      directory: 'demo',
      content: '# Plans\n\nb',
      ifExists: 'uniquify',
    })
    const third = await post('/api/s/main/notes', {
      directory: 'demo',
      content: '# Plans\n\nc',
      ifExists: 'uniquify',
    })

    expect([second.statusCode, third.statusCode]).toEqual([200, 200])
    expect(second.json().title).toBe('Plans 2')
    expect(third.json().title).toBe('Plans 3')
    expect([second.json().filePath, third.json().filePath]).toEqual([
      'demo/plans-2.md',
      'demo/plans-3.md',
    ])
    // Three distinct notes: nobody inherited anybody's identity.
    expect(new Set([first.json().id, second.json().id, third.json().id]).size).toBe(3)
    expect((await get('/api/note?id=' + first.json().id)).content).toContain('a')
  })

  it('`overwrite` is unreachable from a client — the wire enum admits fail/uniquify only', async () => {
    await post('/api/s/main/notes', { directory: 'demo', content: '# Plans\n\noriginal' })
    const res = await post('/api/s/main/notes', {
      directory: 'demo',
      content: '# Plans\n\nclobber attempt',
      ifExists: 'overwrite',
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().reason).toBe('validation')
  })
})

describe('journey — edit a note’s created date (#186)', () => {
  it('an authored createdAt edit lands in the read view, the list and the Created buckets; a plain edit preserves it', async () => {
    // Create dated "now", then correct the historicity through the metadata-aside
    // channel: POST /api/note with an authored createdAt. The date is served back on
    // read (editor prefill), drives the Created sort and the Feed histogram.
    const created = await post('/api/s/main/notes', {
      directory: 'demo',
      content: '# Backdated Note\n\nbody',
    })
    const id = created.json().id
    const v1 = (await get('/api/note?id=' + id)).versionToken

    const BACKDATE = '2021-09-15T00:00:00.000Z'
    const edit = await post('/api/note', {
      content: '# Backdated Note\n\nbody',
      originalId: id,
      versionToken: v1,
      createdAt: BACKDATE,
    })
    expect(edit.statusCode).toBe(200)

    // Read view carries it (the editor prefills its date field from this).
    const note = await get('/api/note?id=' + id)
    expect(note.createdAt).toBe(BACKDATE)
    // The index/list reflects it — the Feed (Created) re-files the note.
    const row = (await get('/api/s/main/notes?sort=created&limit=200')).notes.find(
      (n: { id: string }) => n.id === id,
    )
    expect(row.createdAt).toBe(BACKDATE)
    // And the Created histogram buckets it under the backdated month (tz=0).
    const buckets = await get('/api/s/main/notes/buckets?sort=created&group=month&tz=0')
    expect(buckets.buckets.some((b: { key: string }) => b.key === '2021-09-01')).toBe(true)

    // A plain body edit (no createdAt) leaves the authored date intact.
    const plain = await post('/api/note', {
      content: '# Backdated Note\n\nbody v2',
      originalId: id,
      versionToken: note.versionToken,
    })
    expect(plain.statusCode).toBe(200)
    expect((await get('/api/note?id=' + id)).createdAt).toBe(BACKDATE)
  })

  it("rejects createdAt that is not a full ISO datetime (REST requires minute precision; date-only is the client's to expand)", async () => {
    const created = await post('/api/s/main/notes', {
      directory: 'demo',
      content: '# Bad Date Note\n\nx',
    })
    const id = created.json().id
    const body = (extra: Record<string, unknown>) => ({
      content: '# Bad Date Note\n\nx',
      originalId: id,
      ...extra,
    })
    // Garbage is rejected.
    const v1 = (await get('/api/note?id=' + id)).versionToken
    expect(
      (await post('/api/note', body({ versionToken: v1, createdAt: 'not-a-date' }))).statusCode,
    ).toBe(400)
    // A bare calendar date is rejected too — the wire carries a full instant (the UI
    // builds local-midnight); accepting date-only here would silently lose the tz axis.
    const v2 = (await get('/api/note?id=' + id)).versionToken
    expect(
      (await post('/api/note', body({ versionToken: v2, createdAt: '2020-02-20' }))).statusCode,
    ).toBe(400)
    // A full ISO instant (incl. an offset form) is accepted and normalised to UTC.
    const v3 = (await get('/api/note?id=' + id)).versionToken
    const ok = await post(
      '/api/note',
      body({ versionToken: v3, createdAt: '2020-02-20T00:00:00+05:00' }),
    )
    expect(ok.statusCode).toBe(200)
    expect((await get('/api/note?id=' + id)).createdAt).toBe('2020-02-19T19:00:00.000Z')
  })
})

describe('journey — ghost → create resolves the link from both sides (#25)', () => {
  it('the ghost becomes a real node and the edge points at it', async () => {
    // create the previously-missing note with the ghost's prefill title
    const res = await post('/api/s/main/notes', {
      title: 'Missing Element',
      directory: 'demo',
      content: 'now exists',
    })
    expect(res.statusCode).toBe(200)

    const g = await get('/api/s/main/graph')
    expect(g.nodes.some((n: { id: string }) => n.id === 'ghost:missing-element')).toBe(false)
    const real = g.nodes.find(
      (n: { filePath?: string }) => n.filePath === 'demo/missing-element.md',
    )
    // slug('Missing Element') === 'missing-element' so Titanium's [[Missing Element]] now resolves to it
    expect(real).toBeTruthy()
    expect(
      g.links.some(
        (l: { source: string; target: string }) =>
          l.source === 'fake-demo-titanium' && l.target === real.id,
      ),
    ).toBe(true)
  })
})

describe('journey — move a note (#6/#8)', () => {
  // MoveRequest.id is the note-id for notes since #51 (folders keep paths).
  it('relocates the note everywhere', async () => {
    const res = await post('/api/move', {
      id: 'fake-demo-titanium',
      destinationPath: 'demo/sub/Titanium.md',
    })
    expect(res.statusCode).toBe(200)
    expect(MoveResponseSchema.safeParse(res.json()).success).toBe(true)

    const notes = await get('/api/s/main/notes')
    expect(
      notes.notes.some((n: { filePath: string }) => n.filePath === 'demo/sub/Titanium.md'),
    ).toBe(true)
    expect(notes.notes.some((n: { filePath: string }) => n.filePath === 'demo/Titanium.md')).toBe(
      false,
    )
  })

  it('a move onto an occupied path fails as a 400 error envelope (Move Failed)', async () => {
    const res = await post('/api/move', {
      id: 'fake-demo-titanium',
      destinationPath: 'demo/Carbon.md',
    })
    expect(res.statusCode).toBe(400)
    const body = res.json()
    expect(ErrorResponseSchema.safeParse(body).success).toBe(true)
    expect(body.error).toMatch(/Move Failed/i)
  })
})

describe('journey — remove a note', () => {
  it('drops it from /notes', async () => {
    const res = await del('/api/note?id=fake-demo-carbon')
    expect(res.statusCode).toBe(200)
    expect(RemoveResponseSchema.safeParse(res.json()).success).toBe(true)

    const notes = await get('/api/s/main/notes')
    expect(notes.notes.some((n: { filePath: string }) => n.filePath === 'demo/Carbon.md')).toBe(
      false,
    )
  })
})

// Activity dashboard (#33): the heatmap aggregate + the "what changed" feed over
// seeded journal history. A custom fixture pins exact dates/kinds so the
// classification (created/edited/deleted), the tz-bucketing, and the two
// exclusions (synthetic baseline, hidden agent-memory class) are all asserted.
describe('activity (#33)', () => {
  const fixture: Fixture = {
    now: '2026-06-25T12:00:00.000Z',
    spaces: [
      {
        slug: 'main',
        displayName: 'Main',
        notes: [],
        activity: [
          { date: '2026-06-10', kind: 'created', title: 'Alpha', principal: 'ui' },
          { date: '2026-06-10', kind: 'edited', title: 'Alpha', principal: 'ui' },
          { date: '2026-06-12', kind: 'edited', title: 'Beta', charsAdded: 12, charsRemoved: 3 },
          { date: '2026-06-12', kind: 'deleted', title: 'Gamma' },
          // Synthetic pre-edit baseline — must NOT count or surface.
          { date: '2026-06-12', kind: 'baseline', title: 'Alpha' },
          // Hidden class — must NOT count or surface (visibility #78).
          { date: '2026-06-12', kind: 'edited', title: 'Secret', class: 'agent-memory' },
        ],
      },
    ],
  }
  let actApp: FastifyInstance
  beforeEach(async () => {
    actApp = await createApp(fixture)
  })
  const aget = async (url: string) => (await actApp.inject({ method: 'GET', url })).json()

  it('GET /activity — day buckets, baseline + hidden class excluded', async () => {
    const r = await aget(
      '/api/s/main/activity?from=2026-06-01T00:00:00.000Z&to=2026-06-20T00:00:00.000Z&tz=0',
    )
    expect(ActivityResponseSchema.safeParse(r).success).toBe(true)
    const byDate = Object.fromEntries(r.days.map((d: { date: string }) => [d.date, d]))
    // Jun 10: created + edited = 2 (no baseline yet).
    expect(byDate['2026-06-10']).toMatchObject({ created: 1, edited: 1, deleted: 0, total: 2 })
    // Jun 12: one edited + one deleted = 2. The baseline (external/no-parent) and the
    // agent-memory edit are both excluded — NOT 4.
    expect(byDate['2026-06-12']).toMatchObject({ created: 0, edited: 1, deleted: 1, total: 2 })
  })

  it('GET /activity — total = created+edited+deleted; restore folds into edited + maps to `restored`', async () => {
    const fx: Fixture = {
      now: '2026-06-25T12:00:00.000Z',
      spaces: [
        {
          slug: 'main',
          displayName: 'Main',
          notes: [],
          activity: [
            { date: '2026-06-10', kind: 'created', title: 'A' },
            { date: '2026-06-10', kind: 'edited', title: 'A' },
            { date: '2026-06-10', kind: 'deleted', title: 'B' },
            { date: '2026-06-10', kind: 'restored', title: 'A' },
          ],
        },
      ],
    }
    const a = await createApp(fx)
    const day = (
      await a.inject({
        method: 'GET',
        url: '/api/s/main/activity?from=2026-06-01T00:00:00.000Z&to=2026-06-20T00:00:00.000Z&tz=0',
      })
    ).json().days[0]
    // restore has a chain parent → counts as `edited` (so edited = 2: the edit + the restore).
    expect(day).toMatchObject({ created: 1, edited: 2, deleted: 1, total: 4 })
    expect(day.total).toBe(day.created + day.edited + day.deleted)
    // The events feed exposes the distinct `restored` display kind.
    const ev = (await a.inject({ method: 'GET', url: '/api/s/main/activity/events' })).json()
    expect(ev.events.some((e: { kind: string }) => e.kind === 'restored')).toBe(true)
  })

  it('GET /activity — tz shifts a late-UTC instant into the next local day', async () => {
    const tzFixture: Fixture = {
      now: '2026-06-25T12:00:00.000Z',
      spaces: [
        {
          slug: 'main',
          displayName: 'Main',
          notes: [],
          activity: [{ date: '2026-06-10T23:30:00.000Z', kind: 'edited', title: 'Late' }],
        },
      ],
    }
    const tzApp = await createApp(tzFixture)
    const r = (
      await tzApp.inject({
        method: 'GET',
        url: '/api/s/main/activity?from=2026-06-01T00:00:00.000Z&to=2026-06-20T00:00:00.000Z&tz=60',
      })
    ).json()
    expect(r.days).toHaveLength(1)
    expect(r.days[0].date).toBe('2026-06-11') // +60min pushes 23:30 → next day
  })

  it('GET /activity/events — newest first, kinds mapped, exclusions hold', async () => {
    const r = await aget('/api/s/main/activity/events')
    expect(ActivityEventsResponseSchema.safeParse(r).success).toBe(true)
    // 6 seeded rows minus the baseline minus the hidden-class edit = 4 events.
    expect(r.total).toBe(4)
    expect(r.events).toHaveLength(4)
    // No baseline / no agent-memory leaked.
    expect(r.events.some((e: { title: string }) => e.title === 'Secret')).toBe(false)
    // Newest first: Jun 12 deleted is the last seeded → first out.
    expect(r.events[0]).toMatchObject({ kind: 'deleted', title: 'Gamma' })
    const beta = r.events.find((e: { title: string }) => e.title === 'Beta')
    expect(beta).toMatchObject({ kind: 'edited', charsAdded: 12, charsRemoved: 3 })
  })

  it('GET /activity/events?from&to — day drill windows to one local day', async () => {
    const r = await aget(
      '/api/s/main/activity/events?from=2026-06-10T00:00:00.000Z&to=2026-06-11T00:00:00.000Z',
    )
    expect(r.total).toBe(2) // Alpha created + Alpha edited
    expect(r.events.every((e: { title: string }) => e.title === 'Alpha')).toBe(true)
  })

  it('GET /activity + /events?author=mine — server scopes to the viewer (#218)', async () => {
    // mode-none: the lone viewer is the `ui` principal, so "mine" keeps only ui rows
    // and drops another user's — proving the route builds + applies the filter through
    // the real in-memory driver (the SQL drivers pin the same predicate in metaDb.test).
    const fx: Fixture = {
      now: '2026-06-25T12:00:00.000Z',
      spaces: [
        {
          slug: 'main',
          displayName: 'Main',
          notes: [],
          activity: [
            { date: '2026-06-10', kind: 'created', title: 'Mine', principal: 'ui' },
            { date: '2026-06-10', kind: 'edited', title: 'Mine', principal: 'ui' },
            { date: '2026-06-11', kind: 'edited', title: 'Theirs', principal: 'user:alice' },
          ],
        },
      ],
    }
    const a = await createApp(fx)
    const win = 'from=2026-06-01T00:00:00.000Z&to=2026-06-20T00:00:00.000Z&tz=0'
    // Everyone: both days present.
    const all = (await a.inject({ method: 'GET', url: `/api/s/main/activity?${win}` })).json()
    expect(all.days.map((d: { date: string }) => d.date)).toEqual(['2026-06-10', '2026-06-11'])
    // Mine: only the ui day, alice's Jun 11 gone.
    const mine = (
      await a.inject({ method: 'GET', url: `/api/s/main/activity?${win}&author=mine` })
    ).json()
    expect(ActivityResponseSchema.safeParse(mine).success).toBe(true)
    expect(mine.days).toEqual([{ date: '2026-06-10', created: 1, edited: 1, deleted: 0, total: 2 }])
    // The feed follows the same lens (total is post-filter).
    const ev = (
      await a.inject({ method: 'GET', url: '/api/s/main/activity/events?author=mine' })
    ).json()
    expect(ev.total).toBe(2)
    expect(ev.events.some((e: { title: string }) => e.title === 'Theirs')).toBe(false)
    // A bad author value is rejected, not silently ignored.
    const bad = await a.inject({
      method: 'GET',
      url: `/api/s/main/activity?${win}&author=everyone`,
    })
    expect(bad.statusCode).toBe(400)
    // hasOtherAuthors (#218): in mode-none `req.principal.username` is null, so the
    // others-signal branch is skipped entirely (`wantsOthersSignal = !author && !!viewer`)
    // and the flag is always false here — NOT because the space has one author (it seeds a
    // distinct `user:alice` row above), but because there is no viewer to be relative to.
    // The true path (a named viewer + another author) is exercised by the authenticated
    // test below.
    expect(all.hasOtherAuthors).toBe(false)
    expect(mine.hasOtherAuthors).toBe(false)
  })

  it('GET /activity hasOtherAuthors — true iff the window holds a NON-viewer author (#218)', async () => {
    // The gate that shows the mine/all toggle. Needs a real (named) viewer, so this boots
    // the fake in password mode and logs in as alice. `main` has alice's own edits AND
    // bob's; `solo` has only alice's. hasOtherAuthors must be relative to the VIEWER.
    const fx: Fixture = {
      now: '2026-06-25T12:00:00.000Z',
      auth: {
        users: [
          { username: 'alice', password: 'alice-password-1', displayName: 'Alice' },
          { username: 'bob', password: 'bob-password-1', displayName: 'Bob' },
        ],
        members: [
          { space: 'main', username: 'alice', role: 'owner' },
          { space: 'main', username: 'bob', role: 'writer' },
          { space: 'solo', username: 'alice', role: 'owner' },
        ],
      },
      spaces: [
        {
          slug: 'main',
          displayName: 'Main',
          notes: [],
          activity: [
            { date: '2026-06-10', kind: 'edited', title: 'A1', principal: 'user:alice' },
            { date: '2026-06-11', kind: 'edited', title: 'A2', principal: 'pat:alice:key-9' }, // her agent — still "mine"
            { date: '2026-06-12', kind: 'edited', title: 'B1', principal: 'user:bob' }, // someone ELSE
          ],
        },
        {
          slug: 'solo',
          displayName: 'Solo',
          notes: [],
          activity: [{ date: '2026-06-10', kind: 'edited', title: 'A3', principal: 'user:alice' }],
        },
      ],
    }
    const a = await createApp(fx)
    const login = await a.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'alice', password: 'alice-password-1' },
    })
    expect(login.statusCode).toBe(200)
    const cookie = (login.headers['set-cookie'] as string).split(';')[0]
    const win = 'from=2026-06-01T00:00:00.000Z&to=2026-06-20T00:00:00.000Z&tz=0'
    const authGet = async (url: string) =>
      (await a.inject({ method: 'GET', url, headers: { cookie } })).json()

    // main: bob's edit is a non-alice author → gate ON.
    const mainAll = await authGet(`/api/s/main/activity?${win}`)
    expect(mainAll.hasOtherAuthors).toBe(true)
    // solo: only alice → gate OFF (nothing to distinguish).
    const soloAll = await authGet(`/api/s/solo/activity?${win}`)
    expect(soloAll.hasOtherAuthors).toBe(false)
    // an author-scoped request never computes the signal → always false.
    const mainMine = await authGet(`/api/s/main/activity?${win}&author=mine`)
    expect(mainMine.hasOtherAuthors).toBe(false)
    // sanity: "mine" on main keeps alice's own rows (user + pat), drops bob's.
    expect(mainMine.days.reduce((s: number, d: { total: number }) => s + d.total, 0)).toBe(2)
    expect(mainAll.days.reduce((s: number, d: { total: number }) => s + d.total, 0)).toBe(3)
  })

  it("GET /activity/events — each event carries the note's current folder path (#217)", async () => {
    // The feed resolves a note's CURRENT location from the read-model (the journal
    // row has no filePath). fake note ids are `fake-<slugged-path>`, so the seeded
    // activity points at real notes; a note not in the live index resolves to null.
    const note = (title: string, filePath: string) => ({
      title,
      filePath,
      modifiedAt: '2026-06-10T00:00:00.000Z',
      createdAt: '2026-06-10T00:00:00.000Z',
      tags: [] as string[],
      content: `# ${title}`,
    })
    const fx: Fixture = {
      now: '2026-06-25T12:00:00.000Z',
      spaces: [
        {
          slug: 'main',
          displayName: 'Main',
          notes: [note('Nested', 'alpha/beta/n.md'), note('Root', 'root.md')],
          activity: [
            { date: '2026-06-10', kind: 'edited', noteId: 'fake-alpha-beta-n', title: 'Nested' },
            { date: '2026-06-11', kind: 'edited', noteId: 'fake-root', title: 'Root' },
            // A note that isn't in the live index (deleted / moved out) → path null.
            { date: '2026-06-12', kind: 'deleted', noteId: 'gone-abc', title: 'Ghost' },
          ],
        },
      ],
    }
    const a = await createApp(fx)
    const r = (await a.inject({ method: 'GET', url: '/api/s/main/activity/events' })).json()
    expect(ActivityEventsResponseSchema.safeParse(r).success).toBe(true)
    const pathByTitle = Object.fromEntries(
      r.events.map((e: { title: string; path: string | null }) => [e.title, e.path]),
    )
    expect(pathByTitle['Nested']).toBe('alpha/beta') // the note's current containing folder
    expect(pathByTitle['Root']).toBe('') // a root note (empty folder, not null)
    expect(pathByTitle['Ghost']).toBe(null) // not in the live index
  })

  it('GET /activity/projects — ranks projects by recent note activity, deepest match', async () => {
    // Notes in two project folders + SEEDED activity for them (synchronous — avoids
    // the fire-and-forget journal race a live POST would hit); explicit from/to so
    // the window doesn't depend on the wall clock. fake note ids are `fake-<path>`.
    const note = (title: string, filePath: string) => ({
      title,
      filePath,
      modifiedAt: '2026-06-10T00:00:00.000Z',
      createdAt: '2026-06-10T00:00:00.000Z',
      tags: [] as string[],
      content: `# ${title}`,
    })
    const fx: Fixture = {
      now: '2026-06-25T12:00:00.000Z',
      spaces: [
        {
          slug: 'main',
          displayName: 'Main',
          notes: [note('A1', 'alpha/a1.md'), note('A2', 'alpha/a2.md'), note('B1', 'beta/b1.md')],
          activity: [
            { date: '2026-06-10', kind: 'edited', noteId: 'fake-alpha-a1', title: 'A1' },
            { date: '2026-06-11', kind: 'edited', noteId: 'fake-alpha-a2', title: 'A2' },
            { date: '2026-06-12', kind: 'edited', noteId: 'fake-beta-b1', title: 'B1' },
          ],
        },
      ],
      projects: [
        { space: 'main', path: 'alpha', displayName: 'Alpha' },
        { space: 'main', path: 'beta', displayName: 'Beta' },
      ],
    }
    const a = await createApp(fx)
    const r = (
      await a.inject({
        method: 'GET',
        url: '/api/s/main/activity/projects?from=2026-06-01T00:00:00.000Z&to=2026-06-20T00:00:00.000Z',
      })
    ).json()
    expect(ActivityProjectsResponseSchema.safeParse(r).success).toBe(true)
    // alpha (a1 + a2) = 2 ranks above beta (b1) = 1.
    expect(r.projects.map((p: { slug: string; count: number }) => `${p.slug}:${p.count}`)).toEqual([
      'alpha:2',
      'beta:1',
    ])
  })

  it('GET /activity/projects — DEEPEST project wins (disjoint), hidden class excluded', async () => {
    // A note in outer/inner/ counts toward `inner`, NOT `outer` (disjoint buckets);
    // an agent-memory revision in outer/ must not inflate `outer` (#78). fake ids
    // are `fake-<slugged-path>`.
    const note = (title: string, filePath: string) => ({
      title,
      filePath,
      modifiedAt: '2026-06-10T00:00:00.000Z',
      createdAt: '2026-06-10T00:00:00.000Z',
      tags: [] as string[],
      content: `# ${title}`,
    })
    const fx: Fixture = {
      now: '2026-06-25T12:00:00.000Z',
      spaces: [
        {
          slug: 'main',
          displayName: 'Main',
          notes: [
            note('Outer', 'outer/a.md'),
            note('Inner', 'outer/inner/b.md'),
            note('Mem', 'outer/m.md'),
          ],
          activity: [
            { date: '2026-06-10', kind: 'edited', noteId: 'fake-outer-a', title: 'Outer' },
            { date: '2026-06-11', kind: 'edited', noteId: 'fake-outer-inner-b', title: 'Inner' },
            // agent-memory revision in outer/ — must be excluded from the count.
            {
              date: '2026-06-12',
              kind: 'edited',
              noteId: 'fake-outer-m',
              title: 'Mem',
              class: 'agent-memory',
            },
          ],
        },
      ],
      projects: [
        { space: 'main', path: 'outer', displayName: 'Outer' },
        { space: 'main', path: 'outer/inner', displayName: 'Inner' },
      ],
    }
    const a = await createApp(fx)
    const r = (
      await a.inject({
        method: 'GET',
        url: '/api/s/main/activity/projects?from=2026-06-01T00:00:00.000Z&to=2026-06-20T00:00:00.000Z',
      })
    ).json()
    const by = Object.fromEntries(
      r.projects.map((p: { slug: string; count: number }) => [p.slug, p.count]),
    )
    // Disjoint: outer keeps ONLY its own note (1), the nested note went to inner — NOT 2.
    expect(by).toEqual({ outer: 1, inner: 1 })
  })

  it('a host without the journal would 404 — but the fake always journals (capability present)', async () => {
    // The fake's CachedStore always carries the journal, so /activity answers 200;
    // the honest-404 path is exercised by the unit suite over a bare store. Here we
    // just assert the route is wired and class-scoped (default user scope).
    const res = await actApp.inject({ method: 'GET', url: '/api/s/main/activity' })
    expect(res.statusCode).toBe(200)
  })
})
