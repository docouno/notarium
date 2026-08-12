import type {
  AgentWriteAttribution,
  ExistingNote,
  MoveInput,
  MutationOptions,
  NoteClass,
  NoteContent,
  TagMutationInput,
  TagMutationResult,
  WriteInput,
  WriteResult,
} from '../../../knowledgeStore'
import {
  noteAlreadyExists,
  noteNotFound,
  StoreError,
  versionConflict,
  versionTokenRequired,
} from '../../../knowledgeStore'
import { IF_EXISTS, REVISION_KIND, STORE_ERROR_REASON } from '../../../knowledgeStore'
import { nextAliasesMulti, normAliases } from '../../../libs/aliases'
import { freshNoteId, isDurableScalar, isDurableText, isValidNoteId } from '../../../libs/id'
import {
  encodeWikilinkIdentity,
  frontmatterEntryOf,
  frontmatterEntryValue,
  isDurableFrontmatter,
  promoteBodyTitle,
  stripFrontmatter,
  stripTitleHeading,
} from '../../../libs/markdown'
import { MutationCoordinator } from '../../../libs/mutationCoordinator'
import {
  basenameOf,
  directoryOf,
  FOLDER_PAGE_BASENAME,
  isCanonicalSafeRelativeAddress,
  isFolderPageNote,
  isLegacyImportDestination,
  isPortableMoveDestination,
  isPortableRelativeDestination,
  noteFilePath,
  sluggedNoteName,
} from '../../../libs/path'
import { effectiveSlug, slugify, storedSlug } from '../../../libs/slug'
import { normTags } from '../../../libs/tags'
import { computeVersionToken } from '../../../libs/versionToken'
import { derivePreview } from '../../../snippet'
import { DEFAULT_NOTE_CLASS, isVisibleOn, SURFACE } from '../../../visibility'
import { TRASH_MUTATION_PREFIX, trashMutationPath } from '../../consts'
import { supportsExactIdentityAddress } from '../innerIdentity'
import type { WriteHost } from './types'

/** Normalise an authored createdAt to the canonical ISO instant the engine
 *  indexes, or undefined when absent/unparseable. Undefined means "leave the existing
 *  date alone" — the three-state carry-forward the lax MCP create channel needs. */
const normAuthoredDate = (v?: string): string | undefined => {
  if (!v) {
    return undefined
  }
  const t = Date.parse(v)
  return Number.isNaN(t) ? undefined : new Date(t).toISOString()
}

/** How far `uniquify` will count before giving up and surfacing the collision. A
 *  folder holding fifty "Plans N" is a user problem, not a naming one. */
const UNIQUIFY_LIMIT = 50

const isCollision = (err: unknown): boolean =>
  (err as { reason?: string }).reason === STORE_ERROR_REASON.noteAlreadyExists

const folderFailed = (detail: string): StoreError => {
  const err = new StoreError(`# Folder Failed: ${detail}`)
  err.isToolError = true
  return err
}

const invalidWrite = (detail: string): StoreError => {
  const err = new StoreError(`# Write Failed: ${detail}`)
  err.isToolError = true
  return err
}

const assertWriteText = (input: WriteInput): void => {
  const scalars: Array<[string, string | undefined]> = [
    ['title', input.title],
    ['directory', input.directory],
    ['note type', input.noteType],
    ['slug', input.slug],
    ['summary', input.summary],
    ['file name', input.fileName],
    ['created date', input.createdAt],
  ]

  for (const [name, value] of scalars) {
    if (value != null && !isDurableScalar(value)) {
      throw invalidWrite(`${name} must be a well-formed single-line string`)
    }
  }
  for (const value of Array.isArray(input.tags)
    ? input.tags
    : input.tags != null
      ? [input.tags]
      : []) {
    if (!isDurableScalar(value)) {
      throw invalidWrite('tags must be well-formed single-line strings')
    }
  }
  if (input.content != null && !isDurableText(input.content)) {
    throw invalidWrite('content contains invalid Unicode or control characters')
  }
  if (input.frontmatter != null && !isDurableFrontmatter(input.frontmatter)) {
    throw invalidWrite('frontmatter contains invalid raw lines')
  }
  for (const [name, value] of [
    ['id', input.id],
    ['original id', input.originalId],
  ] as const) {
    if (value != null && !isValidNoteId(value)) {
      throw invalidWrite(`${name} must be a non-empty durable scalar`)
    }
  }
}

// Link-dependency claims use a path/prefix pair: deleting a target owns the prefix,
// while each source write owns one child path. Therefore a delete conflicts with
// every new inbound edge, but two independent sources linking the same popular note
// remain parallel. The NUL namespace cannot collide with a valid storage path; the
// length prefix + terminal NUL make arbitrary opaque ids/components unambiguous
// without lossy encoding and keep MutationCoordinator's slash trim from changing them.
const linkTargetPrefix = (targetId: string): string =>
  `\u0000graph-target/${targetId.length}:${targetId}\u0000`
const linkTargetPath = (targetId: string, sourceKey: string): string =>
  `${linkTargetPrefix(targetId)}/${sourceKey.length}:${sourceKey}\u0000`

/** The read-model write path: the ONE chokepoint every mutation funnels
 *  through (REST/MCP/import/e2e fake) — title-as-projection, soft-slug, fair id/path/prefix
 *  serialization, the optimistic snapshot mirror (applyWrite/applyNoteMove/applyDirMove),
 *  the journal write, and remove/trash tombstoning. Operates on the read-model state +
 *  collaborators via {@link WriteHost}.
 *  @see docs/core.md#write-through */
export class WriteEngine {
  private readonly mutations: MutationCoordinator
  private readonly trashMutations: MutationCoordinator

  constructor(
    private readonly host: WriteHost,
    coordinators: { mutations?: MutationCoordinator; trashMutations?: MutationCoordinator } = {},
  ) {
    this.mutations = coordinators.mutations ?? new MutationCoordinator()
    this.trashMutations = coordinators.trashMutations ?? new MutationCoordinator()
  }

