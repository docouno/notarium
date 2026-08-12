import {
  diffStats,
  effectiveSlug,
  frontmatterEntryOf,
  frontmatterEntryValue,
  nextAliasesMulti,
  normAliases,
  parseFrontmatterLines,
  slugify,
  stripFrontmatter,
  stripTitleHeading,
} from '@notarium/core'
import { deterministicNoteId, type NoteSnapshot } from '@notarium/engine-memory'
import { AGENT_SYSTEM_OWNER, type AgentSessionRecord } from '@notarium/server'
import type {
  ActivityFixture,
  AuthFixture,
  Fixture,
  ProjectFixture,
  SpaceFixture,
} from '../fake-server/app'
import { compareEvents, normDate } from './generators'
import { agentSessionId } from './sessionIds'
import type { CaseEvent, CaseWorld } from './types'

// The FAKE projection of a case (#175): reduce the neutral timeline to the fake
// backend's `Fixture` — a final note snapshot (live notes) + pre-dated activity
// rows (the journal history the dashboard reads). A note whose last op is
// `delete` is NOT in the snapshot (it has no live file); its tombstone lives only
// as an activity `deleted` row, which is exactly how the fake's trash (#79),
// keyed off the journal, surfaces it. This is the same shape the fake already
// models (snapshot for structure, activity for history) — the catalog just makes
// it declarative and shared with the real applier.

type NoteState = {
  space: string
  path: string
  title: string
  content: string
  tags?: string[]
  noteType?: string
  class?: string
  summary?: string
  muted?: boolean
  /** The author's own frontmatter, as bare YAML lines (#280). */
  frontmatter?: string
  /** Normalised custom slug derived from the author's carried `slug:`. */
  slug?: string
  createdAt: string
  modifiedAt: string
  deleted: boolean
  /** Former titles from renames — the fake resolver honours these as aliases (#100),
   *  so a `[[Old Title]]` still lands after a rename, matching the real applier (which
   *  appends the alias on the rename write). Without this the fake turned every renamed
   *  note's old title into an unintended ghost. */
  aliases: string[]
  /** A rename makes aliases a typed serializer output. Before that, source
   *  `aliases:` stays in the raw carry so its authored shape is preserved. */
  aliasesOwned: boolean
}

const carriedNames = (
  frontmatter: string | undefined,
): { aliases: string[]; slug: string | undefined } => {
  if (!frontmatter) {
    return { aliases: [], slug: undefined }
  }
  const entries = parseFrontmatterLines(frontmatter)
  const aliasesEntry = frontmatterEntryOf(entries, 'aliases')
  const slugEntry = frontmatterEntryOf(entries, 'slug')
  const slugValue = slugEntry && frontmatterEntryValue(slugEntry)

  return {
    aliases: normAliases(aliasesEntry && frontmatterEntryValue(aliasesEntry)) ?? [],
    slug: (typeof slugValue === 'string' ? slugify(slugValue) : '') || undefined,
  }
}

const kindOf = (op: CaseEvent['op']): NonNullable<ActivityFixture['kind']> =>
  op === 'create'
    ? 'created'
    : op === 'delete'
      ? 'deleted'
      : op === 'restore'
        ? 'restored'
        : 'edited'

/** The body AS THE JOURNAL STORES IT. A live write journals the NORMALISED note —
 *  `stripTitleHeading(stripFrontmatter(content))` (writeEngine.normalizedInput) —
 *  not the storage form. The catalog authors the storage form (a leading `# Title`
 *  is conventional there), so projecting it verbatim inflated every seeded blob and
 *  every churn count by the length of the H1 line: a create the real stand stamps
 *  at +1029 was published as +1052. Normalise with the title THIS revision carried,
 *  which for the `before` side is the chain parent's title — stripping a renamed
 *  note's new title off its old body would leave the old heading in the diff. */
const journalBody = (content: string, title: string): string =>
  stripTitleHeading(stripFrontmatter(content), title)

/** Per-revision churn, matching what the REAL journal stamps for the same op, so
 *  the fake and the real stand report the same numbers.
 *
 *  A tombstone is the special case: the journal does NOT diff a delete — it
 *  short-circuits to `charsAdded: 0, charsRemoved: <the body it removed>`
 *  (revisionJournal.stampStats). Diffing the body against itself here (which is
 *  what the note's state still holds at a delete) would report ±0 and print an
 *  untrue "nothing changed" beside a row that removed the whole note.
 *
 *  `diffStats` returns null past its input cap — the row then carries no counters,
 *  which is the honest answer, not a zero. */
