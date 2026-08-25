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
  FrontmatterEntry,
  GhostStub,
  Graph,
  GraphHealth,
  GraphLink,
  KnowledgeStore,
  ListOptions,
  MoveInput,
  MoveResult,
  MutationOptions,
  NoteClass,
  NoteContent,
  NoteMeta,
  PhysicalWriteClaim,
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
  analyzeDocumentState,
  basenameOf,
  bindStorageOwnerProof,
  buildLinkIndex,
  classesForScope,
  collectPreviews,
  CREATED_FALLBACK_FRONTMATTER_KEY,
  decodeWikilinkIdentity,
  DEFAULT_NOTE_TYPE,
  deriveNoteEdges,
  derivePreview,
  destinationOwnerConflict,
  directoryOf,
  DOCUMENT_ROLE,
  DOCUMENT_STATE_FORMAT,
  documentStateVersionToken,
  effectiveSlug,
  enrichGraph,
  FOLDER_PAGE_BASENAME,
  frontmatterEntryValue,
  frontmatterHasYamlNodeReferences,
  frontmatterScalar,
  IF_EXISTS,
  IMPORT_SOURCE_FRONTMATTER_KEY,
  isCanonicalInternalRelativeAddress,
  isCanonicalSafeRelativeAddress,
  isDurableFrontmatter,
  isDurableScalar,
  isDurableText,
  isFolderPageNote,
  isImportNoteSourceLocator,
  isLegacyImportDestination,
  isPortableMoveDestination,
  isPortableRelativeDestination,
  isSkillPackageRootPath,
  isValidNoteId,
  isVisibleOn,
  isWikilinkIdentityTarget,
  isWithinFrontmatterByteCap,
  legacyNoteNameAlias,
  liveSyncStatus,
  logicalNoteState,
  makeSnippet,
  nextAliasesMulti,
  normAliases,
  normalizeWikilinkTarget,
  normTags,
  NOTE_ID_FRONTMATTER_KEY,
  noteAlreadyExists,
  noteNotFound,
  parseFrontmatterBlock,
  parseFrontmatterLines,
  resolveLink,
  shapeGraph,
  skillNameConflict,
  skillPackagePathOf,
  skillPlacementPathOf,
  STORAGE_OWNER_KEY,
  storedSlug,
  StoreError,
  stripFrontmatter,
  stripTitleHeading,
  SURFACE,
  unionLegacyNameAliases,
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

const YAML_NODE_REFERENCE_WRITE_ERROR =
  'frontmatter with YAML anchors or aliases is not supported by writes'

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
  /** Frontmatter the note ARRIVED with that this store models no field for
   *  (#280) — an imported file's own keys, kept as raw entries. The real engine
   *  keeps them by merging into the file's block; the fake has no file, so it
   *  carries them here and serves them back through read().frontmatter and the
   *  export reconstruction — the same keys, the same place. */
  carried?: FrontmatterEntry[]
  /** Typed projection of the reserved file-truth provenance. */
  sourceLocator?: string
  modifiedAt: string | null
  createdAt: string | null
  /** Whether the resolved creation date owns a typed YAML projection. Raw
   *  `created:` remains in `carried` and needs no second emission; a store-clock
   *  fallback has no authored claim at all. */
  createdProjected: boolean
  /** Opaque physical incarnation, independent of semantic/CAS equality. */
  physicalWriteClaim: PhysicalWriteClaim
}

const PHYSICAL_WRITE_CLAIM_KIND = 'in-memory-incarnation-v1'
let physicalIncarnationSequence = 0

const nextPhysicalWriteClaim = (): PhysicalWriteClaim => ({
  kind: PHYSICAL_WRITE_CLAIM_KIND,
  value: String(++physicalIncarnationSequence),
})

const physicalWriteClaimOf = (note: StoredNote): PhysicalWriteClaim => ({
  ...note.physicalWriteClaim,
})

/** The fake owns no mount table, so the two skill mounts it models are recognised
 *  here — ONCE — and every canonical package predicate below is fed the same
 *  mount-relative path the real engine feeds them (`NotariumStore.relIn`). */
const splitSkillMount = (filePath: string): { mount: string[]; relativePath: string } => {
  const parts = filePath.split('/')
  const mountLength =
    parts[0] === '.notarium' && parts[1] === 'skills' ? 2 : parts[0] === 'skills' ? 1 : 0

  return { mount: parts.slice(0, mountLength), relativePath: parts.slice(mountLength).join('/') }
}

/** Is this note the ROOT manifest of its Agent Skill package? The single producer
 *  every path asks — read classification, the manifest fence, the name-conflict scan
 *  and the rename guard — so the fake cannot answer one structural question two ways.
 *  It is the real engine's own test (`mount.class === 'skill' && isSkillPackageRootPath`),
 *  which is root BY DEPTH: `<pkg>/references/SKILL.md` merely ENDS like a manifest and
 *  is an ordinary auxiliary. A `basenameOf(...) === 'SKILL.md'` test would promote one
 *  at ANY depth — and then reject writing the very file the read beside it classifies
 *  as auxiliary. canon: docs/note-model.md#note-ontology */
const isSkillPackageRootNote = (note: Pick<StoredNote, 'class' | 'filePath'>): boolean =>
  note.class === 'skill' && isSkillPackageRootPath(splitSkillMount(note.filePath).relativePath)

/** The library root a package competes for its NAME in: the mount root for a
 *  Personal/Space package, the encoded `_projects/<project>` root for a project one.
 *  Same canonical producer the real engine's resource authority uses. */
