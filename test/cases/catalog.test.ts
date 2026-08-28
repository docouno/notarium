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
// The budget the seeded window is measured against, read from its owner rather than
// written down here: a case tuned to a number this test invents proves nothing.
import { PROJECT_TOKEN_BUDGET } from '../../packages/server/src/services/spaces/agentContext'
import { buildCasesWorld, buildCaseWorld, DEFAULT_NOW, mergeWorlds } from './build'
import { normDate } from './generators'
import { CASES, getCase, listCases } from './registry'
import { materializeRevisionState } from './revisionStates'
import { agentSessionId } from './sessionIds'
import { caseToFixture } from './toFixture'
import type { AgentRoleTargetDecl, CaseWorld } from './types'

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

  // A description is operator-facing copy — `make seed CASE=…` prints it and then hands
  // over a stand — and the operator has no way to check it: `agent-abilities-sparse`
  // said "no Owned role or skill" while seeding an Owned skill, so the one case that
  // exists to show a first-run stand advertised the wrong first run. A NEGATIVE claim is
  // the half a machine CAN check, and it is the half that rots: a case grows states long
  // after its sentence was written, and nothing pulls the sentence along.
  const ABSENCE_CLAIMS: Array<{ claim: RegExp; holds: (world: CaseWorld) => boolean }> = [
    { claim: /\bno owned role\b/i, holds: (world) => !world.agentRoles?.length },
    { claim: /\bno owned (role or )?skill\b/i, holds: (world) => !world.agentSkills?.length },
    {
      claim: /\bno memory\b/i,
      holds: (world) =>
        !world.events.some((event) => event.op === 'create' && event.class === 'agent-memory'),
    },
    { claim: /\bno session\b/i, holds: (world) => !world.agentSessions?.length },
  ]

  it('no case description claims an ABSENCE the case then declares', () => {
    const broken: string[] = []

    for (const { name, description } of listCases()) {
      const world = buildCaseWorld(name, { now: DEFAULT_NOW })

      for (const { claim, holds } of ABSENCE_CLAIMS) {
        if (claim.test(description) && !holds(world)) {
          broken.push(`${name}: "${description.match(claim)?.[0]}" is not true of the world`)
        }
      }
    }

    expect(broken).toEqual([])
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

  it.each(NAMES)('"%s": a seeded identity claim names two live notes in two spaces', (name) => {
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

    // The seeded collision is only a collision if the two notes live in DIFFERENT
    // spaces — a same-space pair reproduces the existing duplicate contract, not
    // #327, and the catalog would still be green while the stand seeds the wrong bug.
    for (const claim of w.externalIdentityClaims ?? []) {
      expect(created.has(claim.note)).toBe(true)
      expect(live.has(claim.note)).toBe(true)
      expect(created.has(claim.claimFrom)).toBe(true)
      expect(live.has(claim.claimFrom)).toBe(true)
      expect(claim.note).not.toBe(claim.claimFrom)

      const spaceOf = (handle: string): string | undefined =>
        w.events.find((e) => e.noteId === handle && e.op === 'create')?.space

      expect(spaceOf(claim.note)).toBeTruthy()
      expect(spaceOf(claim.note)).not.toBe(spaceOf(claim.claimFrom))
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

  it('trash-recovery keeps availability states and a runtime path conflict distinct', () => {
    const world = buildCaseWorld('trash-recovery', { now: DEFAULT_NOW })
    const createdAtPath = world.events.filter(
      (event) => event.op === 'create' && event.path === 'shared/weekly-status.md',
    )
    const states = world.revisionStates ?? []

    expect(createdAtPath).toHaveLength(2)
    expect(states.map((revision) => revision.state.kind)).toEqual([
      'legacy',
      'document',
      'document',
      'gap',
    ])
    expect(
      world.events.find(
        (event) => event.op === 'create' && event.path === 'imports/imported-helper-source.md',
      ),
    ).toBeDefined()
    // Source-only, and it has to STAY source-only: the row is a package root whose
    // manifest name is not one a package can carry, so restore has bytes to show and
    // nothing safe to republish. A name that projects cleanly turns this into an
    // ordinary full restore and the case silently loses the state.
    expect(
      materializeRevisionState(states[2], {
        noteId: 'seedImportedHelp',
        path: 'imports/imported-helper-source.md',
        createdAt: DEFAULT_NOW,
        title: 'Imported helper source',
      }).restoreAvailability,
    ).toBe('opaque')
    expect(
      world.events.filter(
        (event) => event.op === 'create' && event.path.startsWith('recoverable/meeting-note-'),
      ),
    ).toHaveLength(24)
    expect(world.spaces).toContainEqual(
      expect.objectContaining({ slug: 'closed-project', archived: true }),
    )
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
    // The Budget Lab project whose two heavy pins leave Q with less than the personal set
    // costs, so the cut lands INSIDE the set (#393) — the only place in the catalogue where
    // a trimmed set item and a trimmed pin sit under one caption. Both sides of that window
    // are DERIVED, not written down: the budget from the server's own constant, the span
    // from the set's members. `fatBody` writes ~4 ASCII characters per token, so the sizes
    // the case declares are readable back off the events. Move either pin, or resize any
    // member of `Frontend Canon`, and the cut walks out of the set — which is exactly what
    // this has to catch, because nothing else in the suite opens that route.
    expect(w.projects).toContainEqual(
      expect.objectContaining({ space: 'budget-lab', path: 'set-trim' }),
    )

    const tokensOf = (predicate: (path: string) => boolean): number[] =>
      w.events.flatMap((event) =>
        event.op === 'create' && predicate(event.path)
          ? [Math.round((event.content ?? '').length / 4)]
          : [],
      )
    const setMembers = tokensOf((path) => ['frontend.md', 'api.md', 'naming.md'].includes(path))
    const setTrimPins = tokensOf((path) => path.startsWith('set-trim/'))
    const remainder = PROJECT_TOKEN_BUDGET - setTrimPins.reduce((sum, tokens) => sum + tokens, 0)

    expect(setTrimPins).toHaveLength(2)
    expect(setMembers).toHaveLength(3)
    // Inside the set: the first member fits the remainder, the whole set does not.
    expect(remainder).toBeGreaterThan(setMembers[0]!)
    expect(remainder).toBeLessThan(setMembers.reduce((sum, tokens) => sum + tokens, 0))

    const overview = w.events.find(
      (event) => event.op === 'create' && event.path === 'product/index.md',
    )
    expect(overview).toEqual(
      expect.objectContaining({
        title: 'Product OS overview',
        pin: true,
      }),
    )
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
    // The Agent facet in the Activity aside has no pagination and, since #393, no ceiling
    // of its own — so how many labels the owner has IS the state. Retrievals are the only
    // way to add one without a session or a write, both of which are counted whole above.
    // Owner by the same rule the contract states — an absent one is inherited from the
    // bound session, not from the primary owner — so the count is of labels the STAND
    // OWNER's facet will actually carry.
    const ownerOf = (ref: string | undefined, explicit: string | undefined): string | undefined =>
      explicit ?? sessions.find((session) => session.ref === ref)?.owner ?? 'sergey'

    expect(
      new Set(
        [
          ...(world.retrievals ?? [])
            .filter((retrieval) => ownerOf(retrieval.sessionRef, retrieval.owner) === 'sergey')
            .map((retrieval) => retrieval.agent),
          ...world.events
            .filter((event) => event.agentAudit && !event.agentAudit.owner)
            .map((event) => event.agentAudit?.agent),
        ].filter(Boolean),
      ).size,
    ).toBeGreaterThanOrEqual(5)
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
    expect(
      fixture.spaces
        .flatMap((space) => space.activity ?? [])
        .some((event) => event.agent?.session?.id === agentSessionId('review-fork')),
    ).toBe(true)
    expect(
      fixture.spaces
        .flatMap((space) => space.activity ?? [])
        .some((event) => event.agent && event.agent.session == null),
    ).toBe(true)
    expect(
      fixture.spaces
        .flatMap((space) => space.activity ?? [])
        .filter((event) => event.agent?.owner === 'sergey'),
    ).toHaveLength(58)
    expect(
      fixture.spaces
        .flatMap((space) => space.activity ?? [])
        .some((event) => event.unavailable && event.agent?.session?.id),
    ).toBe(true)
  })

  it('agent-roles keeps catalog-only, owned-idle, and owned-active states distinct', () => {
    const world = buildCaseWorld('agent-roles', { now: DEFAULT_NOW })

    expect(world.agentRoles).toEqual([
      { name: 'grooming', target: { kind: 'personal', user: 'bob' } },
      expect.objectContaining({
        source: 'custom',
        name: 'release-reviewer',
        target: { kind: 'personal', user: 'sergey' },
      }),
      expect.objectContaining({
        source: 'custom',
        name: 'research',
        target: { kind: 'personal', user: 'maya' },
      }),
      { name: 'grooming', target: { kind: 'personal', user: 'maya' } },
      expect.objectContaining({
        source: 'custom',
        name: 'research',
        target: { kind: 'space', space: 'team' },
      }),
      expect.objectContaining({
        source: 'custom',
        name: 'research',
        target: { kind: 'project', space: 'team', path: 'other' },
      }),
      expect.objectContaining({
        source: 'custom',
        name: 'field-guide',
        target: { kind: 'project', space: 'team', path: 'other' },
      }),
      // The V18 state a copy used to stand in for: one Space role, narrowed to two
      // of the five Team projects.
      expect.objectContaining({
        source: 'custom',
        name: 'launch-review',
        target: { kind: 'space', space: 'team' },
        availability: {
          mode: 'selected-projects',
          projects: [
            { space: 'team', path: 'alpha' },
            { space: 'team', path: 'beta' },
          ],
        },
      }),
      expect.objectContaining({
        source: 'custom',
        name: 'research',
        target: { kind: 'project', space: 'maya-home', path: 'work' },
      }),
      expect.objectContaining({
        source: 'custom',
        name: 'release-captain',
        target: { kind: 'personal', user: 'maya' },
      }),
      expect.objectContaining({
        source: 'custom',
        name: 'retired-captain',
        deleted: true,
      }),
    ])
    expect(world.agentSessions).toContainEqual(
      expect.objectContaining({ owner: 'maya', role: 'research' }),
    )
    expect(world.agentSkills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'meeting-brief',
          home: expect.objectContaining({ kind: 'personal' }),
        }),
        expect.objectContaining({
          name: 'team-tone',
          home: expect.objectContaining({ kind: 'space' }),
          availability: { mode: 'all-projects' },
        }),
        expect.objectContaining({
          name: 'coder',
          home: { kind: 'space', space: 'team' },
          availability: {
            mode: 'selected-projects',
            projects: [
              { space: 'team', path: 'alpha' },
              { space: 'team', path: 'beta' },
            ],
          },
        }),
        expect.objectContaining({
          source: 'catalog',
          name: 'grooming-evidence',
        }),
        expect.objectContaining({
          name: 'research-evidence',
          renameTo: 'source-audit',
          home: { kind: 'space', space: 'team' },
          linkedRole: 'research',
        }),
        expect.objectContaining({ name: 'handoff-check', linkedRole: 'grooming' }),
        expect.objectContaining({ name: 'retired-check', deleted: true }),
      ]),
    )
    expect(world.agentSkills?.some((skill) => 'target' in skill)).toBe(false)
    expect(world.agentSkills?.filter((skill) => skill.name === 'shared-review')).toHaveLength(2)
    expect(world.agentSessions?.some((session) => session.owner === 'bob')).toBe(false)
    expect(world.spaces.some((space) => space.personalFor === 'fresh')).toBe(false)
    expect(world.auth?.members.some((member) => member.username === 'fresh')).toBe(false)
    expect(world.auth?.members).toContainEqual({
      space: 'team',
      username: 'robin',
      role: 'reader',
    })
    expect(
      world.events.filter((event) => event.op === 'create' && event.class === 'agent-memory'),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ space: 'main', title: 'release-preferences' }),
        expect.objectContaining({
          space: 'main',
          title: 'release-handoff',
          projectMemory: { space: 'main', path: 'other' },
        }),
      ]),
    )

    const fixture = caseToFixture(world)
    const main = fixture.spaces.find((space) => space.slug === 'main')
    expect(main?.notes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          filePath: '.notarium/memory/release-preferences.md',
          class: 'agent-memory',
        }),
        expect.objectContaining({
          filePath: '.notarium/memory/proj-main-other/release-handoff.md',
          class: 'agent-memory',
        }),
      ]),
    )
    expect(fixture.agentRoles).toEqual(world.agentRoles)
    expect(fixture.agentSkills).toEqual(world.agentSkills)
    expect(fixture.agentSessions?.find((session) => session.owner === 'maya')?.role).toBe(
      'research',
    )
  })

  it('agent-abilities-rich fills every group and names the states only volume shows', () => {
    const world = buildCaseWorld('agent-abilities-rich', { now: DEFAULT_NOW })
    const roles = world.agentRoles ?? []
    const skills = world.agentSkills ?? []
    // Space-qualified on purpose: a project of the owner's PERSONAL space is a
    // different placement group from a project of a shared one — Personal is that
    // space's root — and a key that named only the path would have merged the two.
    const groupOf = (target: AgentRoleTargetDecl) =>
      target.kind === 'project' ? `project:${target.space}/${target.path}` : target.kind
    const byGroup = new Map<string, number>()

    for (const role of roles) {
      byGroup.set(groupOf(role.target), (byGroup.get(groupOf(role.target)) ?? 0) + 1)
    }

    // Every group populated AT ONCE for one owner — what `agent-roles` cannot show
    // with one placement per principal — and Personal past the explorer's page size,
    // so pagination is reachable at the default SCALE rather than only above it.
    expect([...byGroup].sort()).toEqual([
      ['personal', 16],
      ['project:main/', 1],
      ['project:product/api', 4],
      ['project:product/legacy', 1],
      ['project:product/mobile', 1],
      ['project:product/web', 7],
      ['space', 14],
    ])
    // Fifteen of these twenty hold no ability at all, and that is the point: the Project
    // facet in the library aside has no pagination, so the LENGTH of the list is a state
    // (#393). With `main`'s own project the facet runs twenty-one rows — see
    // FACET_PROJECTS in the case.
    expect(world.projects?.filter((project) => project.space === 'product')).toHaveLength(20)
    // The authored H1 is the human title on every surface that lists a role, and this
    // one is long enough to force truncation in cards, explorer rows and breadcrumbs.
    const longTitled = roles.find((role) => role.name === 'release-readiness-and-handoff-review')
    expect(
      (longTitled && 'instructions' in longTitled ? longTitled.instructions : '').split('\n')[0]
        .length,
    ).toBeGreaterThan(60)
    expect(roles.filter((role) => role.name === 'shared-reviewer')).toHaveLength(2)
    // One role in three V18 states: a Space base narrowed to two of the Space's projects,
    // its own version in one of them, and a version whose base never existed.
    expect(roles).toContainEqual(
      expect.objectContaining({
        name: 'launch-review',
        target: { kind: 'space', space: 'product' },
        availability: {
          mode: 'selected-projects',
          projects: [
            { space: 'product', path: 'web' },
            { space: 'product', path: 'api' },
          ],
        },
      }),
    )
    expect(roles).toContainEqual(
      expect.objectContaining({
        name: 'launch-review',
        target: { kind: 'project', space: 'product', path: 'web' },
      }),
    )
    expect(roles).toContainEqual(
      expect.objectContaining({
        name: 'legacy-triage',
        target: { kind: 'project', space: 'product', path: 'legacy' },
      }),
    )
    // The Space skill fleet answers reach three different ways, so the editor's
    // project list is exercised at all / one / several and not only at "all".
    expect(
      new Set(
        skills
          .filter((skill) => skill.name.startsWith('team-'))
          .map((skill) =>
            skill.availability?.mode === 'selected-projects'
              ? skill.availability.projects.length
              : 0,
          ),
      ),
    ).toEqual(new Set([0, 1, 3]))
    // The two attachment states no other case reaches: a role attached where a skill
    // belongs, and a Space role reaching the whole Space through a skill bound to one
    // project.
    expect(roles).toContainEqual(
      expect.objectContaining({ name: 'evidence-lead', attachRole: 'release-reviewer' }),
    )
    expect(skills).toContainEqual(
      expect.objectContaining({
        name: 'store-review',
        linkedRole: 'handoff-review',
        home: { kind: 'space', space: 'product' },
        availability: {
          mode: 'selected-projects',
          projects: [{ space: 'product', path: 'mobile' }],
        },
      }),
    )
    expect(
      roles.some(
        (role) =>
          role.name === 'handoff-review' && role.target.kind === 'space' && !role.availability,
      ),
    ).toBe(true)
    expect(skills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'markdown-package-proof',
          packageFiles: [expect.objectContaining({ path: 'references/checklist.md' })],
        }),
        expect.objectContaining({
          name: 'asset-package-proof',
          packageFiles: [expect.objectContaining({ path: 'assets/template.bin' })],
        }),
      ]),
    )
    // Enable/Disable at all three sources the facet can carry, with the disabled
    // Personal `shared-reviewer` leaving its Space twin enabled — the override is a
    // property of the package, never of the name.
    expect(world.agentAbilityPreferences).toEqual([
      {
        user: 'sergey',
        ability: {
          source: 'owned',
          kind: 'role',
          name: 'shared-reviewer',
          target: { kind: 'personal', user: 'sergey' },
        },
        enabled: false,
      },
      {
        user: 'sergey',
        ability: {
          source: 'owned',
          kind: 'skill',
          name: 'evidence-index',
          home: { kind: 'personal', user: 'sergey' },
        },
        enabled: false,
      },
      {
        user: 'sergey',
        ability: { source: 'system', kind: 'skill', name: 'research-evidence' },
        enabled: false,
      },
    ])

    // A catalog Add on a PROJECT placement, and the supporting package it installs in
    // the SPACE addressed as what it is: the only declaration shape that has to name a
    // role placement and a skill home separately. Both applier branches behind it were
    // dead until this pair existed (#309 review).
    expect(roles).toContainEqual({
      name: 'grooming',
      target: { kind: 'project', space: 'product', path: 'mobile' },
    })
    expect(skills).toContainEqual({
      source: 'role-dependency',
      role: 'grooming',
      name: 'grooming-evidence',
      home: { kind: 'space', space: 'product' },
      roleTarget: { kind: 'project', space: 'product', path: 'mobile' },
      renameTo: 'grooming-evidence-house',
    })
    // The same pair where the space is the owner's PERSONAL one (`main` is
    // `personalFor: 'sergey'`), which is a different answer rather than a repetition:
    // Personal is that space's root, so the dependency's home is `personal` and the
    // role's link has to say so. Without this state no seeded stand held a role with a
    // dependency in a project of a personal space, and a seeder that answered "no
    // personal space" published a link nothing could resolve while the seed reported ok.
    expect(roles).toContainEqual({
      name: 'grooming',
      target: { kind: 'project', space: 'main', path: '' },
    })
    expect(skills).toContainEqual({
      source: 'role-dependency',
      role: 'grooming',
      name: 'grooming-evidence',
      home: { kind: 'personal', user: 'sergey' },
      roleTarget: { kind: 'project', space: 'main', path: '' },
      renameTo: 'grooming-evidence-mine',
    })
    expect(world.spaces.find((space) => space.slug === 'main')?.personalFor).toBe('sergey')

    const fixture = caseToFixture(world)
    expect(fixture.agentRoles).toEqual(world.agentRoles)
    expect(fixture.agentSkills).toEqual(world.agentSkills)
    // The preference channel the fake gained with #309. Without it the fixture would
    // reach the fake backend one field short, and a browser gate could only ever start
    // from an all-enabled inventory.
    expect(fixture.agentAbilityPreferences).toEqual(world.agentAbilityPreferences)
  })

  it('agent-abilities-sparse keeps a first-run stand at exactly one owned package', () => {
    const world = buildCaseWorld('agent-abilities-sparse', { now: DEFAULT_NOW })

    // No Owned role at all, one Owned skill, and no preference row: the empty group,
    // the single-row group and the default-enabled inventory a full stand hides.
    expect(world.agentRoles).toBeUndefined()
    expect(world.agentSkills).toEqual([
      expect.objectContaining({
        name: 'evidence-check',
        home: { kind: 'personal', user: 'sergey' },
      }),
    ])
    expect(world.agentAbilityPreferences).toBeUndefined()
    expect(world.agentSessions).toBeUndefined()
    expect(
      world.events.some((event) => event.op === 'create' && event.class === 'agent-memory'),
    ).toBe(false)
    // Two spaces with one project each, so an empty group still has a place to be.
    expect(world.projects?.map((project) => `${project.space}/${project.path}`)).toEqual([
      'main/',
      'product/',
    ])
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

  // The jobs clause above is one field's version of a rule that holds for the whole
  // world, and stating it per field is how a field ends up with no clause at all:
  // `agentSkills` shipped declared (`types.ts`), applied (`scripts/seed.ts`) and read
  // (`toFixture.ts`) while `mergeWorlds` never carried it, so every combination
  // dropped the skill fleet silently. These two clauses are the general form — the
  // FIELD LIST is exhaustive by type, so a new world field cannot be added without
  // landing under them.
  const WORLD_FIELDS = {
    now: true,
    spaces: true,
    projects: true,
    contextSets: true,
    scopePins: true,
    contextOrder: true,
    auth: true,
    events: true,
    favorites: true,
    retrievals: true,
    agentSessions: true,
    agentRoles: true,
    agentSkills: true,
    agentAbilityPreferences: true,
    agentDeltaCursors: true,
    jobs: true,
    durableImports: true,
    externalRewrites: true,
    revisionStates: true,
    externalIdentityClaims: true,
    externalSources: true,
  } as const satisfies Record<keyof CaseWorld, true>

  const WORLD_FIELD_NAMES = Object.keys(WORLD_FIELDS) as Array<keyof CaseWorld>

  /** How much of a field survived. A merge cannot be judged by deep equality — half
   *  the fields are namespaced by case on the way through — but it can be judged by
   *  how many declarations came out: an absent field and a dropped row both count. */
  const sizeOf = (value: unknown): number =>
    Array.isArray(value) ? value.length : value == null ? 0 : 1

  it('mergeWorlds carries EVERY declared world field, not the ones someone remembered', () => {
    // A partner that declares nothing but its own space: whatever a case brought must
    // then come out whole, field by field, with no per-field expectation to forget.
    const probe: CaseWorld = { now: DEFAULT_NOW, spaces: [{ slug: 'merge-probe' }], events: [] }

    for (const name of NAMES) {
      const world = buildCaseWorld(name, { scale: 0.1, now: DEFAULT_NOW })
      const merged = mergeWorlds([
        { name, world },
        { name: 'merge-probe', world: probe },
      ])

      // The anchor is the first part's by contract; everything else is additive.
      expect(merged.now).toBe(world.now)
      for (const field of WORLD_FIELD_NAMES.filter((candidate) => candidate !== 'now')) {
        expect({ [`${name}.${field}`]: sizeOf(merged[field]) }).toEqual({
          [`${name}.${field}`]: sizeOf(world[field]) + sizeOf(probe[field]),
        })
      }
    }
  })

  it('every world field is declared by some case, so the merge clause above can see it', () => {
    // Without this, a field nothing declares makes the clause above vacuous for it —
    // exactly the hole `agentSkills` fell through between being declarable and being
    // merged. A new field arrives with a case that seeds it, or it arrives red.
    const declared = new Set<keyof CaseWorld>()

    for (const name of NAMES) {
      const world = buildCaseWorld(name, { scale: 0.1, now: DEFAULT_NOW })

      for (const field of WORLD_FIELD_NAMES) {
        if (sizeOf(world[field])) {
          declared.add(field)
        }
      }
    }

    expect([...WORLD_FIELD_NAMES].filter((field) => !declared.has(field))).toEqual([])
  })

  it('combining cases namespaces external-rewrite note handles (#267)', () => {
    const combined = buildCasesWorld('external-edits,trash-mixed', { now: DEFAULT_NOW })
    const rewrite = combined.externalRewrites?.[0]
    expect(rewrite?.note).toBe('external-edits:n-3')
    expect(combined.events.some((e) => e.noteId === rewrite?.note)).toBe(true)
  })

  it('declares a complete CRLF storage form for byte-preserving save checks', () => {
    const world = buildCaseWorld('external-edits', { now: DEFAULT_NOW })
    const source = world.externalSources?.find((item) =>
      item.source.data.includes('CRLF preserved'),
    )

    expect(source?.source.data).toContain('title: "CRLF preserved"\r\n')
    expect(source?.source.data).toContain('tags:\r\n  - external\r\n  - crlf\r\n')
    expect(source?.source.data).toContain(
      'notarium-id: {{noteId}}\r\n---\r\n\r\n# CRLF preserved\r\n\r\n',
    )
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
