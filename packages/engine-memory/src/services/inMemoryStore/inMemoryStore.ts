// The reference KnowledgeStore: a clean in-memory implementation of the port
// (P8) with no storage-backend quirks — the executable spec the contract tests
// hold every other engine against. One source of truth (a flat list of notes)
// from which list/read/search/graph all derive, exactly like a real engine's
// index (P2); mutations change that list, so journeys are genuinely stateful.
//
// Today it powers the deterministic e2e fake (#18): seeded from a fixture with
// a fixed `now`, the same snapshot always yields the same bytes. It is also the
// seed of the desktop lite engine — the same domain derivations, to be wrapped
// in fs-scan/persistence/FTS layers when that milestone comes (P9 map).

import type {
  ExportEntry,
  FolderAlias,
  GhostStub,
  Graph,
  GraphHealth,
  GraphLink,
  KnowledgeStore,
  ListOptions,
  MoveInput,
  NoteClass,
  NoteContent,
  NoteMeta,
  Preview,
  ReadOptions,
  ReadScope,
  ResolvedVia,
  SearchResult,
  StoreCapabilities,
  StoreDelta,
  SyncStatus,
  WriteInput,
  WriteResult,
} from '@notarium/core'
import {
  aggregateGraphHealth,
  buildLinkIndex,
  classesForScope,
  collectPreviews,
  computeVersionToken,
  decodeWikilinkIdentity,
  DEFAULT_NOTE_TYPE,
  deriveNoteEdges,
  derivePreview,
  directoryOf,
  effectiveSlug,
  enrichGraph,
  FOLDER_PAGE_BASENAME,
  IF_EXISTS,
  isCanonicalSafeRelativeAddress,
  isDurableScalar,
  isDurableText,
  isFolderPageNote,
  isLegacyImportDestination,
  isPortableMoveDestination,
  isPortableRelativeDestination,
  isValidNoteId,
  isVisibleOn,
  isWikilinkIdentityTarget,
  liveSyncStatus,
  makeSnippet,
  nextAliasesMulti,
  normalizeWikilinkTarget,
  normTags,
  NOTE_ID_FRONTMATTER_KEY,
  noteAlreadyExists,
  noteNotFound,
  resolveLink,
  shapeGraph,
  storedSlug,
  StoreError,
  stripTitleHeading,
  SURFACE,
  versionConflict,
  versionTokenRequired,
} from '@notarium/core'
// Slug + de-kebab come from CORE (#100): the fake now shares the production
// slugify (camelCase split + Cyrillic transliteration), so a rename through the
// e2e fake reproduces the SAME slugs/links as the real engine — a cyrillic or
// camelCase title no longer collapses to '' here while resolving correctly in
// prod. The old divergent `helpers/slug.ts` is gone.
import {
  asciiSlug,
  noteFileBase,
  shortHash,
  slugify as slug,
  sluggedNoteName,
} from '@notarium/core'
import type { StoreSnapshot } from './types'

type StoredNote = {
  id: string
  title: string
  /** The note's class (#78). The fake has no filesystem, so class is seeded
   *  directly (default user-doc) and a create takes WriteInput.targetClass —
   *  mirroring the real engine's mount→class derivation without a mount. */
  class: NoteClass
  filePath: string
  content: string
  noteType: string
  tags: string[]
  /** Alias-history (#100): past human names the resolver still honours, so a
   *  rename never breaks inbound [[Old Name]]. Mirrors the real engine's
   *  frontmatter `aliases:`; the fake holds them as a typed array. */
  aliases: string[]
  /** The editable display slug (#100 phase 1), undefined when the note has no custom
   *  slug (the implicit slug(title) default). Mirrors the real engine's
   *  frontmatter `slug:`. */
  slug?: string
  /** The agent-memory `summary` frontmatter (#21), served back in
   *  read().frontmatter.summary. undefined = the note carries no summary. */
  summary?: string
  /** The agent-memory `muted` opt-out flag (#165), served back in
   *  read().frontmatter.muted. undefined/false = the category loads into the
   *  profile; true = the human muted it (audit-only). */
  muted?: boolean
  modifiedAt: string | null
  createdAt: string | null
}

const stripMd = (p: string) => p.replace(/\.md$/, '')