  /** Apply an exact tag delta under the same note/path claim as ordinary writes.
   * The live read and the inner write both happen inside this method's one claim;
   * callers must not wrap it in another store mutation. */
  mutateTags(input: TagMutationInput): Promise<TagMutationResult> {
    const add = [...new Set(input.add ?? [])]
    const remove = new Set(input.remove ?? [])

    for (const tag of [...add, ...remove]) {
      if (!isDurableScalar(tag)) {
        throw invalidWrite('tags must be well-formed single-line strings')
      }
    }

    return this.mutations.runStable(
      () => ({ noteIds: [input.id], paths: [this.pathFor(input.id)] }),
      async () => {
        const storagePath = this.pathFor(input.id)

        if (!storagePath) {
          throw noteNotFound(input.id)
        }
        const live = await this.host.inner.read(
          this.innerNoteKey(input.id, storagePath),
          supportsExactIdentityAddress(this.host.inner) ? { identityOnly: true } : undefined,
        )

        if (live.filePath !== storagePath) {
          throw noteNotFound(input.id)
        }
        const current = (normTags(live.frontmatter?.tags) ?? []).filter(
          (tag): tag is string => typeof tag === 'string',
        )
        const addSet = new Set(add)
        const seenAdded = new Set<string>()
        const tags = current.filter((tag) => {
          if (remove.has(tag)) {
            return false
          }
          if (!addSet.has(tag)) {
            return true
          }
          if (seenAdded.has(tag)) {
            return false
          }
          seenAdded.add(tag)
          return true
        })

        for (const tag of add) {
          if (!remove.has(tag) && !seenAdded.has(tag)) {
            tags.push(tag)
            seenAdded.add(tag)
          }
        }
        if (tags.length === current.length && tags.every((tag, index) => tag === current[index])) {
          return { changed: false, tags }
        }

        await this.writeClaimed({
          title: live.title ?? '',
          content: live.content,
          originalId: live.id ?? input.id,
          versionToken: live.versionToken ?? computeVersionToken(live.content),
          tags,
          principal: input.principal,
          agent: input.agent,
          fileName: basenameOf(storagePath).replace(/\.md$/, ''),
        })
        return { changed: true, tags }
      },
    )
  }

  /** Soft slug uniqueness: when a save sets a CUSTOM slug, keep public
   *  `/n/<id>/<slug>` URLs clean by suffixing -2/-3… if another LIVE note already
   *  resolves to that slug in this space. NOT required for correctness — the id
   *  resolves regardless; this is tidiness only. Snapshot-based (no derived index,
   *  the precedent). Passes `undefined` (leave) / `''` (clear) straight through. */
  private uniqueSlug(input: WriteInput): string | undefined {
    const stored = storedSlug(input.slug, input.title)

    if (!stored) {
      return input.slug
    }
    const taken = (s: string): boolean => {
      for (const [otherId, m] of this.host.snap.notes) {
        if (otherId === input.originalId) {
          continue
        } // the note being edited isn't a rival
        if (effectiveSlug(m.slug, m.title) === s) {
          return true
        }
      }

      return false
    }

    if (!taken(stored)) {
      return stored
    }
    for (let i = 2; ; i++) {
      const cand = `${stored}-${i}`

      if (!taken(cand)) {
        return cand
      }
    }
  }

  async write(input: WriteInput, opts?: MutationOptions): Promise<WriteResult> {
    // Title is a PROJECTION of the body: derive it and peel the leading title line off, so
    // the stored body never carries a duplicate `# title`. An explicit title wins; a content-less
    // write keeps its body untouched.
    {
      const promoted = promoteBodyTitle(input.content ?? '', input.title)
      input =
        input.content !== undefined
          ? { ...input, title: promoted.title, content: promoted.body }
          : { ...input, title: promoted.title }
    }
    assertWriteText(input)
    const directory = input.directory ?? ''
    const legacyImport = input.legacyImportRoot !== undefined
    const validDirectory = legacyImport
      ? !input.originalId &&
        Boolean(input.fileName) &&
        isLegacyImportDestination(directory, input.legacyImportRoot!, (prefix) =>
          this.host.dirs.has(prefix),
        )
      : isPortableRelativeDestination(directory, (prefix) => this.host.dirs.has(prefix))

    if (!validDirectory) {
      throw invalidWrite('directory must be a safe path with portable new components')
    }

    // A create whose name slugs to nothing (an emoji-only title) is named after the
    // NOTE — so its id has to exist before anything predicts its path (#296). Minted
    // here, once: the fence, the occupancy pre-check and both engines then agree on
    // the destination. Leaving it to `writeClaimed` would predict `note.md`, and
    // `identity.idFor` on that path would hand the newcomer the id of a note actually
    // titled "Note" — the very identity theft #274 closed.
    if (!input.originalId && !input.id && !sluggedNoteName(input.title, input.fileName)) {
      input = { ...input, id: freshNoteId() }
    }

    return input.ifExists === IF_EXISTS.uniquify && !input.originalId
      ? this.writeUniquified(input, opts)
      : this.writeOnce(input, opts)
  }

  private writeOnce(input: WriteInput, opts?: MutationOptions): Promise<WriteResult> {
    return this.mutations.runStable(
      () => this.writeClaim(input),
      async () => {
        await opts?.prepare?.()
        const result = await this.writeClaimed(input)
        await opts?.finalize?.()
        return result
      },
    )
  }

  /** `uniquify`: land beside the occupant under the next free name instead of
   *  refusing. The name is picked from the snapshot BEFORE the fence so the
   *  mutation claims the path it will really write; the engine's own refusal is
   *  still the arbiter (it sees disk truth, including files the index never
   *  indexed), and each retry re-claims from scratch. A retry re-enters the whole
   *  checkpoint, so `opts.prepare` runs once per attempt — this policy is for plain
   *  creates, not for one carrying an effectful preparation. */
  /** The `<name>`, `<name> 2`, `<name> 3` … series a uniquify create walks. The name
   *  that drives the destination FILE is counted: an explicit fileName pins the
   *  basename, so counting the title would re-derive the same path forever. */
  private nameSeries(input: WriteInput): (n: number) => WriteInput {
    const pinned = Boolean(input.fileName)
    const base = pinned ? input.fileName! : input.title

    return (n: number): WriteInput => {
      const name = n === 1 ? base : `${base} ${n}`
      return pinned ? { ...input, fileName: name } : { ...input, title: name }
    }
  }

