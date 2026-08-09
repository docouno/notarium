import type {
  AgentDeltaCursorDecl,
  AgentRoleDecl,
  AgentSessionDecl,
  AgentWriteAuditDecl,
  CaseEvent,
  CaseNoteClass,
  CaseWorld,
  ConnectedAppDecl,
  ContextOrderDecl,
  ContextSetDecl,
  DurableImportDecl,
  ExternalRewriteDecl,
  FavoriteDecl,
  JobDecl,
  MemberDecl,
  PendingOAuthClientDecl,
  ProjectDecl,
  RetrievalDecl,
  Rng,
  ScopePinDecl,
  SpaceDecl,
  UserDecl,
} from './types'

// Authoring helpers: deterministic content/date generation + a small WorldBuilder
// so a case reads as a declaration ("this note, created then, edited these days,
// deleted here") while emitting the neutral timeline both appliers consume.

const WORDS = [
  'context',
  'engine',
  'journal',
  'revision',
  'space',
  'project',
  'folder',
  'note',
  'index',
  'search',
  'graph',
  'heatmap',
  'activity',
  'trash',
  'memory',
  'import',
  'snapshot',
  'baseline',
  'timeline',
  'cursor',
  'delta',
  'identity',
  'marker',
  'mount',
  'schema',
  'migration',
  'vector',
  'embedding',
  'fixture',
  'catalog',
  'applier',
  'stand',
]

/** Topic/tag banks for readable generated titles. */
export const TOPICS = [
  'Design',
  'Runbook',
  'Decision',
  'Metrics',
  'Retro',
  'Spec',
  'Research',
  'Incident',
  'Onboarding',
  'Roadmap',
  'Review',
  'Meeting',
  'Idea',
  'Draft',
  'Reference',
  'Journal',
]
export const TAGS = [
  'product',
  'infra',
  'design',
  'ops',
  'research',
  'idea',
  'draft',
  'review',
  'archive',
]

/** Capitalise the first letter. */
export const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

/** A short, deterministic paragraph — enough for a clean preview snippet. */
export const paragraph = (rng: Rng, sentences = 3): string => {
  const out: string[] = []

  for (let s = 0; s < sentences; s++) {
    const len = rng.int(6, 14)
    const words: string[] = []

    for (let i = 0; i < len; i++) {
      words.push(rng.pick(WORDS))
    }
    let sentence = words.join(' ')
    sentence = sentence.charAt(0).toUpperCase() + sentence.slice(1)
    out.push(`${sentence}.`)
  }

  return out.join(' ')
}

/** Storage-format body for a note: a conventional `# title` H1 (both engines
 *  normalise it away on read) + a short paragraph, optional trailing lines. */
export const noteBody = (title: string, rng: Rng, extra: string[] = []): string =>
  [`# ${title}`, '', paragraph(rng), ...extra].join('\n')

/** `n` days before the anchor, at `hour` UTC — an ISO instant, never in the
 *  future (a day-0 entry at a late hour is clamped just under `now`, so the
 *  "events are ≤ now" invariant holds for any anchor). */
export const daysBefore = (now: Date, days: number, hour = 10, minute = 0): string => {
  const d = new Date(now.getTime())
  d.setUTCDate(d.getUTCDate() - days)
  d.setUTCHours(hour, minute, 0, 0)
  if (d.getTime() > now.getTime()) {
    d.setTime(now.getTime() - 60_000)
  }

  return d.toISOString()
}

export type NoteDecl = {
  space: string
  path: string
  title: string
  content?: string
  tags?: string[]
  noteType?: string
  class?: CaseNoteClass
  summary?: string
  muted?: boolean
  pin?: boolean
  principal?: string
  /** Agent/session attribution copied to every authored lifecycle event. */
  agentAudit?: AgentWriteAuditDecl
  /** Frontmatter the note ARRIVED with, as bare YAML lines without the `---`
   *  fences (#280) — what an IMPORTED file carried and Notarium kept because it
   *  is the author's data, not ours (`author: Sergey\nmeta:\n  source: obsidian`).
   *  The two appliers reach it by their own routes — the REAL one through the
   *  production `WriteInput.frontmatter` channel, the FAKE one through
   *  `NoteSnapshot.frontmatter` → `InMemoryStore.load` (a fixture is a snapshot,
   *  not a replayed write). Both must land the SAME note, so a typed field derived
   *  from these keys has to be derived on both sides. canon: docs/seeds.md */
  frontmatter?: string
  /** When the note first appears through us (create). */
  created: string
  /** Later edit instants — each a chained `edited` revision. */
  edits?: string[]
  /** Tombstone instant (→ trash). */
  deletedAt?: string
  /** Un-delete instant (a later restore clears the tombstone). */
  restoredAt?: string
}

