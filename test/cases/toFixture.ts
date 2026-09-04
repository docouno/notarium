import {
  type AgentWriteAttribution,
  DEFAULT_NOTE_TYPE,
  diffStats,
  effectiveSlug,
  type FrontmatterEntry,
  frontmatterEntryOf,
  frontmatterEntryValue,
  frontmatterListEntry,
  frontmatterScalarEntry,
  legacyNoteNameAlias,
  logicalNoteState,
  nextAliasesMulti,
  normAliases,
  normalizeAuthoredDate,
  parseFrontmatterLines,
  slugify,
  stripFrontmatter,
  stripTitleHeading,
  unionLegacyNameAliases,
} from '@notarium/core'
import { deterministicNoteId, type NoteSnapshot } from '@notarium/engine-memory'
import { AGENT_SYSTEM_OWNER, type AgentCallRecord, type AgentSessionRecord } from '@notarium/server'
import { TRACE_TOOL_POLICY } from '../../packages/server/src/services/agentCalls/traceProjectors'
import type {
  ActivityFixture,
  AuthFixture,
  Fixture,
  ProjectFixture,
  SpaceFixture,
} from '../fake-server/app'
import { compareEvents, normDate } from './generators'
import { materializeRevisionState } from './revisionStates'
import { agentCallId, agentSessionId } from './sessionIds'
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
  /** Stable physical identity, pinned by the case or derived once from the
   *  create path. Every projection below reads this value; path edits never
   *  re-derive it. */
  id: string
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
  sourceLocator?: string
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
  legacyNameAliases: readonly string[]
}

const observeLegacyName = (state: NoteState): void => {
  const alias = legacyNoteNameAlias(state.title, state.path)

  if (alias) {
    state.legacyNameAliases = unionLegacyNameAliases(state.legacyNameAliases, [alias])
  }
}