  private async writeUniquified(input: WriteInput, opts?: MutationOptions): Promise<WriteResult> {
    const nth = this.nameSeries(input)

    for (
      let n = this.firstFreeName(nth, 1);
      n <= UNIQUIFY_LIMIT;
      n = this.firstFreeName(nth, n + 1)
    ) {
      try {
        return await this.writeOnce(nth(n), opts)
      } catch (err) {
        if (!isCollision(err)) {
          throw err
        }
      }
    }

    // The series ran out. Name the occupant of the destination the caller ASKED for —
    // it is what the caller can still act on, and dropping it would leave a second
    // refusal poorer than the first. No suggestion rides along: there is none, and its
    // absence beside a named occupant is how a caller tells "stop offering this".
    throw noteAlreadyExists(input.title, {
      existing: this.occupantOf(this.predictedPath(nth(1)), input.id),
    })
  }

  /** The title a uniquify retry of this refused create would land on — a preview for
   *  the caller's offer. Undefined when the basename is pinned (the title would not
   *  move, so there is nothing to name) or the whole series is taken. */
  private suggestedTitleFor(input: WriteInput): string | undefined {
    if (input.fileName) {
      return undefined
    }
    const nth = this.nameSeries(input)
    const n = this.firstFreeName(nth, 2)

    return n <= UNIQUIFY_LIMIT ? nth(n).title : undefined
  }

  /** The lowest `n >= from` whose destination no LIVE snapshot note occupies. */
  private firstFreeName(nth: (n: number) => WriteInput, from: number): number {
    for (let n = from; n <= UNIQUIFY_LIMIT; n++) {
      if (!this.occupantOf(this.predictedPath(nth(n)))) {
        return n
      }
    }

    return UNIQUIFY_LIMIT + 1
  }

  /** The note already living at a create's destination, or undefined. Snapshot-only:
   *  an unindexed file on disk is the engine's to catch. */
  private occupantOf(path: string, exceptId?: string): ExistingNote | undefined {
    for (const [id, meta] of this.host.snap.notes) {
      if (meta.filePath === path && id !== exceptId) {
        return { id, title: meta.title, filePath: meta.filePath }
      }
    }

    return undefined
  }

  private writeClaim(input: WriteInput) {
    const currentPath = input.originalId ? this.pathFor(input.originalId) : undefined
    const predictedPath = this.predictedPath(input, currentPath)
    const sourceClass = input.originalId
      ? this.host.snap.notes.get(input.originalId)?.class
      : (input.targetClass ?? DEFAULT_NOTE_CLASS)
    const linkedTargetIds =
      input.content !== undefined && isVisibleOn(SURFACE.graph, sourceClass ?? DEFAULT_NOTE_CLASS)
        ? this.host.snap.resolvedTargetIds(input.content)
        : []
    const sourceKey = input.originalId ?? input.id ?? predictedPath
    const destinationDirectory = directoryOf(predictedPath)

    if (
      destinationDirectory &&
      isVisibleOn(SURFACE.graph, sourceClass ?? DEFAULT_NOTE_CLASS) &&
      !this.host.dirs.has(destinationDirectory)
    ) {
      return { global: true }
    }

    return {
      noteIds: [input.originalId, input.id, this.host.identity.idFor(predictedPath)],
      paths: [
        currentPath,
        predictedPath,
        ...linkedTargetIds.map((targetId) => linkTargetPath(targetId, sourceKey)),
      ],
    }
  }