const churn = (
  op: CaseEvent['op'],
  before: string,
  after: string,
): { charsAdded?: number; charsRemoved?: number } => {
  if (op === 'delete') {
    return { charsAdded: 0, charsRemoved: before.length }
  }
  const stats = diffStats(before, after)

  return stats ? { charsAdded: stats.charsAdded, charsRemoved: stats.charsRemoved } : {}
}

export const caseToFixture = (world: CaseWorld): Fixture => {
  const sorted = [...world.events].sort(compareEvents)

  // Fold the timeline into per-note final state + per-space activity rows.
  const notes = new Map<string, NoteState>()
  const activityBySpace = new Map<string, ActivityFixture[]>()

  for (const e of sorted) {
    const cur = notes.get(e.noteId)
    // The body this revision REPLACES, in journal form — the chain parent's
    // normalised content, which is what the churn counters are measured against
    // (`create` has no parent, so ''). Normalised with the PARENT's title, before
    // any rename this event carries is applied below.
    const before = cur ? journalBody(cur.content, cur.title) : ''

    if (e.op === 'create') {
      const names = carriedNames(e.frontmatter)
      notes.set(e.noteId, {
        space: e.space,
        path: e.path,
        title: e.title,
        content: e.content,
        tags: e.tags,
        noteType: e.noteType,
        class: e.class && e.class !== 'user-doc' ? e.class : undefined,
        summary: e.summary,
        muted: e.muted,
        frontmatter: e.frontmatter,
        slug: names.slug,
        createdAt: normDate(e.date),
        modifiedAt: normDate(e.date),
        deleted: false,
        aliases: names.aliases,
        aliasesOwned: false,
      })
    } else if (cur) {
      if (e.op === 'edit') {
        if (e.content !== undefined) {
          cur.content = e.content
        }
        if (e.title !== undefined && e.title !== cur.title) {
          // Start from aliases the imported file itself supplied. The real seed
          // applier reads those from the file before computing rename history;
          // dropping them here made the same catalog resolve differently in e2e.
          const previousSlug = effectiveSlug(cur.slug, cur.title)
          const nextSlug = effectiveSlug(cur.slug, e.title)
          cur.aliases = nextAliasesMulti(
            cur.aliases,
            [cur.title, previousSlug],
            [e.title, nextSlug],
          )
          cur.aliasesOwned = true
          cur.title = e.title
        }
        if (e.tags !== undefined) {
          cur.tags = e.tags
        }
      }
      cur.deleted = e.op === 'delete'
      cur.modifiedAt = normDate(e.date)
    }
    const title = cur?.title ?? (e.op === 'create' ? e.title : e.noteId)
    const state = notes.get(e.noteId)
    const cls = state?.class
    const rows = activityBySpace.get(e.space) ?? []
    rows.push({
      date: normDate(e.date),
      kind: kindOf(e.op),
      title,
      // Stamp the row with the id the in-memory store WILL derive for this note's
      // path, not the catalog's logical handle. A journal row is only history OF a
      // note if it carries the note's id: with the logical handle the rows still
      // aggregate (the heatmap and the feed read them in bulk), but every per-note
      // lookup — the history panel above all — comes back empty on a world that
      // demonstrably has revisions. Paths are unique per space by construction
      // here (mergeWorlds suffixes collisions), so the pre-suffix form the store
      // derives is the one it keeps.
      noteId: state ? deterministicNoteId(state.path) : e.noteId,
      class: cls,
      principal: e.principal,
      // The body as of this revision IN JOURNAL FORM, so the seeded chain is
      // READABLE (the history panel's revision view, the Changes diff, and — for a
      // tombstone — undelete, which needs the last known body) and byte-comparable
      // with what a live write would have stored. A `delete` row carries the body
      // the note had when it died, exactly like the real applier's tombstone.
      content: state ? journalBody(state.content, state.title) : undefined,
      // Churn stamped the way the journal stamps it for this op, so the "+N −M" on
      // the feed is a measurement rather than a decoration.
      ...churn(e.op, before, state ? journalBody(state.content, state.title) : ''),
      // A row the settlement quarantined: the fake serves it with the drivers'
      // effective-field semantics, so the stand shows a real gap rather than a
      // drawing of one.
      ...(e.op === 'edit' && e.unavailable ? { unavailable: true } : {}),
    })
    activityBySpace.set(e.space, rows)
  }

  // A real seed performs these replacements directly on disk after replay. The
  // fake has no filesystem seam, but it can still project the same final content.
  // External rewrites intentionally add no authored activity row.
  for (const rewrite of world.externalRewrites ?? []) {
    const note = notes.get(rewrite.note)

    if (!note) {
      throw new Error(`external rewrite references unknown note ${rewrite.note}`)
    }
    for (const { from, to } of rewrite.replacements) {
      if (Buffer.byteLength(from, 'utf8') !== Buffer.byteLength(to, 'utf8')) {
        throw new Error(`external rewrite changes byte length for note ${rewrite.note}`)
      }
      const parts = note.content.split(from)

      if (parts.length !== 2) {
        throw new Error(
          `external rewrite expected one occurrence of "${from}" in note ${rewrite.note}`,
        )
      }
      note.content = `${parts[0]}${to}${parts[1]}`
    }
  }

  // A cross-space id collision (#327) is deliberately NOT projected: the fake has
  // no arbiter, so it can only show the CONVERGED end state — two notes with two
  // distinct ids, which is exactly what the fixture already carries. Only the real
  // stand can plant the collision and prove the repair.
  for (const claim of world.externalIdentityClaims ?? []) {
    for (const handle of [claim.note, claim.claimFrom]) {
      if (!notes.has(handle)) {
        throw new Error(`external identity claim references unknown note ${handle}`)
      }
    }
  }

  // NB `SpaceDecl.archived` (#110) is NOT projected: the fake's SpaceFixture has no
  // archived field, so an archived space seeds LIVE here — space-archive is a real-stand
  // concern (the real applier calls manager.archive), verified live. See docs/seeds.md.
  const spaces: SpaceFixture[] = world.spaces.map((s) => {
    const live: NoteSnapshot[] = [...notes.values()]
      .filter((n) => n.space === s.slug && !n.deleted)
      .map((n) => ({
        title: n.title,
        filePath: n.path,
        content: n.content,
        tags: n.tags,
        noteType: n.noteType,
        class: n.class as NoteSnapshot['class'],
        summary: n.summary,
        muted: n.muted,
        frontmatter: n.frontmatter,
        aliases: n.aliasesOwned ? n.aliases : undefined,
        createdAt: n.createdAt,
        modifiedAt: n.modifiedAt,
      }))
    return {
      slug: s.slug,
      displayName: s.displayName,
      aliases: s.aliases,
      notes: live,
      activity: activityBySpace.get(s.slug),
    }
  })

  const projects: ProjectFixture[] | undefined = world.projects?.map((p) => ({
    space: p.space,
    path: p.path,
    slug: p.slug,
    displayName: p.displayName,
    status: p.status,
  }))

  // NB `world.contextSets` AND `world.scopePins` (#209) are NOT projected: the fixture's
  // note snapshots carry no stable ids to reference (the engine mints them on load), so
  // a set's item refs / a loose cross-space pin can't be resolved here. Like space-archive,
  // context-set + scope-pin seeding is a real-stand concern (scripts/seed.ts, which has the
  // logical→real id map); the fake e2e drives both surfaces through their REST API instead.
  // See docs/seeds.md.

  const personalSpaceByUser = new Map(
    world.spaces.flatMap((space) => (space.personalFor ? [[space.personalFor, space.slug]] : [])),
  )
  const auth: AuthFixture | undefined = world.auth
    ? {
        users: world.auth.users.map((u) => ({
          username: u.username,
          password: u.password,
          displayName: u.displayName,
          admin: u.admin,
          personalSpace: u.personalSpace ?? personalSpaceByUser.get(u.username),
        })),
        members: world.auth.members,
      }
    : undefined

  const now = Date.parse(world.now)
  const defaultOwner = world.auth?.users[0]?.username ?? AGENT_SYSTEM_OWNER
  const agentSessions: AgentSessionRecord[] | undefined = world.agentSessions
    ?.filter((session) => session.retained !== false)
    .map((session) => ({
      id: agentSessionId(session.ref),
      owner: session.owner ?? defaultOwner,
      name: session.name,
      named: session.named ?? true,
      parentId:
        session.parentRef &&
        world.agentSessions?.find((candidate) => candidate.ref === session.parentRef)?.retained !==
          false
          ? agentSessionId(session.parentRef)
          : null,
      createdAt: new Date(now - session.createdDaysAgo * 86_400_000).toISOString(),
      lastSeenAt: new Date(now - session.lastSeenDaysAgo * 86_400_000).toISOString(),
      calls: session.calls,
      role: session.role ?? null,
    }))

  return { now: world.now, spaces, projects, auth, agentSessions, agentRoles: world.agentRoles }
}