/** Accumulates a CaseWorld — spaces/projects/auth/timeline — as a case declares
 *  it. `note()` expands one note's lifecycle into chronological events. */
export class WorldBuilder {
  private readonly spaces: SpaceDecl[] = []
  private readonly projects: ProjectDecl[] = []
  private readonly contextSets: ContextSetDecl[] = []
  private readonly scopePins: ScopePinDecl[] = []
  private readonly contextOrder: ContextOrderDecl[] = []
  private readonly users: UserDecl[] = []
  private readonly members: MemberDecl[] = []
  private readonly connectedApps: ConnectedAppDecl[] = []
  private readonly pendingOAuthClients: PendingOAuthClientDecl[] = []
  private readonly favorites: FavoriteDecl[] = []
  private readonly retrievals: RetrievalDecl[] = []
  private readonly agentSessions: AgentSessionDecl[] = []
  private readonly agentRoles: AgentRoleDecl[] = []
  private readonly agentDeltaCursors: AgentDeltaCursorDecl[] = []
  private readonly jobs: JobDecl[] = []
  private readonly durableImports: DurableImportDecl[] = []
  private readonly externalRewrites: ExternalRewriteDecl[] = []
  private readonly events: CaseEvent[] = []
  private hasAuth = false
  private idSeq = 0

  constructor(private readonly now: Date) {}

  space(decl: SpaceDecl): this {
    this.spaces.push(decl)
    return this
  }

  project(decl: ProjectDecl): this {
    this.projects.push(decl)
    return this
  }

  /** Declare a context set (#209) referencing notes by their logical ids. */
  contextSet(decl: ContextSetDecl): this {
    this.contextSets.push(decl)
    return this
  }

  /** Pin a note (by logical id) directly into a scope (#209) — a loose cross-space pin. */
  scopePin(decl: ScopePinDecl): this {
    this.scopePins.push(decl)
    return this
  }

  /** Set a scope's user-defined pin+set order (#210) — order = load priority. */
  contextOrderFor(decl: ContextOrderDecl): this {
    this.contextOrder.push(decl)
    return this
  }

  user(decl: UserDecl): this {
    this.hasAuth = true
    this.users.push(decl)
    return this
  }

  member(decl: MemberDecl): this {
    this.hasAuth = true
    this.members.push(decl)
    return this
  }

  /** Declare a connected OAuth app (#181) the owner authorized — for the Connected
   *  apps settings (with narrowing). Requires auth (the app belongs to a user). */
  connectedApp(decl: ConnectedAppDecl): this {
    this.hasAuth = true
    this.connectedApps.push(decl)
    return this
  }

  /** Declare a not-yet-consented OAuth client in the pending registry. */
  pendingOAuthClient(decl: PendingOAuthClientDecl): this {
    this.hasAuth = true
    this.pendingOAuthClients.push(decl)
    return this
  }

  /** Declare a note and its lifecycle; returns its logical id. */
  note(decl: NoteDecl): string {
    this.idSeq += 1
    const noteId = `n-${this.idSeq.toString(36)}`
    const content = decl.content ?? noteBody(decl.title, this.fallbackRng())
    this.events.push({
      op: 'create',
      date: decl.created,
      space: decl.space,
      noteId,
      path: decl.path,
      title: decl.title,
      content,
      tags: decl.tags,
      noteType: decl.noteType,
      class: decl.class,
      summary: decl.summary,
      muted: decl.muted,
      pin: decl.pin,
      frontmatter: decl.frontmatter,
      principal: decl.principal,
      agentAudit: decl.agentAudit,
    })
    for (const [i, date] of (decl.edits ?? []).entries()) {
      this.events.push({
        op: 'edit',
        date,
        space: decl.space,
        noteId,
        content: [content, '', `_Edit ${i + 1}._`].join('\n'),
        principal: decl.principal,
        agentAudit: decl.agentAudit,
      })
    }
    if (decl.deletedAt) {
      this.events.push({
        op: 'delete',
        date: decl.deletedAt,
        space: decl.space,
        noteId,
        principal: decl.principal,
        agentAudit: decl.agentAudit,
      })
    }
    if (decl.restoredAt) {
      this.events.push({
        op: 'restore',
        date: decl.restoredAt,
        space: decl.space,
        noteId,
        principal: decl.principal,
        agentAudit: decl.agentAudit,
      })
    }

    return noteId
  }

  /** Push an already-built event (for generators that manage their own ids). */
  event(e: CaseEvent): this {
    this.events.push(e)
    return this
  }

  /** Star a note (by its logical id from `note()`), folder or project (by path) —
   *  the favorites lens (#42/#245). Real applier only (see FavoriteDecl). */
  favorite(decl: FavoriteDecl): this {
    this.favorites.push(decl)
    return this
  }

