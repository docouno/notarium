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
  Graph,
  GraphHealth,
  GraphLink,
  KnowledgeStore,
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
  classesForScope,
  collectPreviews,
  computeVersionToken,
  DEFAULT_NOTE_TYPE,
  derivePreview,
  directoryOf,
  edgeKey,
  effectiveSlug,
  enrichGraph,
  FOLDER_PAGE_BASENAME,
  IF_EXISTS,
  isFolderPageNote,
  liveSyncStatus,
  makeSnippet,
  nextAliasesMulti,
  normTags,
  NOTE_ID_FRONTMATTER_KEY,
  noteAlreadyExists,
  noteNotFound,
  storedSlug,
  StoreError,
  stripTitleHeading,
  versionConflict,
  versionTokenRequired,
} from '@notarium/core'
// Slug + de-kebab come from CORE (#100): the fake now shares the production
// slugify (camelCase split + Cyrillic transliteration), so a rename through the
// e2e fake reproduces the SAME slugs/links as the real engine — a cyrillic or
// camelCase title no longer collapses to '' here while resolving correctly in
// prod. The old divergent `helpers/slug.ts` is gone.
import { deKebab, slugify as slug, slugifyPath } from '@notarium/core'
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

type RealNode = {
  id: string
  title: string
  filePath: string
  folder: string
  ghost: false
  degree: number
  class: NoteClass
}

type GhostNode = {
  id: string
  title: string
  ghost: true
  folder: ''
  degree: number
  target: string
  prefillTitle: string
  sources?: Array<{ id?: string; title: string; folder: string }>
}

const RE_WIKILINK = /\[\[([^\]]+)\]\]/g

const stripMd = (p: string) => p.replace(/\.md$/, '')

/** The id this store derives for a note at `filePath`, BEFORE collision suffixing
 *  (`architecture/home-server.md` → `fake-architecture-home-server`). Exported
 *  because seeders have to address a note the store hasn't created yet: the seed
 *  catalog's fake projection (#175) stamps journal rows with it so a seeded
 *  revision chain actually belongs to the note it describes. Sharing the function
 *  — rather than a copy of the rule — is what keeps the two from drifting. */