  private async writeClaimed(rawInput: WriteInput): Promise<WriteResult> {
    // Slug selection reads the snapshot, so it belongs inside the mutation
    // checkpoint with path selection and the physical write.
    const input = { ...rawInput, slug: this.uniqueSlug(rawInput) }
    const currentPath = input.originalId ? this.pathFor(input.originalId) : undefined
    const predictedPath = this.predictedPath(input, currentPath)

    if (!input.originalId && input.ifExists !== IF_EXISTS.overwrite) {
      const occupant = this.occupantOf(predictedPath, input.id)

      // Read-model truth, ahead of the engine's own disk check: only here is the
      // occupant's IDENTITY known — and the free name a retry would take — so the
      // refusal can offer both instead of leaving the caller to hunt and guess.
      if (occupant) {
        throw noteAlreadyExists(input.title, {
          existing: occupant,
          suggestedTitle: this.suggestedTitleFor(input),
        })
      }
    }
    if (this.host.inner.capabilities.identity) {
      // The engine is its own registry — it settles the id, and (CAS-capable
      // engines, e.g. InMemoryStore) enforces the version check itself,
      // atomically against its own content; we only patch the snapshot.
      // The journal baseline is read BEFORE the write (the first journaled
      // edit of a note must capture the state it found) — a best-effort read,
      // racing writers are already fenced by the engine's own CAS.
      const baseline = input.originalId ? await this.baselineOf(input.originalId) : undefined
      const releaseGraphTransition = this.host.beginGraphTransition()

      try {
        const result = await this.host.inner.write({
          ...input,
          originalId: input.originalId ? this.innerNoteKey(input.originalId) : input.originalId,
          identityOnly: Boolean(input.originalId),
        })

        if (result.id) {
          let directoryChanged = false
          this.host.afterNotesReady(() => {
            directoryChanged = this.applyWrite(input, result, result.id!)
          })
          if (directoryChanged) {
            await this.host.rederiveGraphContext()
          }
        } else {
          this.host.reconcileSoon()
        }
        this.journalWrite(input, result.id ?? input.originalId, baseline, undefined, result.class)
        return { ...result, title: input.title }
      } finally {
        releaseGraphTransition()
      }
    }
    // Identity is settled BEFORE the engine call so the very same write
    // materializes the id into the file's frontmatter: an edited note keeps
    // its id; a save that upserts onto an existing path (same title+folder)
    // inherits that path's id; only a genuinely new note mints one.
    const originalPath = input.originalId ? currentPath : undefined

    // `originalId` is a stable identity at this layer, never a fresh human resolver.
    // A bare engine has no identity namespace of its own; forwarding a missing id as
    // a raw string would let its title/path resolver overwrite a namesake.
    if (input.originalId && !originalPath) {
      throw noteNotFound(input.originalId)
    }
    const id = originalPath
      ? input.originalId!
      : (input.id ?? this.host.identity.idFor(predictedPath) ?? freshNoteId())
    // The engine speaks storage keys; this is the path the id binds to (or the
    // caller's raw key when the registry doesn't know it — the resolver channel).
    const storageKey = originalPath ?? input.originalId
    let live: NoteContent | undefined

    if (input.originalId) {
      // Updates are strict: no token, no write — for the UI and for
      // programmatic clients alike. The compare runs against the live
      // body AS A READER GETS IT (the engine normalises the same way on both
      // sides), so the token the editor read is directly comparable. A note
      // deleted under the editor surfaces here as the read's honest 404.
      if (!input.versionToken) {
        throw versionTokenRequired(input.originalId)
      }
      live = await this.host.inner.read(
        this.innerNoteKey(input.originalId, storageKey),
        supportsExactIdentityAddress(this.host.inner) ? { identityOnly: true } : undefined,
      )

      if (live.filePath !== storageKey) {
        throw noteNotFound(input.originalId)
      }
      const liveToken = computeVersionToken(live.content)

      if (liveToken !== input.versionToken) {
        throw versionConflict({
          ...live,
          id: live.id ?? input.originalId,
          versionToken: liveToken,
        })
      }
    }
    const releaseGraphTransition = this.host.beginGraphTransition()
    const identityBefore = !input.originalId ? new Set(this.host.snap.notes.keys()) : undefined
    const releaseIdentityPublication = !input.originalId
      ? this.host.beginIdentityPublication()
      : undefined
    let identityPublicationPending = false

    try {
      const result = await this.host.inner.write({
        ...input,
        originalId: input.originalId ? this.innerNoteKey(input.originalId, storageKey) : storageKey,
        identityOnly: Boolean(input.originalId && supportsExactIdentityAddress(this.host.inner)),
        id,
      })
      const publishAfterIdentityFlush = !input.originalId && !this.host.isBulkActive()
      const removed: string[] = []
      let directoryChanged = false
      this.host.afterNotesReady(() => {
        directoryChanged = this.applyWrite(
          input,
          result,
          id,
          originalPath,
          !publishAfterIdentityFlush,
          removed,
        )
      })
      if (!input.originalId) {
        // The lease was closed before inner.write. Register its durable cut
        // immediately after the synchronous registry/snapshot patch, before
        // any later await can let a reader or retry timer observe the new axis.
        this.host.markIdentityPublicationPending()
        identityPublicationPending = true
        if (this.host.isBulkActive()) {
          // Bulk durability is coalesced. Releasing the producer lease lets an
          // interactive read force the pending revision durable mid-import;
          // it never lets the revision itself disappear.
          releaseIdentityPublication?.()
        }
      }
      // Deferring the external CHANGED frame must not defer the decorator's
      // own exact-id map. Graph-context re-derivation below addresses the just
      // created note by id; without this local sync a path-keyed engine falls
      // through to its expensive whole-graph fallback before durability lands.
      if (publishAfterIdentityFlush) {
        this.host.markInnerLinkIdentitiesDirty()
        this.host.syncInnerLinkIdentities()
      }
      if (directoryChanged) {
        await this.host.rederiveGraphContext()
      }
      // The post-write read serves double duty: the fresh token the save
      // answers with (the engine merges frontmatter — input bytes are not
      // authoritative) and the journaled after-state.
      const after = await this.readAfterWrite(input, result, storageKey)
      const baseline =
        live && !(await this.hasHistory(id))
          ? {
              content: live.content,
              title: live.title ?? input.title,
              tags: normTags(live.frontmatter?.tags) ?? [],
              // The note's pre-edit custom slug, so the baseline is slug-faithful too.
              slug: live.slug ?? null,
            }
          : undefined
      this.journalWrite(input, id, baseline, after?.content, result.class)
      // Flush a fresh id before answering: a create's id may be resolved in the very next request,
      // but global id→space resolution reads the meta-DB, not this write-behind registry, so a read
      // that beat the flush would 404 a note that exists. Updates skip it (already durable). Bulk
      // import skips the per-note flush (a starvation source) — broadcastBulk flushes the
      // registry before each coalesced `changed` instead, so durability tracks visibility.
      if (publishAfterIdentityFlush) {
        await this.host.flushIdentityPublication()
        if (result.filePath) {
          this.host.emitChanged([id], removed)
        }
      }

      return {
        ...result,
        id,
        title: input.title,
        versionToken: computeVersionToken(after?.content ?? this.normalizedInput(input)),
      }
    } catch (err) {
      if (identityPublicationPending && identityBefore) {
        this.host.rememberIdentityRepair(identityBefore)
      }
      throw err
    } finally {
      releaseIdentityPublication?.()
      releaseGraphTransition()
    }
  }

  private pathFor(id: string): string | undefined {
    return this.host.identity.pathFor(id) ?? this.host.snap.notes.get(id)?.filePath
  }

  /** Exact note address at the inner-store boundary. Identity-capable engines also
   *  expose human path/name resolution, so the reserved envelope plus an explicit
   *  discriminator keeps mutations on the identity axis. Bare engines instead
   *  require the registry-owned storage path. */
  private innerNoteKey(noteId: string, storagePath?: string): string {
    if (supportsExactIdentityAddress(this.host.inner)) {
      this.host.syncInnerLinkIdentities()
      return encodeWikilinkIdentity(noteId)
    }

    return storagePath ?? noteId
  }

  /** Mirror the engines' destination selection closely enough to fence the
   *  source/destination namespace before either engine performs its own checks. */
  private predictedPath(input: WriteInput, currentPath?: string): string {
    const dir = (
      input.directory === undefined && currentPath
        ? directoryOf(currentPath)
        : input.directory || ''
    ).replace(/^\/+|\/+$/g, '')
    // Both engines keep a folder page on the structural `index.md` basename
    // even when an edit supplies another fileName. The fence must predict that
    // exact destination too, not merely the ordinary noteFilePath convention.
    const fileName =
      currentPath && isFolderPageNote(currentPath) ? FOLDER_PAGE_BASENAME : input.fileName

    const currentMeta = input.originalId ? this.host.snap.notes.get(input.originalId) : undefined

    if (
      currentPath &&
      currentMeta?.title === input.title &&
      input.fileName == null &&
      dir === directoryOf(currentPath)
    ) {
      return currentPath
    }

    return noteFilePath(
      input.title,
      dir,
      fileName,
      input.originalId ?? input.id,
      input.legacyImportRoot !== undefined,
    )
  }

