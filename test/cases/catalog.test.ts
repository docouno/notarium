import { describe, expect, it } from 'vitest'

import {
  buildLinkIndex,
  computeCommunities,
  deriveNoteEdges,
  type NoteMeta,
  parseFrontmatterLines,
  shapeGraph,
} from '@notarium/core'
import { InMemoryStore } from '@notarium/engine-memory'

import { buildCasesWorld, buildCaseWorld, DEFAULT_NOW, mergeWorlds } from './build'
import { normDate } from './generators'
import { CASES, getCase, listCases } from './registry'
import { caseToFixture } from './toFixture'
import type { CaseWorld } from './types'

const NAMES = CASES.map((c) => c.name)

describe('seed catalog (#175)', () => {
  it('lists every case with a unique name, a real description, and a working getCase', () => {
    const listed = listCases()
    // `listCases` maps CASES verbatim, so name-equality is vacuous; assert the things
    // that can actually break: no duplicate registration, a real description, and that
    // every listed name round-trips through getCase.
    expect(new Set(NAMES).size).toBe(NAMES.length)
    for (const c of listed) {
      expect(c.description.length).toBeGreaterThan(10)
      expect(getCase(c.name).name).toBe(c.name)
    }
  })

  it.each(NAMES)('builds "%s" deterministically for a fixed seed', (name) => {
    const a = buildCaseWorld(name, { seed: 's1', scale: 0.1 })
    const b = buildCaseWorld(name, { seed: 's1', scale: 0.1 })
    expect(b).toEqual(a)
  })

  it.each(NAMES)('"%s": events are chronological and never in the future', (name) => {
    const w = buildCaseWorld(name, { scale: 0.1 })
    const dates = w.events.map((e) => normDate(e.date))
    const sorted = [...dates].sort()
    expect(dates).toEqual(sorted)
    for (const d of dates) {
      expect(d <= w.now).toBe(true)
    }
  })

  it.each(NAMES)('"%s": every edit/delete/restore targets a created note', (name) => {
    const w = buildCaseWorld(name, { scale: 0.1 })
    const created = new Set<string>()

    for (const e of w.events) {
      if (e.op === 'create') {
        created.add(e.noteId)
      } else {
        expect(created.has(e.noteId)).toBe(true)
      }
    }
  })

  it.each(NAMES)('"%s": external rewrites target one note and preserve byte length', (name) => {
    const w = buildCaseWorld(name, { scale: 0.1 })
    const created = new Set(w.events.filter((e) => e.op === 'create').map((e) => e.noteId))
    const live = new Set<string>()

    for (const event of w.events) {
      if (event.op === 'create' || event.op === 'restore') {
        live.add(event.noteId)
      } else if (event.op === 'delete') {
        live.delete(event.noteId)
      }
    }

    for (const rewrite of w.externalRewrites ?? []) {
      expect(created.has(rewrite.note)).toBe(true)
      expect(live.has(rewrite.note)).toBe(true)
      expect(rewrite.replacements.length).toBeGreaterThan(0)
      for (const replacement of rewrite.replacements) {
        expect(Buffer.byteLength(replacement.to, 'utf8')).toBe(
          Buffer.byteLength(replacement.from, 'utf8'),
        )
      }
    }
  })

  // The real applier replays op-by-op through `store.write`/`remove`/`restoreFromTrash`.
  // A delete must be a note's TERMINAL event (an `edit` after a `delete` = `store.write`
  // on a removed note → "note not found" crash), and a delete may not sort BEFORE its own
  // create (a scale-dependent date inversion → `remove` on an unknown note → crash). Guard
  // across seeds AND scales — up to the largest a case docstring advertises (`trash-long`
  // recommends SCALE=5): a scale-3-only guard passed while trash-long crashed at its own
  // documented SCALE=5 (#247). These are the exact conditions the default (scale 1) dodges.
  it.each(NAMES)('"%s": timeline stays replay-safe across seeds and scales', (name) => {
    for (const scale of [1, 3, 5, 8]) {
      for (const seed of ['default', 'qa', 'x1', 'demo']) {
        const w = buildCaseWorld(name, { scale, seed })
        const created = new Set<string>()
        const deletedNow = new Set<string>()

        for (const e of w.events) {
          if (e.op === 'create') {
            created.add(e.noteId)
            deletedNow.delete(e.noteId)
          } else {
            expect(
              created.has(e.noteId),
              `${name}/${seed}@${scale}x: ${e.op} sorts before its create (real applier would crash)`,
            ).toBe(true)
          }
          if (e.op === 'edit') {
            expect(
              deletedNow.has(e.noteId),
              `${name}/${seed}@${scale}x: edit after delete (real applier would crash)`,
            ).toBe(false)
          }
          if (e.op === 'delete') {
            deletedNow.add(e.noteId)
          }
          if (e.op === 'restore') {
            deletedNow.delete(e.noteId)
          }
        }
      }
    }
  })

  it.each(NAMES)('"%s": every event references a declared space', (name) => {
    const w = buildCaseWorld(name, { scale: 0.1 })
    const spaces = new Set(w.spaces.map((s) => s.slug))

    for (const e of w.events) {
      expect(spaces.has(e.space)).toBe(true)
    }
    for (const p of w.projects ?? []) {
      expect(spaces.has(p.space)).toBe(true)
    }
  })

  describe('combining cases (CASE=a,b,c)', () => {
    it('a single-name spec equals buildCaseWorld', () => {
      expect(buildCasesWorld('trash-mixed', { now: DEFAULT_NOW })).toEqual(
        buildCaseWorld('trash-mixed', { now: DEFAULT_NOW }),
      )
    })

    it('merges spaces by slug and unions distinct spaces', () => {
      // feed-scroll + multi-space: `main` (shared) merges once; work/research/home add.
      const w = buildCasesWorld('feed-scroll,multi-space', { scale: 0.1, now: DEFAULT_NOW })
      const slugs = w.spaces.map((s) => s.slug)
      expect(new Set(slugs).size).toBe(slugs.length) // no duplicate space
      expect(slugs).toContain('main')
      expect(slugs).toContain('home')
      expect(w.auth).toBeTruthy() // multi-space contributes auth → password mode
    })

    it('unions same-space aliases in stable first-seen order without duplicates', () => {
      const world = (aliases: string[]): CaseWorld => ({
        now: DEFAULT_NOW,
        spaces: [{ slug: 'main', aliases }],
        events: [],
      })
      const merged = mergeWorlds([
        { name: 'a', world: world(['old-a']) },
        { name: 'b', world: world(['old-b', 'old-a']) },
      ])

      expect(merged.spaces).toEqual([{ slug: 'main', aliases: ['old-a', 'old-b'] }])
    })

    it('namespaces logical ids and never collides paths across cases', () => {
      const w = buildCasesWorld('feed-scroll,trash-mixed,multi-space', {
        scale: 0.1,
        now: DEFAULT_NOW,
      })
      // every edit/delete still resolves to a created note (ids stayed consistent)
      const created = new Set<string>()

      for (const e of w.events) {
        if (e.op === 'create') {
          created.add(e.noteId)
        } else {
          expect(created.has(e.noteId)).toBe(true)
        }
      }
      // no two creates share (space, path)
      const seen = new Set<string>()

      for (const e of w.events) {
        if (e.op !== 'create') {
          continue
        }
        const key = `${e.space}\0${e.path}`
        expect(seen.has(key)).toBe(false)
        seen.add(key)
      }
      // combined events cover more than any single case
      expect(w.events.length).toBeGreaterThan(
        buildCaseWorld('trash-mixed', { now: DEFAULT_NOW }).events.length,
      )
    })

    it('a combined world still reduces to a valid fixture', () => {
      const fx = caseToFixture(buildCasesWorld('trash-mixed,multi-space', { now: DEFAULT_NOW }))
      const slugs = fx.spaces.map((s) => s.slug)
      expect(slugs).toContain('main')
      expect(slugs).toContain('work')
      for (const s of fx.spaces) {
        for (const n of s.notes) {
          expect(n.filePath).toBeTruthy()
        }
      }
    })

    it('merges auth across two auth-declaring cases (dedup owner, keep admin, union members)', () => {
      // multi-space + dashboard-activity both declare `sergey`; the auth-merge else-branch
      // (dedup + admin/personalSpace carry + member union) only runs when two auth cases combine.
      const w = buildCasesWorld('multi-space,dashboard-activity', { scale: 0.1, now: DEFAULT_NOW })
      const usernames = w.auth!.users.map((u) => u.username)
      expect(usernames.filter((u) => u === 'sergey').length).toBe(1) // deduped to one
      expect(w.auth!.users.find((u) => u.username === 'sergey')?.admin).toBe(true) // admin preserved
      expect(usernames).toContain('alex') // dashboard-activity's collaborator
      const memberSpaces = new Set(w.auth!.members.map((m) => m.space))
      expect(memberSpaces.has('work')).toBe(true) // from multi-space
      expect(memberSpaces.has('main')).toBe(true) // from dashboard-activity
    })
  })

  it('scale multiplies generated volume', () => {
    const small = buildCaseWorld('feed-scroll', { scale: 0.1 }).events.length
    const big = buildCaseWorld('feed-scroll', { scale: 0.5 }).events.length
    expect(big).toBeGreaterThan(small)
  })

  it('graph-load scales to the canonical 3k-node linked workload', () => {
    const world = buildCaseWorld('graph-load', { scale: 10 })
    const creates = world.events.filter((event) => event.op === 'create')
    const notes: NoteMeta[] = creates.map((event) => ({
      id: event.noteId,
      title: event.title,
      filePath: event.path,
      tags: event.tags,
      createdAt: event.date,
      modifiedAt: event.date,
    }))
    const index = buildLinkIndex(notes)
    const ghosts = new Map<string, ReturnType<typeof deriveNoteEdges>['ghosts'][number]>()
    const edgesBySource = creates.map((event) => {
      const derived = deriveNoteEdges(event.noteId, event.content, index, 'links_to')

      for (const ghost of derived.ghosts) {
        ghosts.set(ghost.id, ghost)
      }

      return [event.noteId, derived.edges] as [string, typeof derived.edges]
    })
    const graph = shapeGraph(notes, edgesBySource, ghosts)
    const communities = computeCommunities(graph.nodes, graph.links)

    expect(graph.nodes).toHaveLength(3_000)
    expect(graph.nodes.every((node) => !node.ghost)).toBe(true)
    expect(graph.links).toHaveLength(8_976)
    expect(new Set(graph.links.map((edge) => `${edge.source}\0${edge.target}`)).size).toBe(8_976)
    expect(new Set(notes.map((note) => note.filePath.split('/')[1])).size).toBe(12)
    expect(new Set(communities.values()).size).toBe(12)
  })

  it('agent-context carries a real retrieval-audit demo (#243)', () => {
    const w = buildCaseWorld('agent-context', { now: DEFAULT_NOW })
    const retrievals = w.retrievals ?? []
    expect(retrievals).toHaveLength(70)
    expect(new Set(retrievals.map((r) => r.tool))).toEqual(
      new Set(['search', 'recall', 'get_note']),
    )
    expect(retrievals.some((r) => (r.hits ?? []).length > 0)).toBe(true)
    expect(
      retrievals.filter((r) => r.query === 'deploy prod checklist' && (r.hits ?? []).length === 0),
    ).toHaveLength(3)
    expect(w.auth?.connectedApps?.some((app) => app.appName === 'Claude')).toBe(true)
  })

  it('agent-sessions carries episodes plus divergent owner/root/fork delta positions', () => {
    const world = buildCaseWorld('agent-sessions', { now: DEFAULT_NOW })
    const sessions = world.agentSessions ?? []
    expect(sessions).toHaveLength(8)
    expect(sessions.find((session) => session.parentRef)?.parentRef).toBe('review-root')
    expect(sessions.some((session) => session.named === false)).toBe(true)
    expect(sessions.some((session) => session.lastSeenDaysAgo > 30)).toBe(true)
    expect(sessions.some((session) => session.name.length === 160)).toBe(true)
    expect(sessions.find((session) => session.ref === 'expired')?.retained).toBe(false)
    expect(world.retrievals?.some((retrieval) => retrieval.sessionRef === 'expired')).toBe(true)
    expect(world.events.some((event) => event.agentAudit?.sessionRef === 'expired')).toBe(true)
    expect(
      world.retrievals?.some(
        (retrieval) =>
          retrieval.sessionRef === 'hostile-label' && retrieval.query.includes('<script>'),
      ),
    ).toBe(true)
    expect(world.events.some((event) => event.agentAudit && !event.agentAudit.sessionRef)).toBe(
      true,
    )
    expect(world.agentDeltaCursors).toEqual([
      expect.objectContaining({ sessionRef: 'review-root' }),
      expect.objectContaining({ sessionRef: 'review-fork' }),
      expect.not.objectContaining({ sessionRef: expect.anything() }),
      expect.objectContaining({ sessionRef: 'bob-review' }),
    ])
    expect(sessions.find((session) => session.ref === 'bob-review')?.owner).toBe('bob')
    expect(
      world.agentDeltaCursors?.find((cursor) => cursor.sessionRef === 'bob-review')?.owner,
    ).toBeUndefined()
    expect(world.projects).toContainEqual(expect.objectContaining({ space: 'main', path: '' }))

    const fixture = caseToFixture(world)
    expect(fixture.agentSessions).toHaveLength(7)
    expect(
      fixture.agentSessions?.every((session) => /^ses_[A-Za-z0-9_-]{12}$/.test(session.id)),
    ).toBe(true)
    const fork = fixture.agentSessions?.find((session) => session.parentId)
    expect(fixture.agentSessions?.some((session) => session.id === fork?.parentId)).toBe(true)
  })

  it('agent-roles keeps catalog-only, owned-idle, and owned-active states distinct', () => {
    const world = buildCaseWorld('agent-roles', { now: DEFAULT_NOW })

    expect(world.agentRoles).toEqual([
      { name: 'grooming', target: { kind: 'personal', user: 'bob' } },
      { name: 'research', target: { kind: 'personal', user: 'maya' } },
      { name: 'grooming', target: { kind: 'personal', user: 'maya' } },
      { name: 'research', target: { kind: 'space', space: 'team' } },
      { name: 'research', target: { kind: 'project', space: 'team', path: 'other' } },
      { name: 'research', target: { kind: 'project', space: 'maya-home', path: 'work' } },
    ])
    expect(world.agentSessions).toContainEqual(
      expect.objectContaining({ owner: 'maya', role: 'research' }),
    )
    expect(world.agentSessions?.some((session) => session.owner === 'bob')).toBe(false)
    expect(world.spaces.some((space) => space.personalFor === 'fresh')).toBe(false)
    expect(world.auth?.members.some((member) => member.username === 'fresh')).toBe(false)
    expect(world.auth?.members).toContainEqual({
      space: 'team',
      username: 'robin',
      role: 'reader',
    })

    const fixture = caseToFixture(world)
    expect(fixture.agentRoles).toEqual(world.agentRoles)
    expect(fixture.agentSessions?.find((session) => session.owner === 'maya')?.role).toBe(
      'research',
    )
  })

  it('rejects a delta cursor anchored in another project revision stream', () => {
    const world = buildCaseWorld('agent-sessions', { now: DEFAULT_NOW })
    const cursors = world.agentDeltaCursors ?? []
    const invalid: CaseWorld = {
      ...world,
      agentDeltaCursors: [
        { ...cursors[0], project: { ...cursors[0].project, space: 'another-space' } },
      ],
    }

    expect(() => mergeWorlds([{ name: 'invalid', world: invalid }])).toThrow(
      /belongs to space main, not project space another-space/,
    )
  })

  it('combining cases namespaces agent-session refs and their parent chain', () => {
    const combined = buildCasesWorld('agent-sessions,multi-space', { now: DEFAULT_NOW })
    const fork = combined.agentSessions?.find((session) => session.ref.endsWith('review-fork'))
    expect(fork).toMatchObject({
      ref: 'agent-sessions:review-fork',
      parentRef: 'agent-sessions:review-root',
    })
    expect(
      combined.agentDeltaCursors?.find((cursor) => cursor.sessionRef?.endsWith('review-fork')),
    ).toMatchObject({
      sessionRef: 'agent-sessions:review-fork',
      throughNote: expect.stringMatching(/^agent-sessions:/),
    })
  })

  it('multi-space carries an unapproved OAuth registration', () => {
    const pending = buildCaseWorld('multi-space', { now: DEFAULT_NOW }).auth?.pendingOAuthClients
    expect(pending).toEqual([
      expect.objectContaining({
        kind: 'dcr',
        clientName: 'Pending MCP Inspector',
        registeredHoursAgo: 2,
      }),
    ])
  })

  it('multi-space carries the admin-recovery alias and zero-grant edges', () => {
    const world = buildCaseWorld('multi-space', { now: DEFAULT_NOW })
    expect(world.spaces.find((space) => space.slug === 'work')?.aliases).toEqual([
      'research',
      'shared-history',
    ])
    expect(world.spaces.find((space) => space.slug === 'research')?.aliases).toEqual([
      'library',
      'shared-history',
    ])
    expect(world.spaces.find((space) => space.slug === 'scratch')?.aliases).toEqual(['drafts'])
    expect(world.auth?.users.some((user) => user.username === 'recovery')).toBe(true)
    expect(world.auth?.members.some((member) => member.username === 'recovery')).toBe(false)

    const fixture = caseToFixture(world)
    expect(fixture.spaces.find((space) => space.slug === 'research')?.aliases).toEqual([
      'library',
      'shared-history',
    ])
  })

  // The jobs layer (#105/#101) is real-applier-only, so nothing else here reads it:
  // without these, `b.job()` and the mergeWorlds branch could both become no-ops and
  // every suite would stay green — while `make seed`, the task's own live check of the
  // data root, quietly stopped writing an artifact.
  it('jobs carries the terminal export states, artifact TTLs included (#105/#101)', () => {
    const w = buildCaseWorld('jobs', { now: DEFAULT_NOW })
    const jobs = w.jobs ?? []
    expect(jobs).toHaveLength(4)
    expect(new Set(jobs.map((j) => j.status))).toEqual(new Set(['succeeded', 'failed', 'canceled']))
    // Every decl must be terminal: the stand's live runner drains anything else within
    // a tick, so a pending/running row is not a state a stand can be seeded into.
    expect(jobs.every((j) => ['succeeded', 'failed', 'canceled'].includes(j.status))).toBe(true)
    // One live artifact (the Export tab adopts it) and one lapsed TTL (GC cleared the
    // pointer) — the two halves of "download it later".
    expect(jobs.filter((j) => j.status === 'succeeded' && j.artifactTtlDays === null)).toHaveLength(
      1,
    )
    expect(
      jobs.filter((j) => j.status === 'succeeded' && j.artifactTtlDays === undefined),
    ).toHaveLength(1)
    // Every job addresses a space the case actually declares — the applier throws otherwise.
    const slugs = new Set(w.spaces.map((s) => s.slug))
    expect(jobs.every((j) => slugs.has(j.space))).toBe(true)
    expect(w.durableImports).toEqual([
      expect.objectContaining({
        space: 'main',
        jobId: 'seed-backup-probe',
        retryAt: '9999-12-31T00:00:00.000Z',
        error: 'seeded_transient_import_failure',
      }),
    ])
  })

  it('combining cases carries jobs through mergeWorlds INTACT (#101)', () => {
    // Whole-value, not a count: a merge that dropped params/owner/error/artifactTtlDays
    // while keeping the row count would pass a length check and still seed a stand that
    // exports the wrong scope, or never expires an artifact.
    const combined = buildCasesWorld('jobs,trash-mixed', { now: DEFAULT_NOW })
    const alone = buildCaseWorld('jobs', { now: DEFAULT_NOW })
    expect(combined.jobs).toEqual(alone.jobs)
    expect(combined.durableImports).toEqual(alone.durableImports)
    const slugs = new Set(combined.spaces.map((s) => s.slug))
    expect((combined.jobs ?? []).every((j) => slugs.has(j.space))).toBe(true)
  })

  it('combining cases namespaces external-rewrite note handles (#267)', () => {
    const combined = buildCasesWorld('external-edits,trash-mixed', { now: DEFAULT_NOW })
    const rewrite = combined.externalRewrites?.[0]
    expect(rewrite?.note).toBe('external-edits:n-3')
    expect(combined.events.some((e) => e.noteId === rewrite?.note)).toBe(true)
  })

  describe('caseToFixture (the fake projection)', () => {
    it.each(NAMES)('"%s": reduces to a valid fixture (live snapshot + activity)', (name) => {
      const w = buildCaseWorld(name, { scale: 0.1, now: DEFAULT_NOW })
      const fx = caseToFixture(w)
      expect(fx.now).toBe(w.now)
      expect(fx.spaces.map((s) => s.slug)).toEqual(w.spaces.map((s) => s.slug))
      // A note whose last op is delete is NOT in the live snapshot; every live
      // note has a path + title, and activity rows carry a date within the window.
      for (const s of fx.spaces) {
        for (const n of s.notes) {
          expect(n.filePath).toBeTruthy()
          expect(n.title).toBeTruthy()
        }
        for (const a of s.activity ?? []) {
          expect(a.date <= w.now).toBe(true)
        }
      }
    })

    it('trash-mixed: deleted notes leave the snapshot; a restored one returns', () => {
      const w = buildCaseWorld('trash-mixed', {})
      const fx = caseToFixture(w)
      const main = fx.spaces.find((s) => s.slug === 'main')!
      const liveTitles = new Set(main.notes.map((n) => n.title))
      // The permanently-deleted notes (5 standalone + a deleted folder + a project note)
      // are gone from the live snapshot.
      const deletedRows = (main.activity ?? []).filter((a) => a.kind === 'deleted')
      expect(deletedRows.length).toBe(10) // 9 permanent + the restored note's delete row
      for (const t of ['Dropped idea 1', 'Scratch 1', 'Retired plan']) {
        expect(liveTitles.has(t)).toBe(false)
      }
      // The deleted-THEN-restored note is back in the live snapshot, and its journal
      // carries both a delete and a restore row.
      expect(liveTitles.has('Recovered draft')).toBe(true)
      const recovered = (main.activity ?? [])
        .filter((a) => a.title === 'Recovered draft')
        .map((a) => a.kind)
      expect(recovered).toContain('deleted')
      expect(recovered).toContain('restored')
    })

    it('multi-space: agent-memory notes carry class + summary into the snapshot', () => {
      const fx = caseToFixture(buildCaseWorld('multi-space', {}))
      const home = fx.spaces.find((s) => s.slug === 'home')!
      const mem = home.notes.filter((n) => n.class === 'agent-memory')
      expect(mem.length).toBeGreaterThan(0)
      expect(mem.every((n) => typeof n.summary === 'string')).toBe(true)
      expect(mem.some((n) => n.muted === true)).toBe(true)
    })

    it('preserves absent event tags so imported carried tags are derived by the fake store', async () => {
      const date = '2025-04-03T02:01:00.000Z'
      const world: CaseWorld = {
        now: date,
        spaces: [{ slug: 'main' }],
        events: [
          {
            op: 'create',
            date,
            space: 'main',
            noteId: 'carried-tags',
            path: 'carried-tags.md',
            title: 'Carried tags',
            content: 'body',
            frontmatter: 'tags: [from-carry]\nauthor: S',
          },
        ],
      }
      const fixture = caseToFixture(world)
      const snapshot = fixture.spaces[0].notes[0]
      expect(snapshot.tags).toBeUndefined()

      const store = new InMemoryStore({
        space: fixture.spaces[0].slug,
        now: fixture.now,
        notes: fixture.spaces[0].notes,
      })
      const view = await store.read((await store.list())[0].id!)
      expect(view.frontmatter.tags).toEqual(['from-carry'])
    })

    it('folds source aliases into rename history without losing either alias', async () => {
      const created = '2025-04-03T02:01:00.000Z'
      const renamed = '2025-04-04T02:01:00.000Z'
      const world: CaseWorld = {
        now: renamed,
        spaces: [{ slug: 'main' }],
        events: [
          {
            op: 'create',
            date: created,
            space: 'main',
            noteId: 'carried-aliases',
            path: 'carried-aliases.md',
            title: 'Original',
            content: 'body',
            frontmatter: 'aliases: [Source Alias]\nauthor: S',
          },
          {
            op: 'edit',
            date: renamed,
            space: 'main',
            noteId: 'carried-aliases',
            title: 'Renamed',
          },
        ],
      }
      const fixture = caseToFixture(world)
      const snapshot = fixture.spaces[0].notes[0]
      expect(snapshot.aliases).toEqual(['Source Alias', 'Original'])

      const store = new InMemoryStore({
        space: fixture.spaces[0].slug,
        now: fixture.now,
        notes: fixture.spaces[0].notes,
      })
      expect((await store.read('Source Alias')).title).toBe('Renamed')
      expect((await store.read('Original')).title).toBe('Renamed')
    })

    it('does not retire a carried custom slug that remains current after a title rename', async () => {
      const created = '2025-04-03T02:01:00.000Z'
      const renamed = '2025-04-04T02:01:00.000Z'
      const frontmatter = 'slug: old\nauthor: S'
      const world: CaseWorld = {
        now: renamed,
        spaces: [{ slug: 'main' }],
        events: [
          {
            op: 'create',
            date: created,
            space: 'main',
            noteId: 'carried-slug',
            path: 'old.md',
            title: 'Old',
            content: 'body',
            frontmatter,
          },
          {
            op: 'edit',
            date: renamed,
            space: 'main',
            noteId: 'carried-slug',
            title: 'New',
          },
        ],
      }
      const fixture = caseToFixture(world)
      const snapshot = fixture.spaces[0].notes[0]
      expect(snapshot.aliases).toEqual([])

      const loaded = new InMemoryStore({
        space: fixture.spaces[0].slug,
        now: fixture.now,
        notes: fixture.spaces[0].notes,
      })
      const live = new InMemoryStore({ space: 'main', now: created, notes: [] })
      const createdLive = await live.write({
        title: 'Old',
        content: 'body',
        fileName: 'old',
        frontmatter: parseFrontmatterLines(frontmatter),
      })
      await live.write({
        title: 'New',
        content: 'body',
        originalId: createdLive.id,
        versionToken: createdLive.versionToken,
      })

      const namingView = async (store: InMemoryStore) => {
        const view = await store.read('old')
        return {
          title: view.title,
          slug: view.slug,
          aliases: view.aliases,
          frontmatterAliases: view.frontmatter.aliases,
        }
      }
      expect(await namingView(loaded)).toEqual(await namingView(live))
      expect(await namingView(loaded)).toEqual({
        title: 'New',
        slug: 'old',
        aliases: undefined,
        frontmatterAliases: undefined,
      })
    })

    it('projects rename alias-history so a former title still resolves (#100)', () => {
      // A rename must carry the OLD title into `aliases` (else the fake turns it into an
      // unintended ghost while the real applier resolves it). graph: "Legacy Name" →
      // "Renamed Note"; wiki-web: "Search v1" → "Search v2".
      const g = caseToFixture(buildCaseWorld('graph', { now: DEFAULT_NOW }))
      const renamed = g.spaces.flatMap((s) => s.notes).find((n) => n.title === 'Renamed Note')
      expect(renamed?.aliases).toContain('Legacy Name')
      const w = caseToFixture(buildCaseWorld('wiki-web', { now: DEFAULT_NOW }))
      const search = w.spaces.flatMap((s) => s.notes).find((n) => n.title === 'Search v2')
      expect(search?.aliases).toContain('Search v1')
    })

    it('projects the final external rewrite without inventing authored activity (#267)', () => {
      const fx = caseToFixture(buildCaseWorld('external-edits', { now: DEFAULT_NOW }))
      const main = fx.spaces.find((s) => s.slug === 'main')!
      const probe = main.notes.find((n) => n.title === 'External edit probe')!

      expect(probe.content).toContain('fresh-token')
      expect(probe.content).toContain('[[Target B]]')
      expect(probe.content).not.toContain('stale-token')
      expect(probe.content).not.toContain('[[Target A]]')
      expect(main.activity?.filter((a) => a.title === probe.title)).toHaveLength(1)
    })
  })
})