export const deterministicNoteId = (filePath: string): string =>
  'fake-' + slug(stripMd(filePath).replace(/\//g, ' '))

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

  /** Resolve an incoming reference: the note-id first (THE identity), then the
   *  storage key (path), then the wiki-link resolver channels the real engine's
   *  resolveRow also accepts — title, then a custom slug, and last the ALIAS-
   *  history (#100), each as its OWN pass (collision rule current > slug > alias,
   *  mirroring buildLinkIndex): a custom slug never out-resolves another live
   *  note's title, and an old name never shadows a live note. */
  private findIndex(id: string): number {
    const byId = this.notes.findIndex((n) => n.id === id)

    if (byId !== -1) {
      return byId
    }
    const byPath = this.indexByPath(id)

    if (byPath !== -1) {
      return byPath
    }
    const last = slug(stripMd(id).split('/').pop() || stripMd(id))

    if (!last) {
      return -1
    }
    const byCurrent = this.notes.findIndex(
      (n) =>
        n.title.toLowerCase() === stripMd(id).toLowerCase() ||
        slug(stripMd(n.filePath).split('/').pop() || '') === last ||
        slug(n.title) === last,
    )

    if (byCurrent !== -1) {
      return byCurrent
    }
    const bySlug = this.notes.findIndex((n) => (n.slug ? slug(n.slug) === last : false)) // #100 phase 1

    if (bySlug !== -1) {
      return bySlug
    }

    return this.notes.findIndex((n) => n.aliases.some((a) => slug(a) === last))
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

  async list(): Promise<NoteMeta[]> {
    return this.notes.map((n) => this.metaOf(n))
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

  async read(rawId: string): Promise<NoteContent> {
    const i = this.findIndex(rawId)

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
   *  like the real engine: `user` (default) drops agent-memory, `all` is the
   *  full backup. */
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
    const nodes = new Map<string, RealNode | GhostNode>()
    const bySlug = new Map<string, string>() // slug(lastSeg) | slug(title) → permalink
    // Provenance per key (#100 phase 5), mirroring core buildLinkIndex's optional out-param:
    // which axis claimed each key, so a resolved edge records HOW it resolved. Set in
    // lockstep with bySlug so the two never drift (the seam #100 review keeps flagging).
    const bySlugVia = new Map<string, ResolvedVia>()

    for (const n of this.notes) {
      const id = n.id
      nodes.set(id, {
        id,
        title: n.title,
        filePath: n.filePath,
        folder: n.filePath.split('/')[0] || '',
        ghost: false,
        degree: 0,
        class: n.class,
      })
      // Mirror core buildLinkIndex's key set EXACTLY (graph.ts): the slugged full
      // path, the slugged last segment, and the slugged title — so path-form
      // [[dir/note]] resolves here identically to the real engine, not just bare
      // [[title]]. (The fake previously omitted the full-path key, diverging on
      // path-form links — caught in #100 phase 0 review.)
      const path = stripMd(n.filePath)

      for (const key of [slugifyPath(path), slug(path.split('/').pop() || path), slug(n.title)]) {
        bySlug.set(key, id)
        bySlugVia.set(key, 'current')
      }
    }
    // Custom slug keys (#100 phase 1) AFTER current names, BEFORE aliases (collision
    // rule: current > slug > alias) — a [[my-slug]] reaches its note on a FREE key,
    // never shadowing another live note's path/title. Mirrors core buildLinkIndex
    // pass 1.5.
    for (const n of this.notes) {
      if (!n.slug) {
        continue
      }
      const key = slug(n.slug)

      if (key && !bySlug.has(key)) {
        bySlug.set(key, n.id)
        bySlugVia.set(key, 'slug')
      }
    }
    // Alias keys (#100) AFTER every current name (incl. a custom slug) is claimed
    // (collision rule: current > slug > alias) — so an [[Old Name]] resolves to the
    // note it was renamed from, never shadowing a live note that now bears that
    // name. Mirrors core buildLinkIndex's pass build.
    for (const n of this.notes) {
      for (const alias of n.aliases) {
        const key = slug(alias)

        if (key && !bySlug.has(key)) {
          bySlug.set(key, n.id)
          bySlugVia.set(key, 'note-alias')
        }
      }
    }

    const links: GraphLink[] = []
    const seen = new Map<string, number>() // edge key → index in `links`
    // Per-ghost set of source notes that reference it, keyed by ghost id →
    // Map(sourceId → {id, title, folder}) so a note linking twice counts once.
    const ghostSources = new Map<
      string,
      Map<string, { id?: string; title: string; folder: string }>
    >()

    for (const n of this.notes) {
      const from = n.id
      RE_WIKILINK.lastIndex = 0
      for (let m = RE_WIKILINK.exec(n.content); m !== null; m = RE_WIKILINK.exec(n.content)) {
        const label = m[1].split('|')[0].trim() // [[target|alias]] → target
        // Resolve like core resolveLink: the slugged full form first ("dir/note"),
        // then the bare last segment for a pathed link — so [[dir/note]] matches.
        const s = slugifyPath(label)

        if (!s) {
          continue
        }
        const last = s.split('/').pop() || s
        // Resolve AND record provenance off the SAME matched key (mirrors core
        // resolveLink): full form first, then the bare last segment for a pathed link.
        let targetId = bySlug.get(s)
        let via: ResolvedVia | undefined = bySlugVia.get(s)

        if (targetId === undefined && s.includes('/')) {
          targetId = bySlug.get(last)
          via = bySlugVia.get(last)
        }
        if (!targetId) {
          via = undefined // a ghost (broken link) has no resolved axis
          targetId = `ghost:${s}`
          if (!nodes.has(targetId)) {
            nodes.set(targetId, {
              id: targetId,
              title: deKebab(last), // last segment for a pathed ghost, like core
              ghost: true,
              folder: '',
              degree: 0,
              target: s,
              // Prefill that is GUARANTEED to slug back to this ghost's target
              // (#25), mirroring core resolveLink: the raw label when it already
              // slugs to the last segment, else the de-kebabbed last segment — so
              // a path-form [[dir/note]] prefills "Note" (indexed at `note`), not
              // "dir/note" (which would index at `dir-note` and re-ghost).
              prefillTitle: slug(label) === last ? label : deKebab(last),
            })
          }
          if (!ghostSources.has(targetId)) {
            ghostSources.set(targetId, new Map())
          }
          const folder = n.filePath.split('/').slice(0, -1).join('/')
          ghostSources.get(targetId)!.set(from, { id: n.id, title: n.title, folder })
        }
        if (targetId === from) {
          continue
        }
        const edge: GraphLink = {
          source: from,
          target: targetId,
          type: 'links_to',
          ...(via ? { resolvedVia: via } : {}),
        }
        const key = edgeKey(edge)
        const at = seen.get(key)

        if (at !== undefined) {
          // Same source→target seen already: prefer a `current`-name resolution so
          // staleNamed is deterministic regardless of in-body order (mirrors core
          // deriveNoteEdges). Degree was counted on first sight — don't re-count.
          const prev = links[at]

          if (prev.resolvedVia && prev.resolvedVia !== 'current' && (!via || via === 'current')) {
            links[at] = edge
          }
          continue
        }
        seen.set(key, links.length)
        links.push(edge)
        nodes.get(from)!.degree++
        nodes.get(targetId)!.degree++
      }
    }
    // Attach the collected sources to each ghost for the create-from-ghost prefill.
    for (const [gid, srcMap] of ghostSources) {
      const g = nodes.get(gid)

      if (g && g.ghost) {
        g.sources = [...srcMap.values()]
      }
    }
    const graph: Graph = { nodes: [...nodes.values()], links }
    // The same enrichment the read-model cache applies (#62): communities +
    // settled positions, so the host serves one wire shape regardless of the
    // store behind it. Deterministic and synchronous — fixtures are tiny.
    await enrichGraph(graph, { yieldEvery: 0 })
    return graph
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
    versionToken,
    id,
    targetClass,
    ifExists,
    fileName,
    createdAt,
  }: WriteInput): Promise<WriteResult> {
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
    // into an ordinary child note.
    const fileIn = (d: string, base: string) => (d ? `${d}/` : '') + `${slug(base)}.md`
    const tokenOf = (n: StoredNote) => computeVersionToken(stripTitleHeading(n.content, n.title))

    if (originalId) {
      const i = this.findIndex(originalId)

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
      const fileBase = isFolderPageNote(prev.filePath) ? FOLDER_PAGE_BASENAME : fileName || title
      const filePath = fileIn(dir, fileBase)

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
    const filePath = fileIn(norm(directory ?? ''), fileName || title)
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
    const newId = id || this.deriveId(filePath)
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
  async move({ id, destinationPath, isDirectory = false }: MoveInput): Promise<void> {
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
    const i = this.findIndex(id)

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

  async remove(rawId: string): Promise<void> {
    const i = this.findIndex(rawId)

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
    this.addDirPath(path.replace(/^\/+|\/+$/g, ''))
  }

  async removeDir(path: string): Promise<void> {
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