  /** The note as the engine actually stored it — null when the read-back
   *  fails (callers fall back to the normalised input). */
  private async readAfterWrite(
    input: WriteInput,
    result: WriteResult,
    storageKey?: string,
  ): Promise<NoteContent | null> {
    try {
      const resultId = result.id ?? input.originalId
      const exactPath = result.filePath ?? storageKey

      // The write just returned this storage path while its mutation claim is
      // still held. A bare engine can read it directly and verify the answer,
      // avoiding a full id→path registry rebuild after every create in a bulk
      // import. Interactive/stale-id operations still use the exact envelope.
      if (!this.host.inner.capabilities.identity && exactPath) {
        const detail = await this.host.inner.read(exactPath)

        return detail.filePath === exactPath ? detail : null
      }

      const key = resultId ? this.innerNoteKey(resultId, exactPath) : (exactPath ?? input.title)

      return await this.host.inner.read(
        key,
        supportsExactIdentityAddress(this.host.inner) && resultId
          ? { identityOnly: true }
          : undefined,
      )
    } catch {
      return null
    }
  }

  /** The save's body normalised the way read() would serve it — the fallback
   *  identity for tokens and journal states when no read-back is available. */
  private normalizedInput(input: WriteInput): string {
    return stripTitleHeading(stripFrontmatter(input.content ?? ''), input.title)
  }

  private async hasHistory(noteId: string): Promise<boolean> {
    try {
      return await this.host.journal.hasHistory(noteId)
    } catch {
      return true // can't tell — don't fabricate a baseline
    }
  }

  /** Pre-write state for the journal baseline, identity-capable-engine path
   *  (the bare-engine path reuses its CAS verify-read instead). Only the very
   *  first journaled edit of a note pays this read. */
  private async baselineOf(
    noteId: string,
  ): Promise<{ content: string; title: string; tags: string[]; slug: string | null } | undefined> {
    try {
      if (await this.host.journal.hasHistory(noteId)) {
        return undefined
      }
      const live = await this.host.inner.read(this.innerNoteKey(noteId), {
        identityOnly: supportsExactIdentityAddress(this.host.inner),
      })
      return {
        content: live.content,
        title: live.title ?? '',
        tags: normTags(live.frontmatter?.tags) ?? [],
        // The custom slug the note already carried, so a restore of the baseline
        // brings it back too. null = no custom slug (the implicit default).
        slug: live.slug ?? null,
      }
    } catch {
      return undefined
    }
  }

  /** Queue the write's journal revision (fire-and-forget — the journal never
   *  fails a save). */
  private journalWrite(
    input: WriteInput,
    noteId: string | undefined,
    baseline?: { content: string; title: string; tags?: string[]; slug?: string | null },
    afterContent?: string,
    /** The written note's class, from the engine's WriteResult (mount-
     *  derived, authoritative). Recorded so the cursor-based delta can class-scope
     *  . Falls back to the create intent / the snapshot; the journal
     *  carries it forward on later body-less revisions. */
    cls?: string | null,
  ): void {
    if (!noteId) {
      return
    }
    // The custom slug this write records — the same storedSlug the snapshot
    // mirror (applyWrite) uses (input already softened by uniqueSlug at write()): an
    // unaddressed slug stays `undefined` so the journal carries the PRIOR REVISION's
    // forward; a clear/collapse-to-default ('') records null. (applyWrite carries the
    // snapshot's prior slug instead — same sequence, different store.)
    const slugCh = storedSlug(input.slug, input.title)
    void this.host.journal.record({
      noteId,
      kind: input.journal?.kind ?? REVISION_KIND.write,
      principal: input.principal ?? null,
      agent: input.agent,
      content: afterContent ?? this.normalizedInput(input),
      title: input.title,
      class: cls ?? input.targetClass ?? this.host.snap.notes.get(noteId)?.class ?? null,
      slug: slugCh === undefined ? undefined : slugCh || null,
      tags: normTags(input.tags) ?? [],
      sourceRevisionId: input.journal?.sourceRevisionId,
      baseline,
    })
  }

  async move(input: MoveInput, opts?: MutationOptions): Promise<void> {
    const currentPath = input.isDirectory ? input.id : this.pathFor(input.id)

    if (
      !isPortableMoveDestination(
        input.destinationPath,
        currentPath ?? '',
        (prefix) => this.host.dirs.has(prefix) || prefix === currentPath,
      ) ||
      (input.isDirectory && !isCanonicalSafeRelativeAddress(input.id))
    ) {
      throw folderFailed('path must be a canonical public relative path')
    }
    if (input.isDirectory) {
      return this.mutations.runStable(
        () => ({ global: true }),
        async () => {
          await opts?.prepare?.()
          const releaseGraphTransition = this.host.beginGraphTransition()

          try {
            const directoryChanged = await this.moveFolderClaimed(input)
            await opts?.finalize?.()
            const aliasesChanged = await this.host.refreshFolderAliases()

            if (directoryChanged || aliasesChanged) {
              await this.host.rederiveGraphContext()
            }
          } finally {
            releaseGraphTransition()
          }
        },
      )
    }

    return this.mutations.runStable(
      () =>
        isVisibleOn(
          SURFACE.graph,
          this.host.snap.notes.get(input.id)?.class ?? DEFAULT_NOTE_CLASS,
        ) &&
        directoryOf(input.destinationPath) &&
        !this.host.dirs.has(directoryOf(input.destinationPath))
          ? { global: true }
          : {
              noteIds: [input.id],
              paths: [this.pathFor(input.id), input.destinationPath],
            },
      async () => {
        await opts?.prepare?.()
        const claimedPath = this.pathFor(input.id)

        if (!this.host.inner.capabilities.identity && !claimedPath) {
          throw noteNotFound(input.id)
        }
        const releaseGraphTransition = this.host.beginGraphTransition()

        try {
          await this.host.inner.move({
            ...input,
            id: this.innerNoteKey(input.id, claimedPath),
            identityOnly: supportsExactIdentityAddress(this.host.inner),
          })
          let directoryChanged = false
          this.host.afterNotesReady(() => {
            directoryChanged = this.applyNoteMove(input.id, input.destinationPath, claimedPath)
          })
          if (directoryChanged) {
            await this.host.rederiveGraphContext()
          }
          await opts?.finalize?.()
        } finally {
          releaseGraphTransition()
        }
      },
    )
  }