const skillPlacementOf = (filePath: string): string => {
  const { mount, relativePath } = splitSkillMount(filePath)
  const placement = skillPlacementPathOf(relativePath)

  return [...mount, ...(placement ? [placement] : [])].join('/')
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

/** YAML-safe scalar for the fake's export reconstruction (#17) — core's emitter,
 *  the SAME one the real engine serializes files with. It used to be a
 *  trimmed-down twin here; sharing it is what keeps the two stands from quoting
 *  an exotic title differently. */
const fmScalar = frontmatterScalar

const carriedEntry = (
  carried: readonly FrontmatterEntry[] | undefined,
  key: string,
): FrontmatterEntry | undefined => {
  for (let i = (carried?.length ?? 0) - 1; i >= 0; i--) {
    if (carried![i].key === key) {
      return carried![i]
    }
  }

  return undefined
}

type CarriedField<T> = { present: boolean; value: T }

const carriedField = <T>(
  carried: readonly FrontmatterEntry[] | undefined,
  key: string,
  project: (value: unknown) => T,
): CarriedField<T> => {
  const entry = carriedEntry(carried, key)
  return {
    present: entry !== undefined,
    value: project(entry ? frontmatterEntryValue(entry) : undefined),
  }
}

const cloneEntry = (entry: FrontmatterEntry): FrontmatterEntry => ({
  key: entry.key,
  lines: [...entry.lines],
})

/** Mirror serializeNoteFile's existing ∪ incoming merge in a store that has no
 *  file to merge into. Linear in the number of entries: incoming keyed entries
 *  replace and collapse every old duplicate (the last incoming value wins),
 *  absent keys carry forward, and keyless entries dedupe only against the
 *  pre-existing file. Two identical comments in ONE source are authored twice and
 *  survive; sending that same source again does not append two more. */
const mergeCarried = (
  existing: readonly FrontmatterEntry[] | undefined,
  incoming: readonly FrontmatterEntry[] | undefined,
): FrontmatterEntry[] | undefined => {
  if (incoming === undefined) {
    return existing?.map(cloneEntry)
  }
  const incomingByKey = new Map<string, FrontmatterEntry>()
  const incomingKeyOrder: string[] = []
  const preExistingKeyless = new Set(
    (existing ?? []).filter((entry) => entry.key === null).map((entry) => entry.lines[0]),
  )
  const newKeyless: FrontmatterEntry[] = []

  for (const raw of incoming) {
    const entry = cloneEntry(raw)

    if (entry.key !== null) {
      if (!incomingByKey.has(entry.key)) {
        incomingKeyOrder.push(entry.key)
      }
      incomingByKey.set(entry.key, entry) // duplicate inside the source: last wins
    } else if (!preExistingKeyless.has(entry.lines[0])) {
      newKeyless.push(entry) // do NOT dedupe two identical lines from this source
    }
  }

  const entries: FrontmatterEntry[] = []
  const placed = new Set<string>()

  for (const raw of existing ?? []) {
    if (raw.key !== null && incomingByKey.has(raw.key)) {
      if (!placed.has(raw.key)) {
        entries.push(incomingByKey.get(raw.key)!)
        placed.add(raw.key)
      }
      continue // collapse every later existing duplicate of an incoming key
    }
    entries.push(cloneEntry(raw))
  }
  for (const key of incomingKeyOrder) {
    if (!placed.has(key)) {
      entries.push(incomingByKey.get(key)!)
    }
  }

  const merged = [...newKeyless, ...entries]
  return merged.length ? merged : undefined
}

const withoutCarriedKey = (
  carried: FrontmatterEntry[] | undefined,
  key: string,
): FrontmatterEntry[] | undefined => {
  const next = carried?.filter((entry) => entry.key !== key)
  return next?.length ? next : undefined
}

const frontmatterDate = (value: unknown): string | null => {
  if (typeof value !== 'string' || !value.trim()) {
    return null
  }
  const date = new Date(value.trim())
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

const carriedCreated = (carried: readonly FrontmatterEntry[] | undefined) => {
  const authored = carriedField(carried, 'created', frontmatterDate)
  const fallback = carriedField(carried, CREATED_FALLBACK_FRONTMATTER_KEY, frontmatterDate)

  return {
    present: authored.present || fallback.present,
    value: authored.value ?? fallback.value,
    /** The author's `created:` is present but cannot provide a date. Keep it raw;
     *  the resolved mtime/date then needs the reserved sibling key. */
    conflict: authored.present && authored.value === null,
  }
}

/** The typed fields the real engine RE-DERIVES from a file's frontmatter when it
 *  reads it back (parseNoteFile): imported aliases/slug/tags/type and the fake's
 *  summary/muted projections are live because the keys land in the FILE. The fake
 *  has no file to re-read, so it derives the same projections off the carried
 *  entries itself — otherwise an imported alias would resolve on one stand and
 *  not the other (docs/import.md).
 *
 *  Both entry points must run it, and that is the whole reason it is a function:
 *  `write()` (a live import) and `load()` (a seeded fixture) produce the same note
 *  from the same keys. Skipping it on either side is silent DATA LOSS, not just a
 *  divergence — the export reconstruction drops a carried line whenever the typed
 *  field is about to re-emit it, so an underived field means the key is gone. */
const carriedTyped = (carried: readonly FrontmatterEntry[] | undefined) => {
  const createdAt = carriedCreated(carried)

  return {
    aliases: carriedField(carried, 'aliases', (value) => normAliases(value) ?? []),
    slug: carriedField(
      carried,
      'slug',
      (value) => (typeof value === 'string' ? slug(value) : '') || undefined,
    ),
    tags: carriedField(carried, 'tags', (value) => normTags(value) ?? []),
    noteType: carriedField(carried, 'type', (value) =>
      typeof value === 'string' && value.trim() ? value.trim() : DEFAULT_NOTE_TYPE,
    ),
    summary: carriedField(carried, 'summary', (value) =>
      typeof value === 'string' && value ? value : undefined,
    ),
    muted: carriedField(carried, 'muted', (value) =>
      value === true || value === 'true' ? true : undefined,
    ),
    createdAt,
    sourceLocator: carriedField(carried, IMPORT_SOURCE_FRONTMATTER_KEY, (value) =>
      isImportNoteSourceLocator(value) ? value : undefined,
    ),
  }
}

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
    // And its own CAS arbiter (#50): the whole logical state lives here, so the version
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
  /** Identity-owned compatibility state, intentionally independent from the
   * live note array so delete followed by a forced restore cannot forget it. */
  private legacyNameAliasesById = new Map<string, readonly string[]>()
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
    this.legacyNameAliasesById = new Map()

    for (const n of snapshot.notes) {
      // #280: an imported note's own keys, authored as bare YAML lines. The typed
      // fields the file's frontmatter would give the real engine are derived here,
      // exactly as write() derives them — a seeded imported note and a live-imported
      // one must be the same note.
      if (n.frontmatter !== undefined && typeof n.frontmatter !== 'string') {
        throw writeFailed('snapshot frontmatter contains an invalid durable string')
      }
      const withinByteCap = n.frontmatter === undefined || isWithinFrontmatterByteCap(n.frontmatter)
      const hasBareFence = Boolean(
        withinByteCap && n.frontmatter && /(?:^|\n)---[ \t]*(?=\r?(?:\n|$))/.test(n.frontmatter),
      )
      const parsedCarried =
        withinByteCap && n.frontmatter ? parseFrontmatterLines(n.frontmatter) : undefined

      // load() is a bare-engine ingress just like write(): fixture text is parsed
      // into the same raw-entry channel and must pass the same durability/shape
      // fence. Check the bare source delimiter too — parseFrontmatterLines would
      // otherwise treat an injected `---` as its wrapper's early close and hide
      // every poisoned line after it from the entry validator.
      if (!withinByteCap || hasBareFence || !isDurableFrontmatter(parsedCarried)) {
        throw writeFailed('snapshot frontmatter contains an invalid durable string')
      }
      // A fixture models bytes already present on disk. Keep its raw ordered
      // entries exactly, including duplicate custom keys; typed projections use
      // the last readable owner without rewriting the source state on ingress.
      const hasYamlNodeReferences = frontmatterHasYamlNodeReferences(parsedCarried)
      const importedCarried = parsedCarried?.map(cloneEntry)
      // Explicit snapshot fields model the serializer's final typed puts/drops.
      // Remove every raw shadow even for clears, or a later export/write would
      // revive the value the typed channel deliberately removed.
      const snapshotOwnedKeys = new Set(
        [
          ['type', n.noteType],
          ['tags', n.tags],
          ['aliases', n.aliases],
          ['slug', n.slug],
          ['summary', n.summary],
          ['muted', n.muted],
          [IMPORT_SOURCE_FRONTMATTER_KEY, n.sourceLocator],
        ]
          .filter(([, value]) => value !== undefined)
          .map(([key]) => key as string),
      )
      let carried = hasYamlNodeReferences
        ? importedCarried
        : importedCarried?.filter((entry) => !entry.key || !snapshotOwnedKeys.has(entry.key))

      if (n.createdAt != null && !hasYamlNodeReferences) {
        // A concrete snapshot date is the serializer's final typed write. It
        // replaces a readable raw `created:` and every old fallback. The one
        // exception mirrors noteFile: an unreadable authored `created:` remains
        // verbatim and the resolved date is projected under the reserved key.
        if (!carriedCreated(carried).conflict) {
          carried = withoutCarriedKey(carried, 'created')
        }
        carried = withoutCarriedKey(carried, CREATED_FALLBACK_FRONTMATTER_KEY)
      }
      const fromCarry = carriedTyped(carried)

      if (n.sourceLocator != null && !isImportNoteSourceLocator(n.sourceLocator)) {
        throw writeFailed('snapshot source locator is invalid')
      }
      const candidate: StoredNote = {
        id: n.id || this.deriveId(n.filePath, (id) => next.some((m) => m.id === id)),
        title: n.title,
        class: n.class ?? 'user-doc',
        filePath: n.filePath,
        modifiedAt: n.modifiedAt ?? null,
        createdAt: n.createdAt ?? (fromCarry.createdAt.present ? fromCarry.createdAt.value : null),
        createdProjected: n.createdAt != null,
        physicalWriteClaim: nextPhysicalWriteClaim(),
        content: n.content || '',
        noteType:
          n.noteType !== undefined
            ? n.noteType && n.noteType !== DEFAULT_NOTE_TYPE
              ? n.noteType
              : DEFAULT_NOTE_TYPE
            : fromCarry.noteType.present
              ? fromCarry.noteType.value
              : DEFAULT_NOTE_TYPE,
        tags: n.tags ?? (fromCarry.tags.present ? fromCarry.tags.value : []),
        aliases: n.aliases ?? (fromCarry.aliases.present ? fromCarry.aliases.value : []),
        slug:
          n.slug !== undefined
            ? n.slug || undefined
            : fromCarry.slug.present
              ? fromCarry.slug.value
              : undefined, // #100 phase 1: custom slug only
        summary:
          n.summary !== undefined
            ? n.summary || undefined
            : fromCarry.summary.present
              ? fromCarry.summary.value
              : undefined,
        muted:
          n.muted !== undefined
            ? n.muted || undefined
            : fromCarry.muted.present
              ? fromCarry.muted.value
              : undefined, // #165: only the truthy flag rides
        sourceLocator:
          n.sourceLocator !== undefined
            ? n.sourceLocator
            : fromCarry.sourceLocator.present
              ? fromCarry.sourceLocator.value
              : undefined,
        carried,
      }
      this.assertExportable(candidate)
      next.push(candidate)
      const inferred = legacyNoteNameAlias(candidate.title, candidate.filePath)
      this.legacyNameAliasesById.set(
        candidate.id,
        unionLegacyNameAliases(n.legacyNameAliases ?? [], inferred ? [inferred] : []),
      )
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
    const legacyNameAliases = this.legacyNameAliasesOf(n.id)

    return {
      id: n.id,
      title: n.title,
      class: n.class,
      filePath: n.filePath,
      ...(n.slug ? { slug: n.slug } : {}), // #100 phase 1: custom slug only
      ...(n.aliases.length ? { aliases: n.aliases } : {}),
      ...(legacyNameAliases.length ? { legacyNameAliases } : {}),
      ...(n.tags.length ? { tags: n.tags } : {}),
      ...(n.sourceLocator ? { sourceLocator: n.sourceLocator } : {}),
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

  /** A note as read() serves it. CAS hashes the canonical logical state built
   * from the same reconstructed file shape export uses. */
  private viewOf(n: StoredNote): NoteContent & { id: string; versionToken: string } {
    const content = stripTitleHeading(n.content, n.title)
    // Mirror the real engine's parsed frontmatter: tags plus the agent-memory
    // summary (#21) when present. The version token below hashes the complete
    // logical state, so a metadata-only change is a real CAS change.
    const frontmatter: Record<string, unknown> = {}

    // The author's own keys first (#280) — ours below override, exactly the order
    // serializeNoteFile merges them in, so the same note reads back the same map
    // on both engines. The note's OWN identity and title are never the carry's to
    // state: the real engine's put() replaces them by key, so a carried copy could
    // never win there either.
    for (const e of n.carried ?? []) {
      if (
        !e.key ||
        e.key === 'title' ||
        e.key === NOTE_ID_FRONTMATTER_KEY ||
        e.key === IMPORT_SOURCE_FRONTMATTER_KEY ||
        e.key === CREATED_FALLBACK_FRONTMATTER_KEY
      ) {
        continue
      }
      const v = frontmatterEntryValue(e)

      if (v != null) {
        frontmatter[e.key] = v
      } else {
        // YAML and the importer are last-wins. An unsupported final occurrence
        // must clear a readable earlier projection instead of resurrecting it.
        delete frontmatter[e.key]
      }
    }
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
    if (n.createdAt && n.createdProjected) {
      const created = carriedCreated(n.carried)
      frontmatter[created.conflict ? CREATED_FALLBACK_FRONTMATTER_KEY : 'created'] = n.createdAt
    }

    const logicalState = this.logicalStateOf(n, content)
    const documentState = this.documentStateOf(n)
    const legacyNameAliases = this.legacyNameAliasesOf(n.id)

    return {
      id: n.id,
      title: documentState.projection?.title ?? n.title,
      class: n.class,
      filePath: n.filePath,
      content: documentState.projection?.body ?? content,
      // Fixture typed channels remain the ordinary read projection even when
      // an anchored raw carry cannot be rewritten to match them. The exact
      // byte/source projection remains available on documentState.
      frontmatter,
      ...(n.sourceLocator ? { sourceLocator: n.sourceLocator } : {}),
      logicalState,
      documentState,
      physicalIncarnation: {
        claim: physicalWriteClaimOf(n),
        owner: { kind: 'claimed', id: n.id },
      },
      ...(n.slug ? { slug: n.slug } : {}), // #100 phase 1: custom slug only
      ...(n.aliases.length ? { aliases: n.aliases } : {}),
      ...(legacyNameAliases.length ? { legacyNameAliases } : {}),
      modifiedAt: n.modifiedAt,
      // The resolved creation instant (#186) — what the editor prefills its date
      // field from; mirrors the real engine serving createdAt on the read view.
      createdAt: n.createdAt,
      versionToken: documentStateVersionToken(documentState),
    }
  }

  private legacyNameAliasesOf(id: string): readonly string[] {
    return [...(this.legacyNameAliasesById.get(id) ?? [])]
  }

  private captureLegacyName(n: Pick<StoredNote, 'id' | 'title' | 'filePath'>): readonly string[] {
    const inferred = legacyNoteNameAlias(n.title, n.filePath)
    const aliases = unionLegacyNameAliases(
      this.legacyNameAliasesById.get(n.id) ?? [],
      inferred ? [inferred] : [],
    )

    this.legacyNameAliasesById.set(n.id, aliases)
    return [...aliases]
  }

  private assertExpectedSource(note: StoredNote, expected: MoveInput['expectedSource']): void {
    // Direct engine callers keep the compatibility move surface. The read-model
    // always supplies this proof for destructive effects and the engine then
    // enforces it atomically with its in-memory mutation.
    if (!expected) {
      return
    }
    if (
      expected.claim.kind !== note.physicalWriteClaim.kind ||
      expected.claim.value !== note.physicalWriteClaim.value ||
      expected.owner.kind !== 'claimed' ||
      expected.owner.id !== note.id
    ) {
      throw writeFailed('note changed during conditional effect')
    }
  }

  private logicalStateOf(n: StoredNote, body = stripTitleHeading(n.content, n.title)) {
    const raw = this.fileBytesOf(n)

    return logicalNoteState({
      title: n.title,
      body,
      frontmatter: parseFrontmatterBlock(raw)?.entries ?? [],
    })
  }

  private documentStateOf(n: StoredNote) {
    const fileName = basenameOf(n.filePath)
    const { mount, relativePath } = splitSkillMount(n.filePath)
    const relativePackagePath = skillPackagePathOf(relativePath)
    const packageDirectory = relativePackagePath ? [...mount, relativePackagePath].join('/') : ''
    const skillRoot = isSkillPackageRootNote(n)
    let linkedRoot: StoredNote | undefined

    if (n.class === 'skill' && !skillRoot && packageDirectory) {
      const rootPath = `${packageDirectory}/SKILL.md`
      linkedRoot = this.notes.find(
        (candidate) => candidate.class === 'skill' && candidate.filePath === rootPath,
      )
    }
    const linkedRootIsValid = linkedRoot
      ? analyzeDocumentState({
          source: new TextEncoder().encode(this.fileBytesOf(linkedRoot)),
          role: DOCUMENT_ROLE.skillRoot,
          pathFallbackTitle: 'SKILL',
          skillDirectoryName: basenameOf(packageDirectory),
        }).format === DOCUMENT_STATE_FORMAT.skill
      : false
    const role =
      n.class === 'skill'
        ? skillRoot
          ? DOCUMENT_ROLE.skillRoot
          : linkedRootIsValid
            ? DOCUMENT_ROLE.skillAuxiliary
            : DOCUMENT_ROLE.generic
        : DOCUMENT_ROLE.generic
    const source = new TextEncoder().encode(this.fileBytesOf(n))
    const owners: Array<{
      key: (typeof STORAGE_OWNER_KEY)[keyof typeof STORAGE_OWNER_KEY]
      ownership: 'value' | 'entry'
    }> = []
    const hasYamlNodeReferences = frontmatterHasYamlNodeReferences(n.carried)

    if (!hasYamlNodeReferences) {
      owners.push({
        key: STORAGE_OWNER_KEY.id,
        ownership: carriedEntry(n.carried, NOTE_ID_FRONTMATTER_KEY) ? 'value' : 'entry',
      })
    }
    if (n.createdAt && n.createdProjected) {
      const created = carriedCreated(n.carried)
      const key = created.conflict ? CREATED_FALLBACK_FRONTMATTER_KEY : 'created'

      if (!carriedEntry(n.carried, key)) {
        owners.push({ key: STORAGE_OWNER_KEY.created, ownership: 'entry' })
      }
    }
    let ownerProof

    try {
      ownerProof = bindStorageOwnerProof({
        source,
        owners,
        evidence: {
          kind: 'mutation-receipt',
          id: `${n.physicalWriteClaim.kind}:${n.physicalWriteClaim.value}`,
        },
        generatedContainer: owners.length > 0 && !n.carried?.length,
      })
    } catch {
      // An ambiguous authored target cannot acquire authority by matching the
      // value synthesized by this projection. The analyzer will fail it closed.
      ownerProof = undefined
    }

    return analyzeDocumentState({
      source,
      role,
      pathFallbackTitle: fileName.replace(/\.md$/i, ''),
      ownerProof,
      ...(role === DOCUMENT_ROLE.skillRoot
        ? { skillDirectoryName: basenameOf(directoryOf(n.filePath)) }
        : {}),
    })
  }

  private assertSkillRootAvailable(candidate: StoredNote): void {
    if (!isSkillPackageRootNote(candidate)) {
      return
    }
    const state = this.documentStateOf(candidate)
    const name = state.projection?.skill?.name

    if (state.format !== DOCUMENT_STATE_FORMAT.skill || !name) {
      throw writeFailed('invalid Agent Skill manifest')
    }
    const placement = skillPlacementOf(candidate.filePath)

    for (const sibling of this.notes) {
      if (sibling.id === candidate.id || !isSkillPackageRootNote(sibling)) {
        continue
      }

      if (
        skillPlacementOf(sibling.filePath) === placement &&
        this.documentStateOf(sibling).projection?.skill?.name === name
      ) {
        throw skillNameConflict(name)
      }
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
    // A readable carried entry is still the authored owner of its key. Its typed
    // projection powers list/read/resolution, but must not rewrite the raw YAML on
    // export: besides losing the author's shape, canonical block expansion can
    // turn a compact, valid sub-limit flow collection into an oversized payload.
    // Explicit typed channels already remove their key from `carried`, at which
    // point the canonical projection below becomes the owner and is emitted.
    const isCarried = (key: string): boolean => carriedEntry(n.carried, key) !== undefined
    // Existing external files may contain anchors even though all mutations of
    // them are refused below. Export is read-only and must not delete an anchored
    // system entry: doing so would leave its aliases dangling. Where the raw carry
    // already owns a system key, keep that entry; otherwise fill the key normally.
    const hasYamlNodeReferences = frontmatterHasYamlNodeReferences(n.carried)
    const preservesReferencedKey = (key: string): boolean => hasYamlNodeReferences && isCarried(key)
    // The TYPED fields, collected before anything is emitted — because the carry is
    // then filtered by the keys these actually occupy. That mirrors the real
    // serializer, whose `put` replaces an entry BY KEY: a key we emit must appear
    // once, and a key we do NOT emit (an empty `tags:`, an `aliases:` whose shape
    // carriedTyped could not read) must keep the author's own lines rather than
    // vanish. Deriving the filter from the emitted set — instead of a hand-kept
    // list — is what stops the next typed field from silently reintroducing either
    // a duplicate line or a deletion (#280, both caught in review).
    const typed: Array<{ key: string; lines: string[] }> = []

    if (!isCarried('type') && n.noteType && n.noteType !== DEFAULT_NOTE_TYPE) {
      typed.push({ key: 'type', lines: [`type: ${fmScalar(n.noteType)}`] })
    }
    if (!isCarried('tags') && n.tags.length) {
      typed.push({ key: 'tags', lines: ['tags:', ...n.tags.map((t) => `- ${fmScalar(t)}`)] })
    }
    if (!isCarried('aliases') && n.aliases.length) {
      typed.push({
        key: 'aliases',
        lines: ['aliases:', ...n.aliases.map((a) => `- ${fmScalar(a)}`)],
      })
    }
    if (!isCarried('slug') && n.slug) {
      typed.push({ key: 'slug', lines: [`slug: ${fmScalar(n.slug)}`] })
    }
    if (!isCarried('summary') && n.summary) {
      typed.push({ key: 'summary', lines: [`summary: ${fmScalar(n.summary)}`] })
    }
    if (!isCarried('muted') && n.muted) {
      typed.push({ key: 'muted', lines: ['muted: true'] })
    }
    if (n.createdAt && n.createdProjected) {
      const created = carriedCreated(n.carried)
      const key = created.conflict ? CREATED_FALLBACK_FRONTMATTER_KEY : 'created'

      if (!isCarried(key)) {
        typed.push({ key, lines: [`${key}: ${fmScalar(n.createdAt)}`] })
      }
    }
    // Rebuild by replacing a key in its authored slot, like serializeNoteFile.
    // Pulling all keyless entries to the front changes the logical ordering of
    // comments relative to custom keys and makes the fake disagree with a real
    // external read even before any mutation occurs.
    const entries = (n.carried ?? []).map(cloneEntry)

    const put = (entry: FrontmatterEntry): void => {
      const occupied = entries.flatMap((candidate, index) =>
        candidate.key === entry.key ? [index] : [],
      )

      if (!occupied.length) {
        entries.push(entry)
        return
      }
      entries[occupied[0]] = entry
      for (const index of occupied.slice(1).reverse()) {
        entries.splice(index, 1)
      }
    }

    const system: FrontmatterEntry[] = []

    if (!preservesReferencedKey(NOTE_ID_FRONTMATTER_KEY)) {
      const entry = {
        key: NOTE_ID_FRONTMATTER_KEY,
        lines: [`${NOTE_ID_FRONTMATTER_KEY}: ${n.id}`],
      }

      if (entries.some((candidate) => candidate.key === NOTE_ID_FRONTMATTER_KEY)) {
        put(entry)
      } else {
        system.push(entry)
      }
    }
    if (n.sourceLocator && !isCarried(IMPORT_SOURCE_FRONTMATTER_KEY)) {
      system.push({
        key: IMPORT_SOURCE_FRONTMATTER_KEY,
        lines: [`${IMPORT_SOURCE_FRONTMATTER_KEY}: ${n.sourceLocator}`],
      })
    }
    if (!preservesReferencedKey('title')) {
      const entry = { key: 'title', lines: [`title: ${fmScalar(n.title)}`] }

      if (entries.some((candidate) => candidate.key === 'title')) {
        put(entry)
      } else {
        system.push(entry)
      }
    }
    let systemIndex = 0

    while (entries[systemIndex]?.key === null) {
      systemIndex++
    }
    entries.splice(systemIndex, 0, ...system)
    for (const entry of typed) {
      put(entry)
    }
    const lines = entries.flatMap((entry) => entry.lines)
    const payload = lines.join('\n')

    if (!isWithinFrontmatterByteCap(`${payload}\n`)) {
      throw writeFailed('frontmatter exceeds the 64 KiB limit')
    }
    const head = `---\n${payload}\n---\n\n# ${n.title}\n`
    return body ? `${head}\n${body}` : head
  }

  /** Validate a candidate's complete reconstructed YAML before it can replace
   *  live state. Carry alone may fit the cap while title/id/typed metadata push
   *  the final file over it; export-time rejection would be too late. */
  private assertExportable(n: StoredNote): void {
    this.fileBytesOf(n)
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
    // The fake keeps a note's authored text as given, inline frontmatter included (it has
    // no serializer to fold it in — see the write path below), so this stand's "body" is
    // unparsed and the block is answered for here.
    return derivePreview(stripTitleHeading(stripFrontmatter(n.content), n.title), n.tags)
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
        snippet: makeSnippet(stripTitleHeading(stripFrontmatter(n.content), n.title), 160),
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
   *  optimistic (#50): the caller's versionToken must match the live logical state or
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
    frontmatter,
    frontmatterMode,
    preservePath,
    preserveAliases,
    restorePath,
    expectedSource,
    expectedDestinationId,
    sourceLocator,
  }: WriteInput): Promise<WriteResult> {
    const replacing = frontmatterMode === 'replace'
    const scalarInputs = [
      title,
      directory,
      noteType,
      rawSlug,
      summary,
      fileName,
      createdAt,
      sourceLocator,
    ]
    const tagInputs = Array.isArray(tags) ? tags : tags != null ? [tags] : []

    if (
      scalarInputs.some((value) => value != null && !isDurableScalar(value)) ||
      tagInputs.some((value) => !isDurableScalar(value)) ||
      !isDurableText(content) ||
      !isDurableFrontmatter(frontmatter) ||
      (restorePath != null &&
        (!isDurableText(restorePath) ||
          !isCanonicalInternalRelativeAddress(restorePath) ||
          !restorePath.endsWith('.md'))) ||
      (id != null && !isValidNoteId(id)) ||
      (originalId != null &&
        !isValidNoteId(originalId) &&
        decodeWikilinkIdentity(originalId) == null) ||
      (sourceLocator != null && !isImportNoteSourceLocator(sourceLocator))
    ) {
      throw writeFailed('input contains an invalid durable string')
    }
    const requestedDirectory = restorePath ? directoryOf(restorePath) : (directory ?? '')
    const validDirectory = restorePath
      ? true
      : legacyImportRoot !== undefined
        ? !originalId &&
          Boolean(fileName) &&
          isLegacyImportDestination(requestedDirectory, legacyImportRoot, (prefix) =>
            this.dirs.has(prefix),
          )
        : isPortableRelativeDestination(requestedDirectory, (prefix) => this.dirs.has(prefix))

    if (!validDirectory) {
      throw writeFailed('directory must be safe with portable new components')
    }
    // Keep this lazy: collision and CAS errors are the caller's primary contract
    // and must win before the semantic frontmatter refusal. The real serializer
    // also treats a leading frontmatter block in `body` as incoming metadata, so
    // the fake must reject references there even though it need not implement the
    // real engine's general inline-frontmatter merge for this safety fence.
    const incomingHasYamlNodeReferences = (): boolean =>
      (!replacing && frontmatterHasYamlNodeReferences(frontmatter)) ||
      (!replacing && frontmatterHasYamlNodeReferences(parseFrontmatterBlock(content)?.entries))
    // Carry-forward semantics matching the real engine's serializeNoteFile: an
    // UNDEFINED field leaves the note's existing value untouched (the semantic
    // ops re-send what they read, #21 — a write that omitted them would wrongly
    // clear them); a provided value sets it. `tags: []` still clears (an explicit
    // empty), and `summary: ''` clears too — mirroring serializeNoteFile's
    // drop-on-empty so the two engines read back identically.
    const summaryFor = (
      prev: string | undefined,
      carried: ReturnType<typeof carriedTyped>,
    ): string | undefined =>
      summary !== undefined
        ? summary || undefined
        : carried.summary.present
          ? carried.summary.value
          : prev
    // The muted opt-out (#165), tags/summary-parity: undefined carries the note's
    // existing flag forward (a write that omitted it would wrongly un-mute), true
    // sets it, false clears it (an explicit un-mute drops the frontmatter entry).
    const mutedFor = (
      prev: boolean | undefined,
      carried: ReturnType<typeof carriedTyped>,
    ): boolean | undefined =>
      muted !== undefined ? muted || undefined : carried.muted.present ? carried.muted.value : prev

    const createdAtFor = (
      prev: string | null,
      carried: ReturnType<typeof carriedTyped>,
    ): string | null =>
      createdAt !== undefined
        ? createdAt
        : carried.createdAt.present
          ? (carried.createdAt.value ?? prev)
          : prev

    const incomingFrontmatter = replacing
      ? frontmatter
      : withoutCarriedKey(frontmatter?.map(cloneEntry), IMPORT_SOURCE_FRONTMATTER_KEY)

    const carriedStateFor = (prev: FrontmatterEntry[] | undefined) => {
      const merged = replacing
        ? incomingFrontmatter?.map(cloneEntry)
        : mergeCarried(prev, incomingFrontmatter)
      return { merged, typed: carriedTyped(merged) }
    }
    const sourceLocatorFor = (
      prev: string | undefined,
      carried: ReturnType<typeof carriedTyped>,
    ): string | undefined =>
      sourceLocator !== undefined
        ? sourceLocator
        : replacing
          ? carried.sourceLocator.present
            ? carried.sourceLocator.value
            : undefined
          : prev
    const preserveIncomingUnreadableCreated =
      createdAt !== undefined && carriedCreated(frontmatter).conflict

    const createdProjectionFor = (previous: boolean): boolean => {
      if (createdAt !== undefined) {
        return true
      }
      // An incoming raw date replaces an earlier typed date exactly as it does in
      // the real serializer. It remains byte-lines in carry; canonical projection
      // resumes only after a later explicit createdAt write.
      if (frontmatter !== undefined && carriedCreated(frontmatter).present) {
        return false
      }

      if (replacing) {
        return false
      }

      return previous
    }

    const carriedAfterTypedChannels = (
      merged: FrontmatterEntry[] | undefined,
      aliasesOwned: boolean,
    ): FrontmatterEntry[] | undefined => {
      let carried = merged

      // The real serializer's typed puts/drops happen LAST. Once one replaced a
      // carried key, the old raw entry is gone from the file and must not lurk in
      // the fake only to reappear after a later clear.
      if (noteType !== undefined) {
        carried = withoutCarriedKey(carried, 'type')
      }
      if (tags !== undefined) {
        carried = withoutCarriedKey(carried, 'tags')
      }
      if (rawSlug !== undefined) {
        carried = withoutCarriedKey(carried, 'slug')
      }
      if (aliasesOwned) {
        carried = withoutCarriedKey(carried, 'aliases')
      }
      if (summary !== undefined) {
        carried = withoutCarriedKey(carried, 'summary')
      }
      if (muted !== undefined) {
        carried = withoutCarriedKey(carried, 'muted')
      }
      if (createdAt !== undefined) {
        if (!preserveIncomingUnreadableCreated) {
          carried = withoutCarriedKey(carried, 'created')
        }
        carried = withoutCarriedKey(carried, CREATED_FALLBACK_FRONTMATTER_KEY)
      }
      if (sourceLocator !== undefined) {
        carried = withoutCarriedKey(carried, IMPORT_SOURCE_FRONTMATTER_KEY)
      }

      return carried
    }
    const noteTypeFor = (prev: string, carried: ReturnType<typeof carriedTyped>): string =>
      noteType !== undefined
        ? noteType && noteType !== DEFAULT_NOTE_TYPE
          ? noteType
          : DEFAULT_NOTE_TYPE
        : carried.noteType.present
          ? carried.noteType.value
          : prev
    const tagsFor = (prev: string[], carried: ReturnType<typeof carriedTyped>): string[] =>
      tags !== undefined ? (normTags(tags) ?? []) : carried.tags.present ? carried.tags.value : prev

    const slugFor = (
      prev: string | undefined,
      carried: ReturnType<typeof carriedTyped>,
    ): string | undefined => {
      const channel = storedSlug(rawSlug, title)
      return channel !== undefined
        ? channel || undefined
        : carried.slug.present
          ? carried.slug.value
          : prev
    }
    const aliasesFor = (prev: string[], carried: ReturnType<typeof carriedTyped>): string[] =>
      carried.aliases.present ? carried.aliases.value : prev
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
    const tokenOf = (n: StoredNote) => documentStateVersionToken(this.documentStateOf(n))

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
      this.assertExpectedSource(this.notes[i], expectedSource)
      // No directory given (the restore/edit path) → keep the note in its
      // CURRENT folder; an explicit directory moves it. The path changes, the id
      // does NOT (P7).
      const dir = directory === undefined ? directoryOf(this.notes[i].filePath) : norm(directory)
      const prev = this.notes[i]
      const legacyNameAliases = this.captureLegacyName(prev)
      // An explicit fileName is honoured on edit too (opt-in): a metadata touch that
      // hands the note's current basename keeps the file in place rather than renaming
      // to slug(title) — mirrors the notarium engine. Folder pages stay `index`.
      const fileBase = isFolderPageNote(prev.filePath) ? FOLDER_PAGE_BASENAME : fileName
      const preserveCurrentPath =
        preservePath ||
        isSkillPackageRootNote(prev) ||
        (title === prev.title && fileName == null && dir === directoryOf(prev.filePath))
      const filePath = restorePath
        ? restorePath
        : preserveCurrentPath
          ? prev.filePath
          : fileIn(dir, title, fileBase, prev.id)

      // Rename-in-place must never swallow a different note already at the
      // destination — the real engine's guard, mirrored so the fake can't pass a
      // scenario production refuses. canon: docs/note-model.md#create-collisions
      if (filePath !== prev.filePath && this.indexByPath(filePath) !== -1) {
        throw moveFailed('a note already lives at the destination')
      }
      if (
        incomingHasYamlNodeReferences() ||
        (!replacing && frontmatterHasYamlNodeReferences(prev.carried))
      ) {
        throw new Error(YAML_NODE_REFERENCE_WRITE_ERROR)
      }
      const carriedState = carriedStateFor(prev.carried)
      const newSlug = slugFor(replacing ? undefined : prev.slug, carriedState.typed)
      // Alias-history (#100): a title OR slug change records the old name(s) so
      // inbound [[Old Title]] / [[old-slug]] keep resolving — mirrors the real
      // engine's write() (effective-slug comparison; nextAliasesMulti dedups).
      const prevEffSlug = effectiveSlug(prev.slug, prev.title)
      // A raw carried slug is re-read only AFTER the real serializer has made its
      // alias-history decision. Only the explicit slug channel participates in
      // that decision; the final stored projection still comes from the carry.
      const slugChannel = storedSlug(rawSlug, title)
      const renameSlug = slugChannel === undefined ? prev.slug : newSlug
      const newEffSlug = effectiveSlug(renameSlug, title)
      const renamed = !preserveAliases && (prev.title !== title || prevEffSlug !== newEffSlug)
      const nextAliases = replacing
        ? aliasesFor([], carriedState.typed)
        : renamed
          ? nextAliasesMulti(prev.aliases, [prev.title, prevEffSlug], [title, newEffSlug])
          : aliasesFor(prev.aliases, carriedState.typed)
      const candidate: StoredNote = {
        ...prev,
        physicalWriteClaim: nextPhysicalWriteClaim(),
        title,
        content,
        noteType: noteTypeFor(replacing ? DEFAULT_NOTE_TYPE : prev.noteType, carriedState.typed),
        tags: tagsFor(replacing ? [] : prev.tags, carriedState.typed),
        aliases: nextAliases,
        slug: newSlug,
        summary: summaryFor(replacing ? undefined : prev.summary, carriedState.typed),
        muted: mutedFor(replacing ? undefined : prev.muted, carriedState.typed),
        sourceLocator: sourceLocatorFor(
          replacing ? undefined : prev.sourceLocator,
          carriedState.typed,
        ),
        carried: carriedAfterTypedChannels(carriedState.merged, !replacing && renamed),
        filePath,
        modifiedAt: this.nowIso,
        // Authored date edit (#186): a provided `createdAt` overwrites; undefined
        // keeps the note's existing birth date (carry-forward, mirrors the real
        // engine's serializeNoteFile SET-on-provided). `modified` always stamps now.
        createdAt: createdAtFor(prev.createdAt, carriedState.typed),
        createdProjected: createdProjectionFor(prev.createdProjected),
      }
      this.assertSkillRootAvailable(candidate)
      this.assertExportable(candidate)
      this.notes[i] = candidate
      this.addDirs(filePath) // a folder change seeds the new dir (#97); the old lingers
      return {
        id: this.notes[i].id,
        filePath,
        class: this.notes[i].class,
        versionToken: tokenOf(this.notes[i]),
        physicalWriteClaim: physicalWriteClaimOf(this.notes[i]),
        legacyNameAliases,
      }
    }
    // Identity is settled BEFORE the path here, because the last rung of the path
    // formula is the id itself (#296): deriving the id from the final path would be
    // circular for a title with nothing sluggable in it. The id keeps riding on the
    // path the TITLE alone implies — identical for every ordinary note, so seeded and
    // e2e-hardcoded ids are untouched.
    const createDir = norm(requestedDirectory)
    const newId =
      id ||
      this.deriveId(
        (createDir ? `${createDir}/` : '') + `${sluggedNoteName(title, fileName) || 'note'}.md`,
      )
    const filePath = restorePath ?? fileIn(createDir, title, fileName, newId)
    const existing = this.indexByPath(filePath)

    // The planned-destination guard, mirroring notariumStore — including its
    // position: it runs BEFORE the collision policy, so a `skipExisting` import
    // still proves whose note it is skipping instead of assuming. And including its
    // RULE: refuse when the destination's observed owner CONTRADICTS the expected
    // one. The engines differ only in how much their medium can observe — a note
    // here always carries its id, so `occupantId` is never the "states nothing"
    // that a claim-less markdown file is, and the null branch below is only
    // reachable as "nobody is standing here at all".
    if (expectedDestinationId !== undefined) {
      const occupantId = existing === -1 ? null : this.notes[existing].id

      if (expectedDestinationId === null) {
        if (existing !== -1 && occupantId !== newId) {
          throw destinationOwnerConflict(
            filePath,
            `is owned by ${occupantId}; the import planned to create it`,
          )
        }
      } else if (existing === -1) {
        throw destinationOwnerConflict(filePath, 'no longer exists')
      } else if (occupantId !== expectedDestinationId) {
        // No "states nothing" branch to spare here, unlike the file engine: past
        // this point a note IS standing on the path, and every note this engine
        // holds carries an id.
        throw destinationOwnerConflict(
          filePath,
          `is owned by ${occupantId}, not ${expectedDestinationId}`,
        )
      }
    }
    // Create-collision policy, mirroring notariumStore: refuse unless the caller
    // explicitly asked to clobber. canon: docs/note-model.md#create-collisions
    if (existing !== -1 && ifExists !== IF_EXISTS.overwrite) {
      throw noteAlreadyExists(title)
    }
    if (incomingHasYamlNodeReferences()) {
      throw new Error(YAML_NODE_REFERENCE_WRITE_ERROR)
    }
    if (existing !== -1) {
      const prev = this.notes[existing]
      const legacyNameAliases = this.captureLegacyName(prev)

      if (!replacing && frontmatterHasYamlNodeReferences(prev.carried)) {
        throw new Error(YAML_NODE_REFERENCE_WRITE_ERROR)
      }
      const carriedState = carriedStateFor(prev.carried)
      const candidate: StoredNote = {
        ...prev,
        physicalWriteClaim: nextPhysicalWriteClaim(),
        title,
        content,
        noteType: noteTypeFor(replacing ? DEFAULT_NOTE_TYPE : prev.noteType, carriedState.typed),
        tags: tagsFor(replacing ? [] : prev.tags, carriedState.typed),
        aliases: aliasesFor(replacing ? [] : prev.aliases, carriedState.typed),
        slug: slugFor(replacing ? undefined : prev.slug, carriedState.typed),
        summary: summaryFor(replacing ? undefined : prev.summary, carriedState.typed),
        muted: mutedFor(replacing ? undefined : prev.muted, carriedState.typed),
        sourceLocator: sourceLocatorFor(
          replacing ? undefined : prev.sourceLocator,
          carriedState.typed,
        ),
        carried: carriedAfterTypedChannels(carriedState.merged, false),
        createdAt: createdAtFor(prev.createdAt, carriedState.typed),
        createdProjected: createdProjectionFor(prev.createdProjected),
        modifiedAt: this.nowIso,
      }
      this.assertSkillRootAvailable(candidate)
      this.assertExportable(candidate)
      this.notes[existing] = candidate
      return {
        id: this.notes[existing].id,
        filePath,
        class: this.notes[existing].class,
        versionToken: tokenOf(this.notes[existing]),
        physicalWriteClaim: physicalWriteClaimOf(this.notes[existing]),
        legacyNameAliases,
      }
    }
    const carriedState = carriedStateFor(undefined)
    const fresh: StoredNote = {
      id: newId,
      title,
      // Class is enforced from the target mount (#78): a create takes the
      // selector the tool zashivaet (#21), default user-doc; edits keep theirs.
      class: targetClass ?? 'user-doc',
      filePath,
      content,
      noteType: noteTypeFor(DEFAULT_NOTE_TYPE, carriedState.typed),
      tags: tagsFor([], carriedState.typed),
      // An imported file's own `aliases:`/`slug:` are live from the first write —
      // the real engine gets that by re-reading the file, the fake derives it here.
      aliases: aliasesFor([], carriedState.typed),
      slug: slugFor(undefined, carriedState.typed),
      summary: summaryFor(undefined, carriedState.typed),
      muted: mutedFor(undefined, carriedState.typed),
      sourceLocator: sourceLocatorFor(undefined, carriedState.typed),
      carried: carriedAfterTypedChannels(carriedState.merged, false),
      // Dates-as-data (#11): an import threads the original `createdAt` (the real
      // engine's `created:`-over-birthtime rule); `modified` always stamps now.
      modifiedAt: this.nowIso,
      createdAt: createdAtFor(null, carriedState.typed) ?? this.nowIso,
      createdProjected: createdAt !== undefined,
      physicalWriteClaim: nextPhysicalWriteClaim(),
    }
    this.assertSkillRootAvailable(fresh)
    this.assertExportable(fresh)
    this.notes.push(fresh)
    const legacyNameAliases = this.captureLegacyName(fresh)
    this.addDirs(filePath) // seed the note's folder into the directory channel (#97)
    return {
      id: newId,
      filePath,
      class: fresh.class,
      versionToken: tokenOf(fresh),
      physicalWriteClaim: physicalWriteClaimOf(fresh),
      legacyNameAliases,
    }
  }

  /** Move a note or a folder subtree. A failed move throws the same
   *  "# Move Failed" tool-error a bare engine surfaces (#6/#8). */
  async move({
    id,
    destinationPath,
    isDirectory = false,
    identityOnly,
    expectedSource,
  }: MoveInput): Promise<MoveResult> {
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
          this.captureLegacyName(n)
          n.filePath = destinationPath + n.filePath.slice(src.length)
          n.modifiedAt = this.nowIso
          n.physicalWriteClaim = nextPhysicalWriteClaim()
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

      return {}
    }
    const i = this.findIndex(id, identityOnly)

    if (i === -1) {
      throw moveFailed('note not found')
    }
    if (this.notes.some((n, j) => j !== i && n.filePath === destinationPath)) {
      throw moveFailed('a note already lives at the destination')
    }
    this.assertExpectedSource(this.notes[i], expectedSource)
    const legacyNameAliases = this.captureLegacyName(this.notes[i])
    this.notes[i].filePath = destinationPath
    this.notes[i].modifiedAt = this.nowIso
    this.notes[i].physicalWriteClaim = nextPhysicalWriteClaim()
    this.addDirs(destinationPath) // seed the new folder; the old lingers (#97)
    return {
      id: this.notes[i].id,
      filePath: destinationPath,
      versionToken: documentStateVersionToken(this.documentStateOf(this.notes[i])),
      legacyNameAliases,
    }
  }

  async remove(
    rawId: string,
    opts?: {
      identityOnly?: boolean
      versionToken?: string
      physicalWriteClaim?: PhysicalWriteClaim
      expectedSource?: MoveInput['expectedSource']
    },
  ): Promise<void> {
    const i = this.findIndex(rawId, opts?.identityOnly)

    if (i !== -1) {
      if (opts?.expectedSource) {
        this.assertExpectedSource(this.notes[i], opts.expectedSource)
      }
      if (
        opts?.physicalWriteClaim &&
        (opts.physicalWriteClaim.kind !== this.notes[i].physicalWriteClaim.kind ||
          opts.physicalWriteClaim.value !== this.notes[i].physicalWriteClaim.value)
      ) {
        throw writeFailed('note changed during delete')
      }
      if (
        opts?.versionToken &&
        documentStateVersionToken(this.documentStateOf(this.notes[i])) !== opts.versionToken
      ) {
        throw writeFailed('note changed during delete')
      }
      this.captureLegacyName(this.notes[i])
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

  async removeDir(path: string, opts?: MutationOptions): Promise<void> {
    if (
      !(opts?.internalAddress
        ? isCanonicalInternalRelativeAddress(path)
        : isCanonicalSafeRelativeAddress(path))
    ) {
      throw moveFailed('folder path contains an invalid durable string')
    }
    const clean = path.replace(/^\/+|\/+$/g, '')

    if (!clean) {
      return
    }
    const before = this.notes
    await opts?.beforeDetach?.()
    this.notes = this.notes.filter(
      (n) => n.filePath !== clean && !n.filePath.startsWith(clean + '/'),
    )
    try {
      await opts?.afterDetach?.()
      for (const d of [...this.dirs]) {
        if (d === clean || d.startsWith(clean + '/')) {
          this.dirs.delete(d)
        }
      }
    } catch (error) {
      this.notes = before
      throw error
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