  /** Declare an agent-retrieval audit row (#243) — a search/recall/get_note the agent ran.
   *  `hits` reference notes by the logical id note() returned; empty = a zero-result miss.
   *  Real-applier only (a meta-DB side-channel). */
  retrieval(decl: RetrievalDecl): this {
    this.retrievals.push(decl)
    return this
  }

  /** Declare one durable agent episode. */
  agentSession(decl: AgentSessionDecl): this {
    this.agentSessions.push(decl)
    return this
  }

  /** Copy a built-in role into an owned personal or project library. */
  agentRole(decl: AgentRoleDecl): this {
    this.agentRoles.push(decl)
    return this
  }

  /** Declare an owner fallback or one episode's project delta position. */
  agentDeltaCursor(decl: AgentDeltaCursorDecl): this {
    this.agentDeltaCursors.push(decl)
    return this
  }

  /** Declare a durable job (#105) — an export's history row and, when it succeeded with
   *  a live TTL, a REAL archive written under `<DATA_DIR>/jobs` by the production handler
   *  (#101). Real applier only; see JobDecl. */
  job(decl: JobDecl): this {
    this.jobs.push(decl)
    return this
  }

  /** Declare a real staged import plus its stable, live retry row. */
  durableImport(decl: DurableImportDecl): this {
    this.durableImports.push(decl)
    return this
  }

  /** Rewrite a note behind the store's back after the timeline has replayed. */
  externalRewrite(decl: ExternalRewriteDecl): this {
    this.externalRewrites.push(decl)
    return this
  }

  build(): CaseWorld {
    return {
      now: this.now.toISOString(),
      spaces: this.spaces,
      projects: this.projects.length ? this.projects : undefined,
      contextSets: this.contextSets.length ? this.contextSets : undefined,
      scopePins: this.scopePins.length ? this.scopePins : undefined,
      contextOrder: this.contextOrder.length ? this.contextOrder : undefined,
      auth: this.hasAuth
        ? {
            users: this.users,
            members: this.members,
            ...(this.connectedApps.length ? { connectedApps: this.connectedApps } : {}),
            ...(this.pendingOAuthClients.length
              ? { pendingOAuthClients: this.pendingOAuthClients }
              : {}),
          }
        : undefined,
      events: [...this.events].sort(compareEvents),
      favorites: this.favorites.length ? this.favorites : undefined,
      ...(this.retrievals.length ? { retrievals: this.retrievals } : {}),
      ...(this.agentSessions.length ? { agentSessions: this.agentSessions } : {}),
      ...(this.agentRoles.length ? { agentRoles: this.agentRoles } : {}),
      ...(this.agentDeltaCursors.length ? { agentDeltaCursors: this.agentDeltaCursors } : {}),
      ...(this.jobs.length ? { jobs: this.jobs } : {}),
      ...(this.durableImports.length ? { durableImports: this.durableImports } : {}),
      ...(this.externalRewrites.length ? { externalRewrites: this.externalRewrites } : {}),
    }
  }

  // A deterministic body generator seeded off the note count — used only when a
  // note omits explicit content (keeps default bodies varied but reproducible).
  private fallbackRng(): Rng {
    let a = (this.idSeq * 2654435761) >>> 0
    return {
      next: () => {
        a = (a + 0x6d2b79f5) | 0
        let t = Math.imul(a ^ (a >>> 15), 1 | a)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
      },
      int(min, max) {
        return min + Math.floor(this.next() * (max - min + 1))
      },
      pick(items) {
        return items[Math.floor(this.next() * items.length)]
      },
      bool(p) {
        return this.next() < p
      },
    }
  }
}

/** Normalise a case date (ISO or `YYYY-MM-DD`) to an ISO instant for sorting/
 *  seeding — a bare day is noon UTC (matches the fake's seedActivity). */
export const normDate = (d: string): string => (d.includes('T') ? d : `${d}T12:00:00.000Z`)

/** Same-instant op order so a chain stays create → edit → delete → restore (a delete
 *  never sorts before its own edits — the edit-after-delete crash class). */
const OP_ORDER: Record<CaseEvent['op'], number> = { create: 0, edit: 1, delete: 2, restore: 3 }

/** A TOTAL-ORDER comparator for the timeline: by instant, then by op on a tie. Unlike
 *  the `x < y ? -1 : 1` shape (which never returns 0, leaving same-instant order
 *  implementation-defined and one tie-flip away from an edit-before-delete), this is
 *  compliant and deterministic. Used by every applier's sort. */
export const compareEvents = (a: CaseEvent, b: CaseEvent): number => {
  const d = Date.parse(normDate(a.date)) - Date.parse(normDate(b.date))
  return d !== 0 ? d : OP_ORDER[a.op] - OP_ORDER[b.op]
}
