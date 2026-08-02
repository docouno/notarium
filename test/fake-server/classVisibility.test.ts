// The class-visibility invariant on the wire (#74 §2 / #78), executable — the
// class-axis analogue of the two-space isolation pack. One space holds a user
// knowledge note and a hidden agent-memory note (the engine's mount would
// enforce the class; the in-memory fake seeds it directly). The matrix: the
// agent-memory note must NOT appear on any DEFAULT user surface (list, tree,
// counts, buckets, search, graph) — yet the user still OWNS it (readable by id,
// and reachable via an explicit scope). Exclusion is a policy invariant enforced
// once at the read-model, not a per-route WHERE: every surface below goes
// through the production CachedStore + routes, so this pins the real path.

import type { FastifyInstance } from 'fastify'
import { beforeEach, describe, expect, it } from 'vitest'

import { createApp, type Fixture } from './app.js'

const MARK = 'classvis-token-9931' // shared by the bodies — search must split them
const MEM_ID = 'fake-mem-classvis'
const KB_ID = 'fake-kb-classvis'
const PROFILE_ID = 'fake-profile-classvis'

const fixture = (): Fixture => ({
  now: '2026-06-14T12:00:00.000Z',
  spaces: [
    {
      slug: 'main',
      displayName: 'Main',
      notes: [
        {
          id: KB_ID,
          title: 'Public Knowledge',
          filePath: 'kb/public-knowledge.md',
          createdAt: '2026-06-10T00:00:00.000Z',
          modifiedAt: '2026-06-10T00:00:00.000Z',
          tags: ['public-kb'],
          // Names the memory note by title — must NOT resolve into it (ghosts).
          content: `# Public Knowledge\n\nknowledge ${MARK}, see [[Private Memory]].`,
        },
        {
          id: MEM_ID,
          title: 'Private Memory',
          // Hidden agent-mount placement (#78). class is seeded directly here;
          // the real engine derives it from the mount.
          filePath: '.notarium/memory/private-memory.md',
          class: 'agent-memory',
          createdAt: '2026-06-11T00:00:00.000Z',
          modifiedAt: '2026-06-11T00:00:00.000Z',
          tags: ['secret-mem'],
          content: `# Private Memory\n\nprivate observation ${MARK}.`,
        },
        {
          id: PROFILE_ID,
          title: 'Profile',
          // The reserved profile note (#159): hidden profile-mount placement, class
          // seeded directly (the real engine derives it from the mount). Like
          // agent-memory it is hidden from search too (userSearch:false) — reached
          // only by id (Settings / start_session), never by searching notes.
          filePath: '.notarium/profile/profile.md',
          class: 'profile',
          createdAt: '2026-06-12T00:00:00.000Z',
          modifiedAt: '2026-06-12T00:00:00.000Z',
          tags: ['always-load'],
          content: `# Profile\n\nabout the user ${MARK}.`,
        },
      ],
    },
  ],
})

let app: FastifyInstance
beforeEach(async () => {
  app = await createApp(fixture())
})

const get = async (url: string) => (await app.inject({ method: 'GET', url })).json()