/** The id this store derives for a note at `filePath`, BEFORE collision suffixing
 *  (`architecture/home-server.md` → `fake-architecture-home-server`). Exported
 *  because seeders have to address a note the store hasn't created yet: the seed
 *  catalog's fake projection (#175) stamps journal rows with it so a seeded
 *  revision chain actually belongs to the note it describes. Sharing the function
 *  — rather than a copy of the rule — is what keeps the two from drifting.
 *
 *  `asciiSlug`, not the name slug: a real `notarium-id` is opaque ASCII, and this
 *  store is the executable spec other engines are held to — a CJK path must not give
 *  it an id shape production can never mint (#296).
 *
 *  But ASCII alone is not enough: `asciiSlug` DROPS an unromanisable segment, so five
 *  CJK notes in one folder would all derive `fake-journal`. `deriveId`'s counter hides
 *  that inside the store, while seeders stamp journal rows with the raw pre-suffix id
 *  (toFixture) — every such note would then wear its neighbours' history. So when the
 *  ASCII form has LOST information (it differs from the full name slug), a short hash
 *  of the path restores injectivity. A path that romanises fully takes the ASCII form
 *  unchanged, which is what keeps every existing seeded/e2e id stable. */
export const deterministicNoteId = (filePath: string): string => {
  const name = stripMd(filePath).replace(/\//g, ' ')
  const ascii = asciiSlug(name)
  // Non-empty AND equal: when both forms are empty they are trivially equal, and that
  // branch would hand every letterless path the same bare prefix.
  const lossless = Boolean(ascii) && ascii === slug(name)

  return `fake-${lossless ? ascii : `${ascii ? `${ascii}-` : ''}${shortHash(name)}`}`
}

/** Minimal YAML-safe scalar for the fake's export reconstruction (#17): quote
 *  when the raw form would parse as something else. A trimmed-down twin of the
 *  engine's serializeNoteFile fmScalar — enough to keep a title with a colon
 *  re-parseable, not a full YAML emitter (the fake is a behaviour spec). */
const fmScalar = (v: string): string =>
  /(^\s|\s$|: |#|^["'&*?|>%@`!-]|: *$)/.test(v) || v === ''
    ? `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
    : v

const moveFailed = (detail: string): StoreError => {
  const err = new StoreError(`# Move Failed: ${detail}`)
  err.isToolError = true
  return err
}

const writeFailed = (detail: string): StoreError => {
  const err = new StoreError(`# Write Failed: ${detail}`)
  err.isToolError = true
  return err
}

export class InMemoryStore implements KnowledgeStore {
  // Substring search over title+body is this engine's honest "FTS"; everything
  // else is a real "no" until the lite engine grows it (P13).
  readonly capabilities: StoreCapabilities = {
    fts: true,
    vector: false,
    hybrid: false,
    graphExpand: false,
    // This store is its own identity registry (P7): every note carries an id,
    // mutations keep it stable across rename/move — the reference behaviour
    // the contract spec holds identity-capable stores to.
    identity: true,
    // And its own CAS arbiter (#50): the body lives right here, so the version
    // check and the mutation are one synchronous step — the reference
    // behaviour for optimistic writes, mirroring what CachedStore gives a bare engine.
    cas: true,
    // No journal in a bare engine — revisions live in the read-model layer
    // (#12); the e2e fake gets them by composing CachedStore over this store.
    revisions: false,
    // The trash (#79) is a view over that journal — same read-model split.
    trash: false,
    // Materializes `class` but does NOT enforce the visibility invariant (#78) —
    // a bare engine returns the full population; CachedStore (the e2e fake wraps
    // this store in it) is the chokepoint.
    visibility: false,
    // No external storage to watch (#146): the content lives in memory, so there
    // is no filesystem change feed — the read-model wrapping this (the e2e fake)
    // degrades to periodic polling, which is exactly what its tests exercise.
    watch: false,
  }

  private notes: StoredNote[] = []
  // The directory channel (#97): folders that exist beyond the notes in them —
  // a "New folder", an emptied folder (never-prune), an empty marked project.
  // Always a SUPERSET of the note-derived dirs (every write seeds its ancestors),
  // so listDirs() = this set. Root ('') is never a member.
  private dirs = new Set<string>()
  private folderAliases: FolderAlias[] = []
  private spaceName = 'main'
  private nowIso = ''

  constructor(snapshot?: StoreSnapshot) {
    this.load(snapshot ?? { notes: [] })
  }

  /** (Re-)initialise from a snapshot — how an in-memory store gets its content.
   *  The e2e fake re-seeds with this before each test. */
  load(snapshot: StoreSnapshot): void {
    this.spaceName = snapshot.space || 'main'
    this.nowIso = snapshot.now ? new Date(snapshot.now).toISOString() : new Date().toISOString()
    // Uniqueness is checked against the batch being built, NOT this.notes:
    // a re-seed (the e2e fake's reset) must mint the very same ids again,
    // and two seeded paths with one slug must still come out distinct.
    const next: StoredNote[] = []

    for (const n of snapshot.notes) {
      next.push({
        id: n.id || this.deriveId(n.filePath, (id) => next.some((m) => m.id === id)),
        title: n.title,
        class: n.class ?? 'user-doc',
        filePath: n.filePath,
        modifiedAt: n.modifiedAt ?? null,
        createdAt: n.createdAt ?? null,
        content: n.content || '',
        noteType: n.noteType || DEFAULT_NOTE_TYPE,
        tags: n.tags || [],
        aliases: n.aliases || [],
        slug: n.slug || undefined, // #100 phase 1: custom slug only
        summary: n.summary,
        muted: n.muted || undefined, // #165: only the truthy flag rides
      })
    }
    this.notes = next
    // A re-seed is a clean slate: no lingering/explicit empty dirs, just the
    // ancestors the seeded notes imply.
    this.dirs = new Set<string>()
    for (const n of next) {
      this.addDirs(n.filePath)
    }
  }

  /** Seed a file's ancestor directories into the channel (#97). Idempotent. */
  private addDirs(filePath: string): void {
    this.addDirPath(directoryOf(filePath))
  }

  /** Seed a directory path AND its ancestors into the channel (#97). Idempotent. */
  private addDirPath(dir: string): void {
    if (!dir) {
      return
    }
    let acc = ''

    for (const part of dir.split('/')) {
      acc = acc ? `${acc}/${part}` : part
      this.dirs.add(acc)
    }
  }

  /** Deterministic id for seeded/created notes (`fake-demo-titanium`): same
   *  fixture → same URLs, what lets e2e journeys hardcode them. A real engine
   *  mints random ids; the contract only requires uniqueness and stability. */
  private deriveId(filePath: string, taken?: (id: string) => boolean): string {
    const base = deterministicNoteId(filePath)
    const used = taken ?? ((id: string) => this.notes.some((n) => n.id === id))
    let id = base

    for (let i = 2; used(id); i++) {
      id = `${base}-${i}`
    }

    return id
  }

  /** The space this store serves — the host's /api/config. */
  get space(): string {
    return this.spaceName
  }

  // ── identity helpers ────────────────────────────────────────────────────────

  /** Resolve an incoming reference: identity/path first, then the shared wiki-name
   *  index. The fake must not carry a second implementation of pass priorities or
   *  collision tie-breaks — those are exactly what the executable parity leg tests. */
  private findIndex(id: string, identityOnly = false): number {
    const identityEnvelope = isWikilinkIdentityTarget(id)

    // The storage port is id-first and ids are fully opaque. A raw id may itself
    // start with the envelope prefix; only authored-link resolution (`identityOnly`)
    // suppresses this direct axis and decodes the transport syntax.
    if (!identityOnly) {
      const byRawId = this.notes.findIndex((n) => n.id === id)

      if (byRawId !== -1) {
        return byRawId
      }
    }
    // `read(list().filePath)` is the storage axis. A legacy POSIX filename may
    // literally occupy the now-reserved envelope namespace, so that exact path
    // wins for an ordinary read. Authored-link resolution passes `identityOnly`
    // through the read-model and keeps the namespace reserved instead.
    if (identityEnvelope && !identityOnly) {
      const byExactEnvelopePath = this.notes.findIndex((n) => n.filePath === id)

      if (byExactEnvelopePath !== -1) {
        return byExactEnvelopePath
      }
    }
    const envelopedId = decodeWikilinkIdentity(id)
    const identity = identityEnvelope ? envelopedId : id
    const byId = identity == null ? -1 : this.notes.findIndex((n) => n.id === identity)

    if (byId !== -1) {
      return byId
    }
    // The reserved envelope can only address an identity. Falling through to the
    // human path/name axes would let a decoy filename capture a missing stable id.
    if (identityEnvelope) {
      return -1
    }
    // Preserve the storage contract: every literal filePath returned by list()
    // must be readable even when its legal filename contains wikilink syntax
    // (`#` / `|`). Human refs are normalized only after this exact raw axis.
    const byPath = this.notes.findIndex((n) => n.filePath === id)

    if (byPath !== -1) {
      return byPath
    }
    const humanTarget = normalizeWikilinkTarget(id)
    const resolved = resolveLink(
      humanTarget,
      buildLinkIndex(
        this.notes.map((n) => this.metaOf(n)),
        this.folderAliases,
        undefined,
        [...this.dirs],
      ),
    )

    if (resolved.ghost) {
      return -1
    }

    return this.notes.findIndex((n) => n.id === resolved.targetId)
  }

  /** EXACT storage-path lookup (id-or-path identity), with NO title/slug/alias
   *  tolerance — the write path's "is THIS exact path already taken" check. It
   *  must stay exact: the tolerant findIndex resolver would wrongly match a
   *  sibling note that merely shares the title (two projects' same-category
   *  memory under distinct `.notarium/memory/<id>/` dirs — #13 I1). Mirrors the
   *  real engine, whose create-collision check is an exact `WHERE path = ?`. */
  private indexByPath(idOrPath: string): number {
    const key = stripMd(idOrPath)
    return this.notes.findIndex((n) => stripMd(n.filePath) === key)
  }

  // ── reads ───────────────────────────────────────────────────────────────────

  async list(opts?: ListOptions): Promise<NoteMeta[]> {
    const classes = opts?.classes == null ? null : new Set(opts.classes)
    return this.notes
      .filter((n) => classes == null || classes.has(n.class))
      .map((n) => this.metaOf(n))
  }

  /** The snapshot metadata view — mirrors the real engine's metaOf, incl. the tag
   *  axis (#109) so the read-model's tag filter/facet works behind the fake too. */
  private metaOf(n: StoredNote): NoteMeta {
    return {
      id: n.id,
      title: n.title,
      class: n.class,
      filePath: n.filePath,
      ...(n.slug ? { slug: n.slug } : {}), // #100 phase 1: custom slug only
      ...(n.aliases.length ? { aliases: n.aliases } : {}),
      ...(n.tags.length ? { tags: n.tags } : {}),
      modifiedAt: n.modifiedAt,
      createdAt: n.createdAt,
    }
  }

  async read(rawId: string, opts?: ReadOptions): Promise<NoteContent> {
    const i = this.findIndex(rawId, opts?.identityOnly)

    // A real miss throws, same as every engine (#65 layer 1) — silently
    // fabricating an empty note here used to hide the whole bug class from e2e.
    if (i === -1) {
      throw noteNotFound(rawId)
    }

    return this.viewOf(this.notes[i])
  }

  /** A note as read() serves it. The version token hashes THIS view (not the
   *  stored bytes): it's what the reader saw, so it's what a save's CAS check
   *  compares against (#50). */
  private viewOf(n: StoredNote): NoteContent & { id: string; versionToken: string } {
    const content = stripTitleHeading(n.content, n.title)
    // Mirror the real engine's parsed frontmatter: tags plus the agent-memory
    // summary (#21) when present. The token hashes the BODY only (summary lives
    // in frontmatter), so a summary-only change is a content no-op — same as the
    // real engine, where read() strips frontmatter before the token.
    const frontmatter: Record<string, unknown> = {}

    if (n.noteType && n.noteType !== DEFAULT_NOTE_TYPE) {
      frontmatter.type = n.noteType
    }
    if (n.tags.length) {
      frontmatter.tags = n.tags
    }
    if (n.aliases.length) {
      frontmatter.aliases = n.aliases
    }
    if (n.slug) {
      frontmatter.slug = n.slug
    }
    // Truthy only — an empty summary is dropped, exactly as the real engine's
    // serializeNoteFile drops an empty-string summary (so '' reads back as absent).
    if (n.summary) {
      frontmatter.summary = n.summary
    }
    // The muted opt-out (#165) reads back as the STRING 'true' — the real engine's
    // YAML parser (valueOf) never coerces scalars, so `muted: true` round-trips to
    // the string 'true', not a boolean. Mirror that here so the read-side
    // normaliser (core memory.ts isMutedFlag) is exercised against the fake the
    // same way it runs against prod (no fake↔prod type drift).
    if (n.muted) {
      frontmatter.muted = 'true'
    }

    return {
      id: n.id,
      title: n.title,
      class: n.class,
      filePath: n.filePath,
      content,
      frontmatter,
      ...(n.slug ? { slug: n.slug } : {}), // #100 phase 1: custom slug only
      ...(n.aliases.length ? { aliases: n.aliases } : {}),
      modifiedAt: n.modifiedAt,
      // The resolved creation instant (#186) — what the editor prefills its date
      // field from; mirrors the real engine serving createdAt on the read view.
      createdAt: n.createdAt,
      versionToken: computeVersionToken(content),
    }
  }

  /** Stream every note as an on-disk-equivalent file for a base export (#17).
   *  The fake has no filesystem, so it RECONSTRUCTS each file from its snapshot
   *  — frontmatter (notarium-id, title, tags, summary) + the `# title` heading +
   *  body — mirroring the SHAPE the real engine ships (raw disk bytes). Not
   *  byte-parity with NotariumStore (the fake is a behaviour spec, not a real
   *  file), but the contract holds: one entry per note, path = filePath, content
   *  = a parseable note file. `scope` reuses the visibility class set, exactly
   *  like the real engine: `user` (default) drops hidden agent state, `all`
   *  includes its in-memory mounts (not host/meta state). */
  async *exportNotes(opts?: { scope?: ReadScope }): AsyncIterable<ExportEntry> {
    const allowed = classesForScope(opts?.scope ?? 'user')

    for (const n of this.notes) {
      if (!allowed.has(n.class)) {
        continue
      }
      yield { path: n.filePath, content: this.fileBytesOf(n) }
    }
  }

  /** Reconstruct a note's file bytes from the snapshot (#17 export). */
  private fileBytesOf(n: StoredNote): string {
    const body = stripTitleHeading(n.content, n.title)
    const lines = [`${NOTE_ID_FRONTMATTER_KEY}: ${n.id}`, `title: ${fmScalar(n.title)}`]

    if (n.noteType && n.noteType !== DEFAULT_NOTE_TYPE) {
      lines.push(`type: ${fmScalar(n.noteType)}`)
    }
    if (n.tags.length) {
      lines.push('tags:', ...n.tags.map((t) => `- ${fmScalar(t)}`))
    }
    if (n.aliases.length) {
      lines.push('aliases:', ...n.aliases.map((a) => `- ${fmScalar(a)}`))
    }
    if (n.slug) {
      lines.push(`slug: ${fmScalar(n.slug)}`)
    }
    if (n.summary) {
      lines.push(`summary: ${fmScalar(n.summary)}`)
    }
    if (n.muted) {
      lines.push('muted: true')
    }
    const head = `---\n${lines.join('\n')}\n---\n\n# ${n.title}\n`
    return body ? `${head}\n${body}` : head
  }

  /** Derived live from the in-memory body — this store IS its own cache. */
  async preview(rawId: string): Promise<Preview> {
    return this.previewPeek(rawId) ?? { snippet: '', image: null, tags: [], words: 0, tokens: 0 }
  }

  async previews(ids: readonly string[], opts?: ReadOptions): Promise<Record<string, Preview>> {
    return collectPreviews(ids, opts, (id) => this.preview(id))
  }

  /** Synchronous by nature here: the body is already in memory, so the peek is
   *  always warm — the e2e fake serves every notes window with previews inline. */
  previewPeek(rawId: string): Preview | null {
    const i = this.findIndex(rawId)

    if (i === -1) {
      return null
    }
    const n = this.notes[i]
    return derivePreview(stripTitleHeading(n.content, n.title), n.tags)
  }

  async search(q: string): Promise<SearchResult[]> {
    const needle = q.trim().toLowerCase()

    if (!needle) {
      return []
    }

    return this.notes
      .filter(
        (n) => n.title.toLowerCase().includes(needle) || n.content.toLowerCase().includes(needle),
      )
      .map((n) => ({
        id: n.id,
        title: n.title,
        class: n.class,
        filePath: n.filePath,
        modifiedAt: n.modifiedAt,
        createdAt: n.createdAt,
        score: 1,
        snippet: makeSnippet(stripTitleHeading(n.content, n.title), 160),
        noteType: n.noteType || DEFAULT_NOTE_TYPE,
        type: 'note',
      }))
  }

  /** Knowledge graph, derived from [[wiki links]] in note bodies. Unresolved
   *  targets become ghost nodes carrying the create-from-ghost prefill (#25). */
  async graph(): Promise<Graph> {
    const metas = this.notes.map((n) => this.metaOf(n))
    const graphNotes = this.notes.filter((n) => isVisibleOn(SURFACE.graph, n.class))
    const graphMetas = graphNotes.map((n) => this.metaOf(n))
    const provenance = new Map<string, ResolvedVia>()
    const index = buildLinkIndex(graphMetas, this.folderAliases, provenance, [...this.dirs])
    const ghosts = new Map<string, GhostStub>()
    const edgesBySource: Array<[string, GraphLink[]]> = graphNotes.map((n) => {
      const derived = deriveNoteEdges(n.id, n.content, index, 'links_to', provenance)

      for (const ghost of derived.ghosts) {
        ghosts.set(ghost.id, ghost)
      }

      return [n.id, derived.edges]
    })
    const graph = shapeGraph(metas, edgesBySource, ghosts)

    // The same enrichment the read-model cache applies (#62): communities +
    // settled positions, so the host serves one wire shape regardless of the
    // store behind it. Deterministic and synchronous — fixtures are tiny.
    await enrichGraph(graph, { yieldEvery: 0 })
    return graph
  }

  setFolderAliases(aliases: ReadonlyArray<FolderAlias>): void {
    this.folderAliases = aliases.map((a) => ({ ...a }))
  }

  /** Read-only grooming health (#100 phase 5) over the fake's fresh graph (its links
   *  carry `resolvedVia`), so the e2e fake serves the SAME shape as the real engine
   *  and the dashboard health card is testable without a live engine. */
  async graphHealth(): Promise<GraphHealth> {
    return aggregateGraphHealth(await this.graph())
  }

  // ── mutations ───────────────────────────────────────────────────────────────

  /** Create or, with originalId, rename-in-place (the #8 invariant: a title or
   *  folder change relocates the note instead of duplicating it). Updates are
   *  optimistic (#50): the caller's versionToken must match the live body or
   *  nothing is written — the whole method is synchronous, so the check and
   *  the mutation are atomic. */
  async write({
    title,
    content = '',
    directory,
    noteType,
    tags,
    slug: rawSlug,
    summary,
    muted,
    originalId,
    identityOnly,
    versionToken,
    id,
    targetClass,
    ifExists,
    fileName,
    legacyImportRoot,
    createdAt,
  }: WriteInput): Promise<WriteResult> {
    const scalarInputs = [title, directory, noteType, rawSlug, summary, fileName, createdAt]
    const tagInputs = Array.isArray(tags) ? tags : tags != null ? [tags] : []

    if (
      scalarInputs.some((value) => value != null && !isDurableScalar(value)) ||
      tagInputs.some((value) => !isDurableScalar(value)) ||
      !isDurableText(content) ||
      (id != null && !isValidNoteId(id)) ||
      (originalId != null &&
        !isValidNoteId(originalId) &&
        decodeWikilinkIdentity(originalId) == null)
    ) {
      throw writeFailed('input contains an invalid durable string')
    }
    const requestedDirectory = directory ?? ''
    const validDirectory =
      legacyImportRoot !== undefined
        ? !originalId &&
          Boolean(fileName) &&
          isLegacyImportDestination(requestedDirectory, legacyImportRoot, (prefix) =>
            this.dirs.has(prefix),
          )
        : isPortableRelativeDestination(requestedDirectory, (prefix) => this.dirs.has(prefix))

    if (!validDirectory) {
      throw writeFailed('directory must be safe with portable new components')
    }
    // Carry-forward semantics matching the real engine's serializeNoteFile: an
    // UNDEFINED field leaves the note's existing value untouched (the semantic
    // ops re-send what they read, #21 — a write that omitted them would wrongly
    // clear them); a provided value sets it. `tags: []` still clears (an explicit
    // empty), and `summary: ''` clears too — mirroring serializeNoteFile's
    // drop-on-empty so the two engines read back identically.
    const tagsFor = (prev: string[]): string[] =>
      tags === undefined ? prev : (normTags(tags) ?? [])
    const summaryFor = (prev: string | undefined): string | undefined =>
      summary === undefined ? prev : summary || undefined
    // The muted opt-out (#165), tags/summary-parity: undefined carries the note's
    // existing flag forward (a write that omitted it would wrongly un-mute), true
    // sets it, false clears it (an explicit un-mute drops the frontmatter entry).
    const mutedFor = (prev: boolean | undefined): boolean | undefined =>
      muted === undefined ? prev : muted || undefined

    // The note's stored slug after this write (#100 phase 1): storedSlug cleans + keeps
    // it only when it diverges from slug(title); undefined leaves prev untouched,
    // '' clears back to the implicit default. Mirrors the real engine's slugChannel.
    const slugFor = (prev: string | undefined): string | undefined => {
      const ch = storedSlug(rawSlug, title)
      return ch === undefined ? prev : ch || undefined
    }
    const norm = (d: string) => (!d || d === '/' ? '' : d.replace(/^\/+|\/+$/g, ''))
    // fileName (import #11) overrides slug(title) on create AND, opt-in, on edit (#209):
    // an edit that hands an explicit fileName keeps that basename instead of re-deriving
    // it from slug(title) — see the edit branch below. Folder-page edits keep the reserved
    // `index.md` basename for every write path, so a body/title edit never turns the cover
    // into an ordinary child note. The path formula itself is CORE's (#296) — the fake
    // shares it so a title the real engine can't slug (emoji-only → the id rung) lands on
    // the same file here, and an e2e run can't pass a destination production refuses.
    // title and fileName stay SEPARATE arguments: the formula's precedence is
    // `fileName -> title -> id`, so folding them into one base here would skip the
    // title rung — a create pinning a fileName that slugs to nothing (an emoji) would
    // land on the id in the fake while production still names it after the title.
    const fileIn = (d: string, noteTitle: string, base: string | undefined, noteId?: string) =>
      (d ? `${d}/` : '') +
      `${noteFileBase(noteTitle, base, noteId, legacyImportRoot !== undefined)}.md`
    const tokenOf = (n: StoredNote) => computeVersionToken(stripTitleHeading(n.content, n.title))

    if (originalId) {
      const i = this.findIndex(originalId, identityOnly)

      // A dead reference is an honest 404, never a silent re-create: the note
      // was deleted under the editor and resurrecting it would hide that.
      if (i === -1) {
        throw noteNotFound(originalId)
      }
      if (!versionToken) {
        throw versionTokenRequired(originalId)
      }
      if (versionToken !== tokenOf(this.notes[i])) {
        throw versionConflict(this.viewOf(this.notes[i]))
      }
      // No directory given (the restore/edit path) → keep the note in its
      // CURRENT folder; an explicit directory moves it. The path changes, the id
      // does NOT (P7).
      const dir = directory === undefined ? directoryOf(this.notes[i].filePath) : norm(directory)
      const prev = this.notes[i]
      // An explicit fileName is honoured on edit too (opt-in): a metadata touch that
      // hands the note's current basename keeps the file in place rather than renaming
      // to slug(title) — mirrors the notarium engine. Folder pages stay `index`.
      const fileBase = isFolderPageNote(prev.filePath) ? FOLDER_PAGE_BASENAME : fileName
      const preserveCurrentPath =
        title === prev.title && fileName == null && dir === directoryOf(prev.filePath)
      const filePath = preserveCurrentPath ? prev.filePath : fileIn(dir, title, fileBase, prev.id)

      // Rename-in-place must never swallow a different note already at the
      // destination — the real engine's guard, mirrored so the fake can't pass a
      // scenario production refuses. canon: docs/note-model.md#create-collisions
      if (filePath !== prev.filePath && this.indexByPath(filePath) !== -1) {
        throw moveFailed('a note already lives at the destination')
      }
      const newSlug = slugFor(prev.slug)
      // Alias-history (#100): a title OR slug change records the old name(s) so
      // inbound [[Old Title]] / [[old-slug]] keep resolving — mirrors the real
      // engine's write() (effective-slug comparison; nextAliasesMulti dedups).
      const prevEffSlug = effectiveSlug(prev.slug, prev.title)
      const newEffSlug = effectiveSlug(newSlug, title)
      this.notes[i] = {
        ...prev,
        title,
        content,
        noteType: noteType || prev.noteType,
        tags: tagsFor(prev.tags),
        aliases:
          prev.title !== title || prevEffSlug !== newEffSlug
            ? nextAliasesMulti(prev.aliases, [prev.title, prevEffSlug], [title, newEffSlug])
            : prev.aliases,
        slug: newSlug,
        summary: summaryFor(prev.summary),
        muted: mutedFor(prev.muted),
        filePath,
        modifiedAt: this.nowIso,
        // Authored date edit (#186): a provided `createdAt` overwrites; undefined
        // keeps the note's existing birth date (carry-forward, mirrors the real
        // engine's serializeNoteFile SET-on-provided). `modified` always stamps now.
        createdAt: createdAt ?? prev.createdAt,
      }
      this.addDirs(filePath) // a folder change seeds the new dir (#97); the old lingers
      return {
        id: this.notes[i].id,
        filePath,
        class: this.notes[i].class,
        versionToken: tokenOf(this.notes[i]),
      }
    }
    // Identity is settled BEFORE the path here, because the last rung of the path
    // formula is the id itself (#296): deriving the id from the final path would be
    // circular for a title with nothing sluggable in it. The id keeps riding on the
    // path the TITLE alone implies — identical for every ordinary note, so seeded and
    // e2e-hardcoded ids are untouched.
    const createDir = norm(directory ?? '')
    const newId =
      id ||
      this.deriveId(
        (createDir ? `${createDir}/` : '') + `${sluggedNoteName(title, fileName) || 'note'}.md`,
      )
    const filePath = fileIn(createDir, title, fileName, newId)
    const existing = this.indexByPath(filePath)

    // Create-collision policy, mirroring notariumStore: refuse unless the caller
    // explicitly asked to clobber. canon: docs/note-model.md#create-collisions
    if (existing !== -1 && ifExists !== IF_EXISTS.overwrite) {
      throw noteAlreadyExists(title)
    }
    if (existing !== -1) {
      this.notes[existing] = {
        ...this.notes[existing],
        title,
        content,
        noteType: noteType || this.notes[existing].noteType,
        tags: tagsFor(this.notes[existing].tags),
        slug: slugFor(this.notes[existing].slug),
        summary: summaryFor(this.notes[existing].summary),
        muted: mutedFor(this.notes[existing].muted),
        modifiedAt: this.nowIso,
      }
      return {
        id: this.notes[existing].id,
        filePath,
        class: this.notes[existing].class,
        versionToken: tokenOf(this.notes[existing]),
      }
    }
    const fresh: StoredNote = {
      id: newId,
      title,
      // Class is enforced from the target mount (#78): a create takes the
      // selector the tool zashivaet (#21), default user-doc; edits keep theirs.
      class: targetClass ?? 'user-doc',
      filePath,
      content,
      noteType: noteType || DEFAULT_NOTE_TYPE,
      tags: tagsFor([]),
      aliases: [],
      slug: slugFor(undefined),
      summary: summaryFor(undefined),
      muted: mutedFor(undefined),
      // Dates-as-data (#11): an import threads the original `createdAt` (the real
      // engine's `created:`-over-birthtime rule); `modified` always stamps now.
      modifiedAt: this.nowIso,
      createdAt: createdAt ?? this.nowIso,
    }
    this.notes.push(fresh)
    this.addDirs(filePath) // seed the note's folder into the directory channel (#97)
    return {
      id: newId,
      filePath,
      class: fresh.class,
      versionToken: tokenOf(fresh),
    }
  }

  /** Move a note or a folder subtree. A failed move throws the same
   *  "# Move Failed" tool-error a bare engine surfaces (#6/#8). */
  async move({ id, destinationPath, isDirectory = false, identityOnly }: MoveInput): Promise<void> {
    const currentPath = isDirectory ? id : this.notes[this.findIndex(id, identityOnly)]?.filePath

    if (
      !isDurableScalar(destinationPath) ||
      !isPortableMoveDestination(
        destinationPath,
        currentPath ?? '',
        (prefix) => this.dirs.has(prefix) || prefix === currentPath,
      ) ||
      (!isDirectory && !isValidNoteId(id) && decodeWikilinkIdentity(id) == null) ||
      (isDirectory && !isCanonicalSafeRelativeAddress(id))
    ) {
      throw moveFailed('path or identity contains an invalid durable string')
    }
    if (isDirectory) {
      const src = id
      // Occupancy is the directory channel's truth, not just notes (#97): an
      // empty folder at dest would still be clobbered by the relocate.
      const occupied =
        this.notes.some((n) => n.filePath.startsWith(destinationPath + '/')) ||
        this.dirs.has(destinationPath)

      if (occupied) {
        throw moveFailed('destination folder is occupied')
      }
      // No 'folder not found' guard here (#97): this in-memory engine doesn't
      // model an empty MARKED project (registry-only in the e2e fake — no marker
      // file, no dir entry), yet such a move must SUCCEED, mirroring the real
      // engine where the on-disk marker makes the dir exist (`dirExists`). The
      // server's renamePrefix re-homes the project row; relocate whatever notes
      // and dir entries we DO hold.
      for (const n of this.notes) {
        if (n.filePath === src || n.filePath.startsWith(src + '/')) {
          n.filePath = destinationPath + n.filePath.slice(src.length)
          n.modifiedAt = this.nowIso
        }
      }
      // Re-key the directory channel: the src subtree moves wholesale, the src
      // parent lingers (never-prune). An empty registry-only project isn't in the
      // set, so nothing is re-keyed — the server's registry-union surfaces it.
      for (const d of [...this.dirs]) {
        if (d === src || d.startsWith(src + '/')) {
          this.dirs.delete(d)
          this.dirs.add(destinationPath + d.slice(src.length))
        }
      }

      return
    }
    const i = this.findIndex(id, identityOnly)

    if (i === -1) {
      throw moveFailed('note not found')
    }
    if (this.notes.some((n, j) => j !== i && n.filePath === destinationPath)) {
      throw moveFailed('a note already lives at the destination')
    }
    this.notes[i].filePath = destinationPath
    this.notes[i].modifiedAt = this.nowIso
    this.addDirs(destinationPath) // seed the new folder; the old lingers (#97)
  }

  async remove(rawId: string, opts?: { identityOnly?: boolean }): Promise<void> {
    const i = this.findIndex(rawId, opts?.identityOnly)

    if (i !== -1) {
      this.notes.splice(i, 1)
    }
    // never-prune (#97): the note's folder stays in the directory channel.
  }

  async listDirs(): Promise<string[]> {
    // Mirror localFs.listDirs: dot-namespaced dirs (the agent-mount
    // `.notarium/memory`, #78) never surface into the user tree. This single
    // store conflates mounts the real engine keeps separate, so it filters here.
    return [...this.dirs].filter((d) => !d.split('/').some((seg) => seg.startsWith('.')))
  }

  async makeDir(path: string): Promise<void> {
    if (!isPortableRelativeDestination(path, (prefix) => this.dirs.has(prefix))) {
      throw moveFailed('folder path contains an invalid durable string')
    }
    const clean = path.replace(/^\/+|\/+$/g, '')

    if (this.dirs.has(clean)) {
      throw moveFailed('a folder with that name already exists')
    }
    this.addDirPath(clean)
  }

  async removeDir(path: string): Promise<void> {
    if (!isCanonicalSafeRelativeAddress(path)) {
      throw moveFailed('folder path contains an invalid durable string')
    }
    const clean = path.replace(/^\/+|\/+$/g, '')

    if (!clean) {
      return
    }
    this.notes = this.notes.filter(
      (n) => n.filePath !== clean && !n.filePath.startsWith(clean + '/'),
    )
    for (const d of [...this.dirs]) {
      if (d === clean || d.startsWith(clean + '/')) {
        this.dirs.delete(d)
      }
    }
  }

  // ── sync surface ────────────────────────────────────────────────────────────

  /** No external change source exists for an in-memory base, so the honest
   *  delta is "nothing happened" plus the full inventory (deletes fall out of
   *  diffing it — the port's contract). */
  async changes(cursor: string | null): Promise<StoreDelta> {
    return { cursor: cursor ?? 'live', upserts: [], inventory: await this.list() }
  }

  async syncStatus(): Promise<SyncStatus> {
    return liveSyncStatus()
  }
}