  private async moveFolderClaimed(input: MoveInput): Promise<boolean> {
    const source = input.id.replace(/^\/+|\/+$/g, '')

    if (!this.host.dirs.has(source) && this.host.dirs.hasEquivalent(source)) {
      throw folderFailed('source spelling does not match the stored folder')
    }
    await this.host.inner.move(input)
    // The ids of every note under the prefix follow their files — otherwise
    // a folder drag would orphan the whole subtree's identity.
    this.host.identity.renamePrefix(input.id, input.destinationPath)
    // Patch the snapshot SYNCHRONOUSLY: relocate the subtree's note paths
    // + re-key the directory channel, so /tree is consistent at once (a stale
    // `src` note path beside the fresh disk `dest` was the dup-on-rename bug).
    let directoryChanged = false
    this.host.afterNotesReady(() => {
      directoryChanged = this.applyDirMove(input.id, input.destinationPath)
    })
    // The engine does NOT rewrite other notes' bodies (no inbound-link rewrite
    // anywhere — that long-standing claim was a myth): path-form [[olddir/note]]
    // links into the moved subtree resolve through the alias layer once folder
    // identity lands. The delta poll just reconciles the snapshot.
    this.host.reconcileSoon()
    return directoryChanged
  }

  async remove(
    id: string,
    opts?: { principal?: string; agent?: AgentWriteAttribution },
  ): Promise<void> {
    return this.trashMutations.run({ paths: [trashMutationPath(id)] }, () =>
      this.mutations.runStable(
        () => this.removalClaim([id]),
        () => this.removeClaimed(id, opts),
      ),
    )
  }

  async makeDir(path: string, opts?: MutationOptions): Promise<void> {
    if (!this.host.inner.makeDir) {
      return
    }
    if (!isPortableRelativeDestination(path, (prefix) => this.host.dirs.has(prefix))) {
      throw folderFailed('path must be safe with portable new components')
    }

    return this.mutations.runStable(
      () => ({ global: true }),
      async () => {
        await opts?.prepare?.()
        const clean = path.replace(/^\/+|\/+$/g, '')
        const releaseGraphTransition = this.host.beginGraphTransition()

        try {
          await this.host.inner.makeDir!(path)
          let directoryChanged = false
          this.host.afterNotesReady(() => {
            directoryChanged = this.host.dirs.add(clean)
          })
          if (directoryChanged) {
            await this.host.rederiveGraphContext()
            this.host.emitChanged([], [])
          }
          await opts?.finalize?.()
        } finally {
          releaseGraphTransition()
        }
      },
    )
  }

  async removeDir(
    path: string,
    opts?: MutationOptions & {
      principal?: string
      agent?: AgentWriteAttribution
    },
  ): Promise<void> {
    if (!isCanonicalSafeRelativeAddress(path)) {
      throw folderFailed('path must be a canonical public relative path')
    }

    return this.trashMutations.run({ prefixes: [TRASH_MUTATION_PREFIX] }, () =>
      this.mutations.runStable(
        () => ({ global: true }),
        async () => {
          await opts?.prepare?.()
          const clean = path.replace(/^\/+|\/+$/g, '')

          if (!this.host.dirs.has(clean) && this.host.dirs.hasEquivalent(clean)) {
            return
          }
          const releaseGraphTransition = this.host.beginGraphTransition()

          try {
            // Re-read the snapshot after waiting: an earlier mutation may have moved a
            // note into or out of this subtree. The prefix/source fence now keeps this set stable.
            const victims = this.noteIdsUnder(path)

            for (const id of victims) {
              await this.removeClaimed(id, opts)
            }
            if (this.host.inner.removeDir) {
              await this.host.inner.removeDir(path)
              let directoryChanged = false
              this.host.afterNotesReady(() => {
                directoryChanged = this.host.dirs.removeSubtree(path)
              })
              if (directoryChanged) {
                await this.host.rederiveGraphContext()
                this.host.emitChanged([], [])
              }
            }
            await opts?.finalize?.()
          } finally {
            releaseGraphTransition()
          }
        },
      ),
    )
  }

  private noteIdsUnder(...prefixes: string[]): string[] {
    const clean = prefixes.map((prefix) => prefix.replace(/^\/+|\/+$/g, ''))
    const ids: string[] = []

    for (const [id, meta] of this.host.snap.notes) {
      if (
        clean.some((prefix) => meta.filePath === prefix || meta.filePath.startsWith(`${prefix}/`))
      ) {
        ids.push(id)
      }
    }

    return ids
  }

  /** A target removal writes the cached edge buckets of every current inbound
   *  source. Claim those sources with the victims; writes that introduce a NEW
   *  inbound edge claim the resolved target id in `writeClaim`, closing the phantom
   *  window without serializing unrelated deletions. */
  private removalClaim(targetIds: readonly string[]): {
    noteIds: string[]
    paths: string[]
    prefixes: string[]
  } {
    const noteIds = [...new Set([...targetIds, ...this.host.snap.sourceIdsTargeting(targetIds)])]
    const paths = noteIds
      .map((id) => this.pathFor(id) ?? this.host.snap.notes.get(id)?.filePath)
      .filter((path): path is string => path != null)

    return { noteIds, paths, prefixes: targetIds.map(linkTargetPrefix) }
  }