describe('class visibility on the wire (#78)', () => {
  it('the notes window hides agent-memory and labels the visible class', async () => {
    const notes = await get('/api/s/main/notes?preview=1')
    const ids = notes.notes.map((n: { id: string }) => n.id)
    expect(ids).toContain(KB_ID)
    expect(ids).not.toContain(MEM_ID)
    expect(notes.total).toBe(1)
    // The visible note carries its class as a read-only label.
    expect(notes.notes.find((n: { id: string }) => n.id === KB_ID).class).toBe('user-doc')
  })

  it('tree counts and buckets exclude agent-memory (counts, not just rows)', async () => {
    const tree = await get('/api/s/main/tree')
    expect(tree.stats.total).toBe(1)
    // Only the kb/ folder exists for the user; .notarium is not a user folder.
    expect(tree.folders.some((f: { path: string }) => f.path.startsWith('.notarium'))).toBe(false)
    const buckets = await get('/api/s/main/notes/buckets?group=month&sort=created')
    expect(buckets.total).toBe(1)
  })

  it('the tag facet hides agent-memory tags — the new axis rides the same #78 checkpoint', async () => {
    const facet = await get('/api/s/main/tags')
    const tags = facet.tags.map((t: { tag: string }) => t.tag)
    expect(tags).toContain('public-kb') // the visible note's tag IS faceted
    expect(tags).not.toContain('secret-mem') // the hidden note's tag never surfaces
  })

  it('user search excludes agent-memory even though the engine indexes it', async () => {
    const res = await get(`/api/s/main/search?q=${MARK}`)
    const ids = res.results.map((r: { id: string }) => r.id)
    expect(ids).toContain(KB_ID)
    expect(ids).not.toContain(MEM_ID)
  })

  it('the user graph has no agent-memory node, and a wikilink to it ghosts', async () => {
    const g = await get('/api/s/main/graph')
    expect(g.nodes.some((n: { id: string }) => n.id === MEM_ID)).toBe(false)
    expect(g.links.some((l: { target: string }) => l.target === MEM_ID)).toBe(false)
    expect(g.nodes.some((n: { id: string }) => n.id === KB_ID)).toBe(true)
  })

  it('the user still OWNS their memory: readable by id, with its class on the wire', async () => {
    const detail = await get(`/api/note?id=${MEM_ID}`)
    expect(detail.title).toBe('Private Memory')
    expect(detail.content).toContain('private observation')
    expect(detail.class).toBe('agent-memory')
    expect(detail.space).toBe('main')
  })

  it('the profile class is hidden from every discovery surface, but readable by id (#159)', async () => {
    // The #159 fix: the reserved profile note must NOT clutter discovery surfaces
    // (the bug was a visible `Profile` row in the root) — and unlike a user-doc it
    // is also kept OUT of user search (the user reaches it from Settings, not by
    // searching their notes). Reachable only by id (Settings/start_session).
    const notes = await get('/api/s/main/notes?preview=1')
    expect(notes.notes.map((n: { id: string }) => n.id)).not.toContain(PROFILE_ID)
    expect(notes.total).toBe(1) // only the user-doc — neither memory nor profile counts

    const tree = await get('/api/s/main/tree')
    expect(tree.stats.total).toBe(1)
    expect(tree.folders.some((f: { path: string }) => f.path.startsWith('.notarium'))).toBe(false)

    const g = await get('/api/s/main/graph')
    expect(g.nodes.some((n: { id: string }) => n.id === PROFILE_ID)).toBe(false)

    // Search excludes BOTH hidden classes — only the user-doc surfaces.
    const res = await get(`/api/s/main/search?q=${MARK}`)
    const hits = res.results.map((r: { id: string }) => r.id)
    expect(hits).toContain(KB_ID)
    expect(hits).not.toContain(PROFILE_ID)
    expect(hits).not.toContain(MEM_ID)

    // The user still owns it: readable by id with its class on the wire.
    const detail = await get(`/api/note?id=${PROFILE_ID}`)
    expect(detail.title).toBe('Profile')
    expect(detail.class).toBe('profile')
  })

  it('a create cannot smuggle a note into the agent-mount via a dot directory (#78)', async () => {
    // The poka-yoke: the client never chooses class. A user-doc write aimed at
    // the reserved `.notarium/...` namespace is rejected at the host boundary
    // (safeRelPath) — otherwise it would land in agent-memory (poisoning).
    const res = await app.inject({
      method: 'POST',
      url: '/api/s/main/notes',
      payload: { title: 'Smuggled', content: 'planted', directory: '.notarium/memory' },
    })
    expect(res.statusCode).toBe(400)
    // And nothing leaked into any scope.
    const all = await get('/api/s/main/notes')
    expect(all.notes.some((n: { title: string }) => n.title === 'Smuggled')).toBe(false)
  })
})