const projectMemoryPath = (world: CaseWorld, event: Extract<CaseEvent, { op: 'create' }>) => {
  if (!event.projectMemory) {
    return event.path
  }
  const project = world.projects?.find(
    (candidate) =>
      candidate.space === event.projectMemory!.space &&
      candidate.path === event.projectMemory!.path,
  )

  if (!project || event.space !== project.space) {
    throw new Error(
      `project memory references an unknown project: ${event.projectMemory.space}/${event.projectMemory.path}`,
    )
  }
  if (event.class !== 'agent-memory' || !event.path.startsWith('.notarium/memory/')) {
    throw new Error(`project memory note must use the agent-memory mount: ${event.path}`)
  }
  const lastSegment = project.path.replace(/\/+$/, '').split('/').pop()
  const slug = project.slug || lastSegment || project.space
  const projectId = `proj-${project.space}-${slug}`

  return event.path.replace('.notarium/memory/', `.notarium/memory/${projectId}/`)
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

const mergeFrontmatter = (existing: string | undefined, incoming: string): string => {
  const entries = parseFrontmatterLines(existing ?? '')
  const incomingEntries = parseFrontmatterLines(incoming)
  const keyed = new Map<string, FrontmatterEntry>()

  for (const entry of incomingEntries) {
    if (entry.key) {
      keyed.set(entry.key, entry)
    }
  }
  const placed = new Set<string>()
  const existingKeyless = new Set(
    entries.filter((entry) => !entry.key).map((entry) => entry.lines[0]),
  )
  const merged: FrontmatterEntry[] = incomingEntries
    .filter((entry) => !entry.key && !existingKeyless.has(entry.lines[0]))
    .map((entry) => ({ key: entry.key, lines: [...entry.lines] }))

  for (const entry of entries) {
    if (entry.key && keyed.has(entry.key)) {
      if (!placed.has(entry.key)) {
        const replacement = keyed.get(entry.key)!
        merged.push({ key: replacement.key, lines: [...replacement.lines] })
        placed.add(entry.key)
      }
    } else {
      merged.push({ key: entry.key, lines: [...entry.lines] })
    }
  }
  for (const entry of incomingEntries) {
    if (entry.key && !placed.has(entry.key)) {
      merged.push({ key: entry.key, lines: [...entry.lines] })
      placed.add(entry.key)
    }
  }

  return merged.flatMap((entry) => entry.lines).join('\n')
}

/** Reconstruct the same authored frontmatter the fake store will expose after
 * typed serializer channels win over imported/raw entries. */
const stateFrontmatter = (state: NoteState): FrontmatterEntry[] => {
  const entries = parseFrontmatterLines(state.frontmatter ?? '').map((entry) => ({
    key: entry.key,
    lines: [...entry.lines],
  }))
  const positions = (key: string) =>
    entries.flatMap((entry, index) => (entry.key === key ? [index] : []))

  const drop = (key: string) => {
    for (const index of positions(key).reverse()) {
      entries.splice(index, 1)
    }
  }

  const put = (entry: FrontmatterEntry) => {
    const indexes = positions(entry.key!)

    if (!indexes.length) {
      entries.push(entry)
      return
    }
    entries[indexes[0]] = entry
    for (const index of indexes.slice(1).reverse()) {
      entries.splice(index, 1)
    }
  }

  if (state.noteType !== undefined) {
    if (state.noteType && state.noteType !== DEFAULT_NOTE_TYPE) {
      put(frontmatterScalarEntry('type', state.noteType))
    } else {
      drop('type')
    }
  }
  if (state.tags !== undefined) {
    if (state.tags.length) {
      put(frontmatterListEntry('tags', state.tags))
    } else {
      drop('tags')
    }
  }
  if (state.aliasesOwned) {
    if (state.aliases.length) {
      put(frontmatterListEntry('aliases', state.aliases))
    } else {
      drop('aliases')
    }
  }
  if (state.summary !== undefined) {
    if (state.summary) {
      put(frontmatterScalarEntry('summary', state.summary))
    } else {
      drop('summary')
    }
  }
  if (state.muted !== undefined) {
    if (state.muted) {
      put(frontmatterScalarEntry('muted', 'true'))
    } else {
      drop('muted')
    }
  }
  const authoredCreated = frontmatterEntryOf(entries, 'created')
  const authoredValue = authoredCreated && frontmatterEntryValue(authoredCreated)

  if (
    !authoredCreated ||
    (typeof authoredValue === 'string' && !Number.isNaN(Date.parse(authoredValue)))
  ) {
    put(frontmatterScalarEntry('created', state.createdAt))
  }

  return entries
}

const journalState = (state: NoteState): string =>
  logicalNoteState({
    title: state.title,
    body: journalBody(state.content, state.title),
    frontmatter: stateFrontmatter(state),
  }).markdown

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
  const defaultOwner = world.auth?.users[0]?.username ?? AGENT_SYSTEM_OWNER

  const agentAttributionOf = (event: CaseEvent): AgentWriteAttribution | undefined => {
    const audit = event.agentAudit

    if (!audit) {
      return undefined
    }
    const session = audit.sessionRef
      ? world.agentSessions?.find((candidate) => candidate.ref === audit.sessionRef)
      : undefined
    const call = audit.callRef
      ? world.agentCalls?.find((candidate) => candidate.ref === audit.callRef)
      : undefined

    if (audit.sessionRef && !session) {
      throw new Error(`agent write references unknown session: ${audit.sessionRef}`)
    }
    if (audit.callRef && !call) {
      throw new Error(`agent write references unknown call: ${audit.callRef}`)
    }
    const owner = audit.owner ?? session?.owner ?? defaultOwner

    if (audit.owner && session?.owner && audit.owner !== session.owner) {
      throw new Error(`agent write owner does not match session: ${audit.sessionRef}`)
    }

    return {
      owner,
      agent: audit.agent ?? null,
      ...(audit.callRef ? { agentCallId: agentCallId(audit.callRef) } : {}),
      ...(session && audit.sessionRef
        ? {
            session: {
              id: agentSessionId(audit.sessionRef),
              name: session.name,
              attach: audit.sessionAttach ?? ('declared' as const),
            },
          }
        : {}),
    }
  }

  // Fold the timeline into per-note final state + per-space activity rows.
  const notes = new Map<string, NoteState>()
  const activityBySpace = new Map<string, ActivityFixture[]>()

  for (const e of sorted) {
    const cur = notes.get(e.noteId)
    const previousModifiedAt = cur?.modifiedAt
    // The body this revision REPLACES, in journal form — the chain parent's
    // normalised content, which is what the churn counters are measured against
    // (`create` has no parent, so ''). Normalised with the PARENT's title, before
    // any rename this event carries is applied below.
    const before = cur ? journalState(cur) : ''

    if (e.op === 'create') {
      const names = carriedNames(e.frontmatter)
      const state: NoteState = {
        id: e.physicalId ?? deterministicNoteId(e.path),
        space: e.space,
        path: projectMemoryPath(world, e),
        title: e.title,
        content: e.content,
        tags: e.pin ? [...(e.tags ?? []), 'always-load'] : e.tags,
        noteType: e.noteType,
        class: e.class && e.class !== 'user-doc' ? e.class : undefined,
        summary: e.summary,
        muted: e.muted,
        frontmatter: e.frontmatter,
        sourceLocator: e.sourceLocator,
        slug: names.slug,
        createdAt: normDate(e.date),
        modifiedAt: normDate(e.date),
        deleted: false,
        aliases: names.aliases,
        aliasesOwned: false,
        legacyNameAliases: [],
      }

      observeLegacyName(state)
      notes.set(e.noteId, state)
    } else if (cur) {
      if (e.op === 'edit') {
        observeLegacyName(cur)
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
        if (e.path !== undefined) {
          cur.path = e.path
        }
        if (e.tags !== undefined) {
          cur.tags = e.tags
        }
        if (e.frontmatter !== undefined) {
          const patchedKeys = new Set(
            parseFrontmatterLines(e.frontmatter).flatMap((entry) => (entry.key ? [entry.key] : [])),
          )
          cur.frontmatter = mergeFrontmatter(cur.frontmatter, e.frontmatter)
          const names = carriedNames(cur.frontmatter)
          cur.slug = names.slug
          if (patchedKeys.has('aliases')) {
            cur.aliasesOwned = false
          }
          if (!cur.aliasesOwned) {
            cur.aliases = names.aliases
          }
          // Raw metadata owns these keys on the real replay path. Clear any
          // older explicit fixture projection so InMemoryStore derives the new
          // typed view from the merged authored entry instead of overwriting it.
          if (patchedKeys.has('tags') && e.tags === undefined) {
            cur.tags = undefined
          }
          if (patchedKeys.has('type')) {
            cur.noteType = undefined
          }
          if (patchedKeys.has('summary')) {
            cur.summary = undefined
          }
          if (patchedKeys.has('muted')) {
            cur.muted = undefined
          }
        }
        observeLegacyName(cur)
      }
      cur.deleted = e.op === 'delete'
      cur.modifiedAt = normDate(e.date)
    }
    const title = cur?.title ?? (e.op === 'create' ? e.title : e.noteId)
    const state = notes.get(e.noteId)

    if (e.op === 'edit' && state && before === journalState(state)) {
      if (previousModifiedAt) {
        state.modifiedAt = previousModifiedAt
      }
      continue
    }
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
      noteId: state?.id ?? e.noteId,
      class: cls,
      principal: e.principal,
      // The body as of this revision IN JOURNAL FORM, so the seeded chain is
      // READABLE (the history panel's revision view, the Changes diff, and — for a
      // tombstone — undelete, which needs the last known body) and byte-comparable
      // with what a live write would have stored. A `delete` row carries the body
      // the note had when it died, exactly like the real applier's tombstone.
      content: state ? journalBody(state.content, state.title) : undefined,
      snapshot: state ? journalState(state) : undefined,
      // Churn stamped the way the journal stamps it for this op, so the "+N −M" on
      // the feed is a measurement rather than a decoration.
      ...churn(e.op, before, state ? journalState(state) : ''),
      // A row the settlement quarantined: the fake serves it with the drivers'
      // effective-field semantics, so the stand shows a real gap rather than a
      // drawing of one.
      ...(e.op === 'edit' && e.unavailable ? { unavailable: true } : {}),
      ...(e.agentAudit ? { agent: agentAttributionOf(e) } : {}),
    })
    activityBySpace.set(e.space, rows)
  }

  for (const declaration of world.revisionStates ?? []) {
    const state = notes.get(declaration.note)

    if (!state) {
      throw new Error(`revision state references unknown note ${declaration.note}`)
    }
    const noteId = state.id
    const materialized = materializeRevisionState(declaration, {
      noteId,
      path: state.path,
      createdAt: state.createdAt,
      title: state.title,
    })
    const rows = activityBySpace.get(state.space) ?? []
    const blob = materialized.blob

    rows.push({
      date: normDate(declaration.date),
      kind: declaration.kind === 'delete' ? 'deleted' : 'edited',
      title: materialized.title,
      noteId,
      class: state.class,
      principal: declaration.principal,
      ...(materialized.content != null ? { content: materialized.content } : {}),
      ...(blob != null
        ? {
            stateBlobBase64: Buffer.from(
              typeof blob === 'string' ? new TextEncoder().encode(blob) : blob,
            ).toString('base64'),
          }
        : {}),
      stateFormat: materialized.stateFormat,
      restoreSafety: materialized.restoreSafety,
      semanticFingerprint: materialized.semanticFingerprint,
    })
    activityBySpace.set(state.space, rows)
  }

  // A real seed performs these replacements directly on disk after replay. The
  // fake has no filesystem seam, but it can still project the same final content.
  // External rewrites intentionally add no authored activity row.
  for (const rewrite of world.externalRewrites ?? []) {
    const note = notes.get(rewrite.note)

    if (!note) {
      throw new Error(`external rewrite references unknown note ${rewrite.note}`)
    }
    let projected = rewrite.projection === 'createdAt' ? note.createdAt : note.content

    for (const { from, to } of rewrite.replacements) {
      if (Buffer.byteLength(from, 'utf8') !== Buffer.byteLength(to, 'utf8')) {
        throw new Error(`external rewrite changes byte length for note ${rewrite.note}`)
      }
      const parts = projected.split(from)

      if (parts.length !== 2) {
        throw new Error(
          `external rewrite expected one occurrence of "${from}" in ` +
            `${rewrite.projection ?? 'content'} for note ${rewrite.note}`,
        )
      }
      projected = `${parts[0]}${to}${parts[1]}`
    }
    if (rewrite.projection === 'createdAt') {
      const createdAt = normalizeAuthoredDate(projected)

      if (!createdAt) {
        throw new Error(`external rewrite projects an invalid createdAt for note ${rewrite.note}`)
      }
      note.createdAt = createdAt
    } else {
      note.content = projected
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

  // Whole-file bytes are deliberately NOT projected either, and for a blunter reason than
  // the collision above: the fake HAS no files. An encoding prologue and a leading `---`
  // rule are byte facts, and the fixture is a specification of the note's normalized
  // state — so the stand shows these notes as their timeline left them. Only the real
  // applier can plant the shape and prove the engine's answer to it. See docs/seeds.md.
  for (const source of world.externalSources ?? []) {
    if (!notes.has(source.note)) {
      throw new Error(`external source references unknown note ${source.note}`)
    }
  }

  // Archive is projected too: provider resolution must retain an accepted row and
  // name `space-archived`, which cannot be proven by a fixture that silently serves
  // the target as live. createApp applies the real SpaceManager lifecycle after all
  // declarations have been seeded, matching the real applier's ordering.
  const spaces: SpaceFixture[] = world.spaces.map((s) => {
    const live: NoteSnapshot[] = [...notes.values()]
      .filter((n) => n.space === s.slug && !n.deleted)
      .map((n) => ({
        id: n.id,
        title: n.title,
        filePath: n.path,
        content: n.content,
        tags: n.tags,
        noteType: n.noteType,
        class: n.class as NoteSnapshot['class'],
        summary: n.summary,
        muted: n.muted,
        frontmatter: n.frontmatter,
        sourceLocator: n.sourceLocator,
        aliases: n.aliasesOwned ? n.aliases : undefined,
        legacyNameAliases: n.legacyNameAliases,
        createdAt: n.createdAt,
        modifiedAt: n.modifiedAt,
      }))
    return {
      slug: s.slug,
      displayName: s.displayName,
      aliases: s.aliases,
      archived: s.archived,
      notes: live,
      fieldSchema: s.fieldSchema,
      fieldSchemaRaw: s.fieldSchemaRaw,
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

  const contextNoteRefs = Object.fromEntries(
    [...notes.entries()].flatMap(([logicalId, note]) =>
      note.deleted ? [] : [[logicalId, { space: note.space, noteId: note.id }]],
    ),
  )

  const personalSpaceByUser = new Map(
    world.spaces.flatMap((space) => (space.personalFor ? [[space.personalFor, space.slug]] : [])),
  )
  const auth: AuthFixture | undefined = world.auth
    ? {
        users: world.auth.users.map((u) => ({
          username: u.username,
          email: u.email,
          password: u.password,
          displayName: u.displayName,
          admin: u.admin,
          disabled: u.disabled,
          personalSpace: u.personalSpace ?? personalSpaceByUser.get(u.username),
        })),
        members: world.auth.members,
      }
    : undefined

  const now = Date.parse(world.now)
  const agentSessions: AgentSessionRecord[] | undefined = world.agentSessions
    ?.filter((session) => session.retained !== false)
    .map((session) => {
      const project = session.project
        ? projects?.find(
            (candidate) =>
              candidate.space === session.project!.space &&
              candidate.path === session.project!.path,
          )
        : undefined
      const lastSegment = project?.path.replace(/\/+$/, '').split('/').pop()
      const projectSlug = project ? project.slug || lastSegment || project.space : undefined

      return {
        id: agentSessionId(session.ref),
        owner: session.owner ?? defaultOwner,
        name: session.name,
        named: session.named ?? true,
        parentId:
          session.parentRef &&
          world.agentSessions?.find((candidate) => candidate.ref === session.parentRef)
            ?.retained !== false
            ? agentSessionId(session.parentRef)
            : null,
        createdAt: new Date(now - session.createdDaysAgo * 86_400_000).toISOString(),
        lastSeenAt: new Date(now - session.lastSeenDaysAgo * 86_400_000).toISOString(),
        calls: session.calls,
        role: session.role ?? null,
        // A package id is minted when the package is published, which happens in the
        // applier rather than in this projection. The applier resolves the exact locator
        // from `role` once the packages exist, the way the real seeder does.
        roleLocator: null,
        roleContextProjectId: null,
        projectId: project && projectSlug ? `proj-${project.space}-${projectSlug}` : null,
      }
    })
  const agentCalls: AgentCallRecord[] | undefined = world.agentTelemetryDetailed
    ? world.agentCalls?.map((call) => {
        const startedAt = new Date(now - call.daysAgo * 86_400_000).toISOString()
        const sessionDecl = call.sessionRef
          ? world.agentSessions?.find((candidate) => candidate.ref === call.sessionRef)
          : undefined
        const policy = Object.hasOwn(TRACE_TOOL_POLICY, call.tool)
          ? TRACE_TOOL_POLICY[call.tool as keyof typeof TRACE_TOOL_POLICY]
          : null

        if (policy && (call.effect !== policy.effect || call.domain !== policy.domain)) {
          throw new Error(
            `agent call ${call.ref} declares ${call.effect}/${call.domain}; ` +
              `${call.tool} emits ${policy.effect}/${policy.domain}`,
          )
        }

        return {
          id: agentCallId(call.ref),
          owner: call.owner ?? sessionDecl?.owner ?? defaultOwner,
          principal: call.principal,
          agent: call.agent ?? null,
          transport: 'mcp',
          requestId: null,
          sessionId: call.sessionRef ? agentSessionId(call.sessionRef) : null,
          sessionName: sessionDecl?.name ?? null,
          sessionAttach: call.sessionRef ? (call.sessionAttach ?? 'declared') : null,
          tool: call.tool,
          effect: policy?.effect ?? call.effect,
          domain: policy?.domain ?? call.domain,
          startedAt,
          finishedAt: new Date(Date.parse(startedAt) + (call.durationMs ?? 12)).toISOString(),
          durationMs: call.durationMs ?? 12,
          outcome: call.outcome,
          reasonCode: call.reasonCode ?? null,
          inputBytes: 0,
          outputBytes: 0,
          inputShape: [],
          issueSummary: call.issues ?? null,
          targetSummary: call.target ?? null,
          resultSummary: call.result ?? null,
          fingerprint: call.fingerprint ?? agentCallId(call.ref).slice(5),
          projectionVersion: 1,
          redacted: call.redacted ?? false,
          truncated: call.truncated ?? false,
          detailCaptureFailed: call.detailCaptureFailed ?? false,
        }
      })
    : undefined

  return {
    now: world.now,
    spaces,
    projects,
    auth,
    ...(world.providers
      ? {
          capabilities: { providers: world.providers.enabled },
          providers: world.providers,
          providerPrivateOrigins: world.providers.privateOrigins,
        }
      : {}),
    agentSessions,
    agentCalls,
    agentCleanupMarkers: world.agentCleanupMarkers?.map((marker) => {
      const session = world.agentSessions?.find((candidate) => candidate.ref === marker.sessionRef)
      return {
        owner: marker.owner ?? session?.owner ?? defaultOwner,
        sessionId: agentSessionId(marker.sessionRef),
        operations: marker.operations,
      }
    }),
    agentCallDetails: world.agentCalls?.flatMap((call) =>
      call.detailed ? [{ id: agentCallId(call.ref), payload: call.detailed }] : [],
    ),
    agentTelemetryDetailed: world.agentTelemetryDetailed,
    agentRoles: world.agentRoles,
    agentRoleMoves: world.agentRoleMoves,
    agentSkills: world.agentSkills,
    contextSets: world.contextSets,
    scopePins: world.scopePins,
    contextOrder: world.contextOrder,
    contextNoteRefs,
    // Carried verbatim, like the package declarations beside it: a preference row
    // addresses a package by the NAME the case wrote and the placement it asked for,
    // and the exact id it resolves to is minted by the applier at publish time.
    agentAbilityPreferences: world.agentAbilityPreferences,
  }
}