  private async removeClaimed(
    id: string,
    opts?: { principal?: string; agent?: AgentWriteAttribution },
  ): Promise<void> {
    const storagePath = this.pathFor(id)
    const meta = this.host.snap.notes.get(id)
    const inboundSources = this.host.snap.sourceIdsTargeting([id])

    // A repeated/stale delete must not manufacture a fresh tombstone after a
    // successful permanent purge. The live snapshot/path binding is the
    // admission fact; both engine implementations otherwise treat a missing
    // physical remove as an idempotent no-op.
    if (!storagePath && !meta) {
      throw noteNotFound(id)
    }
    // Capture the body BEFORE deleting: the trash is only a safety net if it
    // can resurrect the note, and a note never saved through us has no journaled
    // body to fall back on. One read on a rare op buys an always-restorable
    // tombstone. A read failure (already gone, unreadable) degrades honestly — the
    // tombstone then keeps whatever hash the journal already had (maybe none).
    let lastContent: string | null = null
    let lastTags: string[] | undefined
    let lastClass: NoteClass | undefined
    let lastTitle: string | undefined
    // `undefined` only while the live read hasn't run / failed (→ carry the journal's
    // last slug forward); a successful read sets it DEFINITIVELY (string | null).
    let lastSlug: string | null | undefined

    try {
      const live = await this.host.inner.read(this.innerNoteKey(id, storagePath), {
        identityOnly: supportsExactIdentityAddress(this.host.inner),
      })
      lastContent = live.content
      lastTags = normTags(live.frontmatter?.tags) ?? undefined
      // Carry the class/title from the live read too: when the note isn't in the
      // snapshot (a delete during cold boot), meta is absent, and a null tombstone
      // class would slip a hidden class (agent-memory) into the user trash — the
      // class filter never excludes null. The engine's read class is exact.
      lastClass = live.class
      lastTitle = live.title
      // The note's custom slug at deletion, recorded DEFINITIVELY from file
      // truth (null = no custom slug) so the tombstone never resurrects a stale
      // journal slug — same reason journalExternal records `?? null`. The tombstone
      // carries it so a restore re-sets the slug instead of dropping to slug(title).
      lastSlug = live.slug ?? null
    } catch {
      // no body to capture — restore falls back to the last known revision, if any
    }
    const releaseGraphTransition = this.host.beginGraphTransition()

    try {
      // From the first physical mutation through the tombstone, snapshot removal,
      // exact-identity refresh and inbound re-derivation, no fresh graph surface
      // may observe the inner engine and read-model on opposite sides.
      await this.host.inner.remove(this.innerNoteKey(id, storagePath), {
        identityOnly: supportsExactIdentityAddress(this.host.inner),
      })
      // Tombstone the id↔path binding so the trash can restore the note into
      // its last folder. A bare engine's registry already holds it (storagePath);
      // an identity-capable engine (the in-memory fake) doesn't populate this
      // registry, so seed the binding from the snapshot path before tombstoning —
      // otherwise restore would have no folder to aim at. Harmless for live reads:
      // markDeleted drops it from byPath, so pathFor/idFor still ignore it; only
      // recordFor (the trash's path source) sees the tombstone.
      const lastPath = storagePath ?? meta?.filePath

      if (lastPath) {
        if (!this.host.identity.recordFor(id)) {
          this.host.identity.adoptFileId(lastPath, id)
        }
        this.host.identity.markDeleted(lastPath)
      }
      // The tombstone revision: carries the final body (a blob in the CAS) so
      // the undelete flow resurrects the exact last state. When the read above
      // failed, content is null and the journal keeps the last known hash instead.
      // AWAITED (not fire-and-forget like a save): the tombstone IS the trash entry,
      // and the 'changed' emit + the response below tell clients "it's deleted" — a
      // trash opened right after must already see it, not race the append. record()
      // swallows its own errors, so this still never fails the delete (P2).
      await this.host.journal.record({
        noteId: id,
        kind: REVISION_KIND.delete,
        principal: opts?.principal ?? null,
        agent: opts?.agent,
        content: lastContent,
        title: meta?.title ?? lastTitle ?? '',
        class: meta?.class ?? lastClass,
        // Prefer the live snapshot's slug, fall back to the read; undefined (a
        // cold-boot delete that read neither) carries the prior slug forward.
        slug: meta?.slug ?? lastSlug,
        tags: lastTags,
      })
      let snapshotRemoved = false

      this.host.afterNotesReady(() => {
        this.host.previewCache.delete(id)
        if (!this.host.snap.notes.delete(id)) {
          return
        }
        snapshotRemoved = true
        this.host.snap.edgesBySource.delete(id)
        this.host.markInnerLinkIdentitiesDirty()
      })
      if (snapshotRemoved) {
        // A resolved edge has already collapsed its authored labels. Re-read every
        // inbound source against the post-delete index so `[[Title]]` becomes a
        // creatable human ghost, `[[notarium-id:…]]` becomes a tombstone, and a body
        // containing both regains both distinct edges.
        await this.host.rederiveSources(inboundSources)
        this.host.emitChanged([], [id])
      }
    } finally {
      releaseGraphTransition()
    }
  }

  /** Snapshot patch for a FOLDER move: relocate every note under the src
   *  prefix to dest AND re-key the directory channel, so /tree is consistent the
   *  instant the move returns — store.list() no longer keeps a stale `src` path
   *  beside the fresh disk `dest` (the dup-on-rename root). The src PARENT lingers
   *  (never-prune). No note BODY is touched (the engine never rewrites inbound
   *  links); path-form links into the subtree heal via the alias layer
   *  once folder identity lands. The delta poll just reconciles. */
  private applyDirMove(src: string, dest: string): boolean {
    const prefix = `${src}/`
    const upserts: string[] = []

    for (const [id, meta] of this.host.snap.notes) {
      if (meta.filePath === src || meta.filePath.startsWith(prefix)) {
        this.host.snap.notes.set(id, {
          ...meta,
          filePath: dest + meta.filePath.slice(src.length),
          modifiedAt: this.host.iso(),
        })
        upserts.push(id)
      }
    }
    const directoryChanged = this.host.dirs.moveSubtree(src, dest)

    if (upserts.length || directoryChanged) {
      this.host.emitChanged(upserts, [])
    }

    return directoryChanged
  }

  private applyWrite(
    input: WriteInput,
    result: WriteResult,
    id: string,
    originalPath?: string,
    publish = true,
    removedOut?: string[],
  ): boolean {
    if (!result.filePath) {
      // Engine didn't tell us where the note landed — let the feed catch up.
      this.host.reconcileSoon()
      return false
    }
    const newPath = result.filePath
    const removed: string[] = []

    if (!this.host.inner.capabilities.identity) {
      // Identity bookkeeping (ours, not an identity-capable engine's). A
      // rename moves the id's path binding (the snapshot key — the id — never
      // changes, which is the whole point of P7); a save that landed on a path
      // owned by some other id displaces that id (the engine just overwrote
      // the file, our id included).
      if (
        originalPath &&
        this.host.identity.idFor(originalPath) === id &&
        originalPath !== newPath
      ) {
        this.host.identity.rename(originalPath, newPath)
      }
      const pathOwner = this.host.identity.idFor(newPath)

      if (pathOwner && pathOwner !== id) {
        this.host.snap.notes.delete(pathOwner)
        this.host.previewCache.delete(pathOwner)
        this.host.snap.edgesBySource.delete(pathOwner)
        removed.push(pathOwner)
      }
      if (pathOwner !== id) {
        this.host.identity.adoptFileId(newPath, id, input.createdAt)
      }
      // The engine wrote the id into the file's frontmatter with this call.
      this.host.identity.markMaterialized(id)
    } else {
      // The engine owns identity; still surface a displaced note when the
      // write upserted onto a path another snapshot entry held.
      for (const [otherId, meta] of this.host.snap.notes) {
        if (otherId !== id && meta.filePath === newPath) {
          this.host.snap.notes.delete(otherId)
          this.host.previewCache.delete(otherId)
          this.host.snap.edgesBySource.delete(otherId)
          removed.push(otherId)
        }
      }
    }
    const prev = this.host.snap.notes.get(id)
    // Authored date edit: when the write SETS `createdAt`, reset the
    // registry's pinned date too — else adoptMeta would read the stale first-seen
    // value back over the engine's fresh one on the next poll/restart (the registry
    // is the Feed-date authority for a bare engine). Normalised first (normAuthoredDate)
    // so a lax-channel garbage value can't poison the snapshot/registry while the
    // engine rejects it. No-op for an import re-stamping the same value, or an
    // identity-capable inner engine (unknown id).
    const authoredCreatedAt = normAuthoredDate(input.createdAt)

    if (authoredCreatedAt) {
      this.host.identity.setCreatedAt(id, authoredCreatedAt)
    }
    const rec = this.host.identity.recordFor(id)
    // Imported raw frontmatter merges above the occupied file and below typed
    // channels. Project its final duplicate here too: the engine re-reads these
    // values from the serialized file before the write returns, so the optimistic
    // snapshot must not wait for a later delta to expose (or clear) them.
    const incomingAliases = input.frontmatter
      ? frontmatterEntryOf(input.frontmatter, 'aliases')
      : undefined
    const incomingSlug = input.frontmatter
      ? frontmatterEntryOf(input.frontmatter, 'slug')
      : undefined
    const incomingSlugValue = incomingSlug && frontmatterEntryValue(incomingSlug)
    const carriedAliases =
      incomingAliases !== undefined
        ? (normAliases(frontmatterEntryValue(incomingAliases)) ?? [])
        : prev?.aliases
    const carriedSlug =
      incomingSlug !== undefined
        ? typeof incomingSlugValue === 'string'
          ? slugify(incomingSlugValue) || undefined
          : undefined
        : prev?.slug
    // The typed slug channel is serialized last: undefined leaves the merged raw
    // value, while a value sets it and '' clears it.
    const slugCh = storedSlug(input.slug, input.title)
    const slug = slugCh === undefined ? carriedSlug : slugCh || undefined
    // Alias-history, optimistic mirror of the engine's write: a rename
    // (the title OR the effective slug changed) records the old name(s) so the
    // snapshot graph resolves inbound [[Old Title]] / [[old-slug]] at once, before
    // the delta poll re-reads the file. nextAliasesMulti dedups + drops the now-
    // current names (A→B→A leaves no stale self-alias).
    const prevEffSlug = prev ? effectiveSlug(prev.slug, prev.title) : undefined
    // The real engine decides alias history from the addressed source row and
    // explicit slug channel before raw incoming frontmatter is re-read. A create
    // overwrite is not an identity rename, and an incoming raw slug alone does
    // not retire the prior slug.
    const renameSlug = slugCh === undefined ? prev?.slug : slug
    const newEffSlug = effectiveSlug(renameSlug, input.title)
    const renamed = Boolean(
      input.originalId && prev && (prev.title !== input.title || prevEffSlug !== newEffSlug),
    )
    const aliases =
      renamed && prev
        ? nextAliasesMulti(prev.aliases, [prev.title, prevEffSlug!], [input.title, newEffSlug])
        : carriedAliases
    // Tags on the optimistic snapshot: the just-saved note is tag-filterable
    // immediately, without waiting for the delta poll. Mirror the engine's write
    // semantics — `undefined` LEAVES the prior tags, a value SETS them, `[]` clears.
    const tags = input.tags === undefined ? prev?.tags : (normTags(input.tags) ?? [])
    this.host.snap.notes.set(id, {
      id,
      title: input.title,
      ...(slug ? { slug } : {}),
      ...(aliases?.length ? { aliases } : {}),
      ...(tags?.length ? { tags } : {}),
      // Class is mount-derived and AUTHORITATIVE from the write result — no optimistic guess, so an
      // edit of a hidden note never briefly flips to user-doc. Falls back to prior/targetClass only
      // for an engine that doesn't report it.
      class: result.class ?? prev?.class ?? input.targetClass ?? DEFAULT_NOTE_CLASS,
      filePath: newPath,
      modifiedAt: this.host.iso(),
      // The authored date (normalised) dates the note by when it happened, not now
      // (an import seed, OR an authored date edit) — it WINS so the optimistic
      // snapshot matches what the rescan reads back from the file's `created:`. Absent:
      // keep the note's existing date (first-seen pin survives a plain body save).
      createdAt:
        authoredCreatedAt ??
        (prev !== undefined ? prev.createdAt : (rec?.createdAt ?? this.host.iso())),
    })
    // Write-through keeps the preview warm too: the very snippet the Feed will
    // ask for next is computed here, from data the save already carried.
    this.host.previewCache.set(id, derivePreview(input.content ?? '', input.tags))
    const directoryChanged = this.host.dirs.add(directoryOf(newPath))
    // Directory context is part of the resolver index, so add it before deriving
    // even this note's own outbound edges.
    this.host.snap.patchNoteEdges(id, input.content ?? '')
    removedOut?.push(...removed)

    if (publish) {
      this.host.emitChanged([id], removed)
    }

    return directoryChanged
  }

  private applyNoteMove(id: string, destinationPath: string, oldPath?: string): boolean {
    if (oldPath) {
      this.host.identity.rename(oldPath, destinationPath)
    }
    const prev = this.host.snap.notes.get(id)

    if (!prev) {
      this.host.reconcileSoon()
      return false
    }
    // The id IS the snapshot key, so a move is a metadata patch: no re-keying,
    // the preview and both edge directions stay put.
    this.host.snap.notes.set(id, {
      ...prev,
      filePath: destinationPath,
      modifiedAt: this.host.iso(),
    })
    const directoryChanged = this.host.dirs.add(directoryOf(destinationPath))
    this.host.emitChanged([id], [])
    return directoryChanged
  }
}
