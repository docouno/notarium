import { isImportNoteSourceLocator } from '../../../importer'
import type {
  AgentWriteAttribution,
  ExistingNote,
  MoveInput,
  MoveResult,
  MutationOptions,
  NoteClass,
  NoteContent,
  NoteMeta,
  RemoveOptions,
  TagMutationInput,
  TagMutationResult,
  WriteInput,
  WriteResult,
} from '../../../knowledgeStore'
import {
  destinationOwnerConflict,
  noteAlreadyExists,
  noteNotFound,
  StoreError,
  versionConflict,
  versionTokenRequired,
} from '../../../knowledgeStore'
import { IF_EXISTS, REVISION_KIND, STORE_ERROR_REASON } from '../../../knowledgeStore'
import { nextAliasesMulti, normAliases } from '../../../libs/aliases'
import {
  type DurableTextViolation,
  firstDurableTextViolation,
  freshNoteId,
  isDurableScalar,
  isDurableText,
  isValidNoteId,
} from '../../../libs/id'
import {
  type DocumentState,
  encodeWikilinkIdentity,
  frontmatterEntryOf,
  frontmatterEntryValue,
  isDurableFrontmatter,
  type LogicalNoteState,
  promoteBodyTitle,
  stripFrontmatter,
  stripTitleHeading,
} from '../../../libs/markdown'
import { MutationCoordinator } from '../../../libs/mutationCoordinator'
import {
  basenameOf,
  directoryOf,
  FOLDER_PAGE_BASENAME,
  isCanonicalInternalRelativeAddress,
  isCanonicalSafeRelativeAddress,
  isFolderPageNote,
  isLegacyImportDestination,
  isPortableMoveDestination,
  isPortableRelativeDestination,
  legacyNoteNameAlias,
  noteFilePath,
  sluggedNoteName,
} from '../../../libs/path'
import { effectiveSlug, slugify, storedSlug } from '../../../libs/slug'
import { normTags } from '../../../libs/tags'
import { computeVersionToken } from '../../../libs/versionToken'
import type { LinkIndex } from '../../../referenceResolver'
import type { JournalRecordInput } from '../../../revisionJournal'
import { derivePreview } from '../../../snippet'
import { IMPORT_SOURCE_FRONTMATTER_KEY } from '../../../sourceIdentity'
import { DEFAULT_NOTE_CLASS, isVisibleOn, SURFACE } from '../../../visibility'
import { TRASH_MUTATION_PREFIX, trashMutationPath } from '../../consts'
import { exactDocumentState, exactLogicalState, exactVersionToken } from '../exactNoteState'
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

type RemovalCapture = {
  id: string
  storagePath?: string
  meta?: NoteMeta
  inboundSources: string[]
  lastContent: string | null
  lastLogicalState: LogicalNoteState | null
  lastDocumentState: DocumentState | null
  lastTags?: string[]
  lastClass?: NoteClass
  lastTitle?: string
  lastSlug?: string | null
  /** The exact storage incarnation the capture observed — the removal must delete
   *  THAT one, not whatever now sits at the path (#302). */
  physicalIncarnation: NonNullable<NoteContent['physicalIncarnation']>
  /** Deleting a note that owned legacy name aliases invalidates name-resolved edges
   *  beyond its own inbound sources, so the graph re-derives wholesale. */
  removesLegacyAliasOwner: boolean
}

const isCollision = (err: unknown): boolean =>
  (err as { reason?: string }).reason === STORE_ERROR_REASON.noteAlreadyExists

const legacyAliasesChanged = (
  before: readonly string[] | undefined,
  after: readonly string[] | undefined,
): boolean =>
  (before?.length ?? 0) !== (after?.length ?? 0) ||
  (before ?? []).some((alias, index) => alias !== after?.[index])

type WriteSnapshotEffect = { directoryChanged: boolean; graphChanged: boolean }
const NO_WRITE_SNAPSHOT_EFFECT: WriteSnapshotEffect = {
  directoryChanged: false,
  graphChanged: false,
}

/** Inputs consumed by shapeGraph or buildLinkIndex. Timestamps, source locator,
 * summary and body-without-edge-change are deliberately absent. */
const graphInputsChanged = (before: NoteMeta | undefined, after: NoteMeta): boolean =>
  !before ||
  before.title !== after.title ||
  before.class !== after.class ||
  before.filePath !== after.filePath ||
  before.slug !== after.slug ||
  legacyAliasesChanged(before.aliases, after.aliases) ||
  legacyAliasesChanged(before.legacyNameAliases, after.legacyNameAliases) ||
  legacyAliasesChanged(before.tags, after.tags)

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

const codePointLabel = (violation: DurableTextViolation): string =>
  `U+${violation.codePoint.toString(16).toUpperCase().padStart(4, '0')}`

const violationNoun = (violation: DurableTextViolation): string =>
  violation.kind === 'control'
    ? `a control character ${codePointLabel(violation)}`
    : `an unpaired UTF-16 surrogate ${codePointLabel(violation)}`

const violationTail = (violation: DurableTextViolation): string =>
  violation.total > 1 ? ` (and ${violation.total - 1} more)` : ''

/** Violators printed as `?` so the refusal itself stays durable text. */
const printableScalar = (value: string): string =>
  [...value].map((char) => (isDurableScalar(char) ? char : '?')).join('')

/** 1-based code-point column of `target` within its `\n`-line — the locator's own
 *  coordinate rule applied at an arbitrary index, so a promoted title's violation can
 *  be named in the CALLER's argument. A flat prefix-length shift would misplace it
 *  whenever the trimmed prefix spans a line break. */
const columnAt = (value: string, target: number): number => {
  let column = 1

  for (let index = 0; index < target && index < value.length; index++) {
    const unit = value.charCodeAt(index)

    if (unit === 0x0a) {
      column = 1
      continue
    }
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1)

      if (next >= 0xdc00 && next <= 0xdfff) {
        index++
      }
    }
    column++
  }

  return column
}

/** The tag is named by VALUE: the pin path validates a merged list of live plus added
 *  tags, so an ordinal would point at an element the caller never sent. */
const assertDurableTag = (tag: string): void => {
  if (!isDurableText(tag)) {
    const violation = firstDurableTextViolation(tag)!

    throw invalidWrite(
      `tag "${printableScalar(tag)}" contains ${violationNoun(violation)} at column ${violation.column}${violationTail(violation)}`,
    )
  }
  if (!isDurableScalar(tag)) {
    throw invalidWrite(`tag "${printableScalar(tag)}" must be a single-line string`)
  }
}

/** Refusals name the violating code point and its position in the value THIS
 *  chokepoint received — on an edit path that is the merged document, not the
 *  caller's fragment. `content` is checked first and on the authored value when the
 *  caller supplied one: a title promoted out of a dirty body must never win the
 *  message over the body itself. For `title` the verdict stays with the PROMOTED
 *  value (trim strips U+000B/U+000C, and validating the original would start
 *  refusing titles that are accepted today), while the coordinate is shifted back
 *  into the caller's argument by the peeled trim prefix — whitespace only, so the
 *  shift can neither hide nor manufacture a violation. */
const assertWriteText = (
  input: WriteInput,
  authored?: { title?: string; content?: string },
): void => {
  const content = authored !== undefined ? authored.content : input.content

  if (content != null && !isDurableText(content)) {
    const violation = firstDurableTextViolation(content)!

    throw invalidWrite(
      `content contains ${violationNoun(violation)} at line ${violation.line}, column ${violation.column}${violationTail(violation)}`,
    )
  }
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
    if (value == null) {
      continue
    }
    if (!isDurableText(value)) {
      const violation = firstDurableTextViolation(value)!
      // The verdict came from the PROMOTED title; the coordinate is named in the
      // caller's argument, at the index the promoted violator maps back to.
      const column =
        name === 'title' && authored?.title != null
          ? columnAt(
              authored.title,
              authored.title.length - authored.title.trimStart().length + violation.index,
            )
          : violation.column

      throw invalidWrite(
        `${name} contains ${violationNoun(violation)} at column ${column}${violationTail(violation)}`,
      )
    }
    if (!isDurableScalar(value)) {
      throw invalidWrite(`${name} must be a single-line string`)
    }
  }
  for (const value of Array.isArray(input.tags)
    ? input.tags
    : input.tags != null
      ? [input.tags]
      : []) {
    assertDurableTag(value)
  }
  if (input.frontmatter != null && !isDurableFrontmatter(input.frontmatter)) {
    throw invalidWrite('frontmatter contains invalid raw lines')
  }
  if (
    input.restorePath != null &&
    (!isDurableText(input.restorePath) ||
      !isCanonicalInternalRelativeAddress(input.restorePath) ||
      !input.restorePath.endsWith('.md'))
  ) {
    throw invalidWrite('restore path must be a canonical Markdown file path')
  }
  if (
    input.legacyPredecessorPath != null &&
    (!isDurableText(input.legacyPredecessorPath) ||
      !isCanonicalSafeRelativeAddress(input.legacyPredecessorPath) ||
      !input.legacyPredecessorPath.endsWith('.md'))
  ) {
    throw invalidWrite('legacy predecessor path must be a canonical Markdown file path')
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

// A source locator is an import identity, not a note id or a storage path. It is
// still a process-local mutation resource: two fresh creates of one source must
// serialize even when mutable display fields choose different canonical paths.
const sourceLocatorResource = (locator: string): string =>
  `\u0000import-source/${locator.length}:${locator}\u0000`

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
      assertDurableTag(tag)
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

        const payload: WriteInput = {
          title: live.title ?? '',
          content: live.content,
          originalId: live.id ?? input.id,
          versionToken: live.versionToken ?? computeVersionToken(live.content),
          tags,
          principal: input.principal,
          agent: input.agent,
          fileName: basenameOf(storagePath).replace(/\.md$/, ''),
        }

        // The same chokepoint check ordinary writes get: a pin is a write of the same
        // note, and letting it skip to the bare engine answers the user with that
        // engine's unaddressed refusal — the exact defect this grammar exists to fix.
        assertWriteText(payload)
        await this.writeClaimed(payload)
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
    const authored = { title: input.title, content: input.content }

    {
      const promoted = promoteBodyTitle(input.content ?? '', input.title)
      input =
        input.content !== undefined
          ? { ...input, title: promoted.title, content: promoted.body }
          : { ...input, title: promoted.title }
    }
    assertWriteText(input, authored)
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
      () => {
        const write = async () => {
          await opts?.prepare?.()
          const result = await this.writeClaimed(input, opts)
          await opts?.finalize?.()
          return result
        }

        return opts?.aroundWrite ? opts.aroundWrite(write) : write()
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
   *  an unindexed file on disk is the engine's to catch.
   *
   *  Answered from the snapshot's own path index, not by walking it. Every write
   *  asks this — the planned-destination guard, the collision policy, each step of
   *  the uniquify series — so a walk here is O(notes in the space) PER WRITE, which
   *  is the term that made an import quadratic from the read-model's side. The
   *  registry's `idFor` would be O(1) too but is not the same fact: with an
   *  identity-capable engine the registry is the ENGINE's, and the read-model's own
   *  copy is empty — the snapshot is the one answer that holds in both wirings. */
  private occupantOf(path: string, exceptId?: string): ExistingNote | undefined {
    for (const id of this.host.snap.notes.idsAt(path)) {
      const meta = id === exceptId ? undefined : this.host.snap.notes.get(id)

      // The meta itself still has to SAY it lives here. The index and the metas are
      // two structures kept in step by one class, and this answer is not merely
      // reported to a caller — the guard refuses on it and `applyWrite` DELETES the
      // note it names. A free comparison is the difference between a desynchronised
      // index costing a stale refusal and it costing the wrong note.
      if (meta && meta.filePath === path) {
        return { id, title: meta.title, filePath: meta.filePath }
      }
    }

    return undefined
  }

  /** The resolve table a write derives its edges and its link claims against.
   *  Inside an import bracket that is the BATCH table — it may lag the bracket's own
   *  additions and renames, and the bracket's close is what settles them: one
   *  deferred ghost pass for the links that resolved to nothing, one re-derivation
   *  of every source for the links that resolved to the wrong live note (see
   *  `Snapshot.batchIndex` and `CachedStore.flushBulkGraphContext`). Outside one,
   *  undefined: a lone write gets the exact table, and its links resolve the instant
   *  it returns. */
  private resolveIndex(): LinkIndex | undefined {
    return this.host.isBulkActive() ? this.host.snap.batchIndex() : undefined
  }

  private writeClaim(input: WriteInput) {
    const currentPath = input.originalId ? this.pathFor(input.originalId) : undefined
    const predictedPath = this.predictedPath(input, currentPath)
    const sourceClass = input.originalId
      ? this.host.snap.notes.get(input.originalId)?.class
      : (input.targetClass ?? DEFAULT_NOTE_CLASS)
    const linkedTargetIds =
      input.content !== undefined && isVisibleOn(SURFACE.graph, sourceClass ?? DEFAULT_NOTE_CLASS)
        ? this.host.snap.resolvedTargetIds(input.content, this.resolveIndex())
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
      resources:
        !input.originalId && input.sourceLocator
          ? [sourceLocatorResource(input.sourceLocator)]
          : undefined,
      noteIds: [input.originalId, input.id, this.host.identity.idFor(predictedPath)],
      paths: [
        currentPath,
        predictedPath,
        input.legacyPredecessorPath,
        ...linkedTargetIds.map((targetId) => linkTargetPath(targetId, sourceKey)),
      ],
    }
  }

  private async writeClaimed(rawInput: WriteInput, opts?: MutationOptions): Promise<WriteResult> {
    // Slug selection reads the snapshot, so it belongs inside the mutation
    // checkpoint with path selection and the physical write.
    const input = { ...rawInput, slug: this.uniqueSlug(rawInput) }
    const currentPath = input.originalId ? this.pathFor(input.originalId) : undefined
    const predictedPath = this.predictedPath(input, currentPath)

    // The planned-destination guard belongs to the layer that knows which NOTE a
    // path holds, and this is that layer. An engine can only ask the FILE what it
    // claims, and a file whose claim has not been materialised yet answers nothing —
    // which is how the two engines came to read the same situation differently. The
    // read-model is also the very view the plan was built from (`list()` after a
    // forced checkpoint), so the guard re-checks the plan's own premise. The engine
    // still re-proves it under its publishing swap: that check is about the race,
    // this one is about the owner. It runs BEFORE the collision policy below, so a
    // `skipExisting` import refuses a destination that changed hands instead of
    // reporting it as a note it skipped.
    // canon: docs/import.md#importing-a-markdown-tree-302
    if (input.expectedDestinationId !== undefined) {
      const owner = this.occupantOf(predictedPath)?.id ?? null

      if (input.expectedDestinationId === null) {
        // The plan expected a free path. An owner that is this very plan's id is the
        // same plan replaying after a crash; anything else appeared since planning.
        if (owner !== null && owner !== input.id) {
          throw destinationOwnerConflict(
            predictedPath,
            `is owned by ${owner}; the import planned to create it`,
          )
        }
      } else if (owner !== input.expectedDestinationId) {
        throw destinationOwnerConflict(
          predictedPath,
          owner ? `is owned by ${owner}, not ${input.expectedDestinationId}` : 'no longer exists',
        )
      }
    }
    if (!input.originalId && input.sourceLocator) {
      const owner = this.host.snap.notes
        .idsWithSourceLocator(input.sourceLocator)
        .find((id) => id !== input.id)

      if (owner) {
        throw destinationOwnerConflict(predictedPath, `source locator is already owned by ${owner}`)
      }
    }
    if (!input.originalId && input.legacyPredecessorPath) {
      const sourceLessPredecessor = this.host.snap.notes
        .idsAt(input.legacyPredecessorPath)
        .map((id) => this.host.snap.notes.get(id))
        .find(
          (meta) =>
            meta != null &&
            meta.filePath === input.legacyPredecessorPath &&
            meta.sourceLocator === undefined,
        )

      if (sourceLessPredecessor) {
        throw destinationOwnerConflict(
          input.legacyPredecessorPath,
          `contains a source-less legacy predecessor (${sourceLessPredecessor.id ?? 'unknown id'})`,
        )
      }
    }
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
      // One exact pre-write observation owns both the optional first-history
      // baseline and the physical-incarnation fence. A semantic version token
      // alone cannot distinguish byte-identical replacement generations.
      const live = input.originalId
        ? await this.host.inner.read(this.innerNoteKey(input.originalId), {
            identityOnly: supportsExactIdentityAddress(this.host.inner),
            ...(opts?.resourceAdmitted ? { resourceAdmitted: true } : {}),
          })
        : undefined

      if (live) {
        await opts?.assertCurrent?.(live)
      }
      if (live && !live.physicalIncarnation) {
        this.host.reconcileSoon()
        throw new StoreError(`exact storage incarnation is unavailable for ${input.originalId}`)
      }
      const baseline = live ? await this.baselineOf(input.originalId!, live) : undefined
      const releaseGraphTransition = this.host.beginGraphTransition()
      const requiredTrashRestore =
        input.journal?.kind === REVISION_KIND.restore && !input.originalId
      const requiredCompoundCreate = opts?.requiredRevision === true && !input.originalId
      const delayPublication = requiredTrashRestore || requiredCompoundCreate
      let restoreResult: WriteResult | undefined
      let restoreVersionToken: string | undefined
      let trashRestoreJournalCommitted = false

      try {
        const result = await this.host.inner.write(
          {
            ...input,
            originalId: input.originalId ? this.innerNoteKey(input.originalId) : input.originalId,
            identityOnly: Boolean(input.originalId),
            expectedSource: live?.physicalIncarnation,
          },
          opts?.resourceAdmitted ? { resourceAdmitted: true } : undefined,
        )
        restoreResult = result
        restoreVersionToken = result.versionToken
        const publishWrite = async () => {
          if (!result.id) {
            this.host.reconcileSoon()
            return
          }
          let writeEffect = NO_WRITE_SNAPSHOT_EFFECT
          const aliasesBefore = this.host.snap.notes.get(result.id)?.legacyNameAliases
          const removed: string[] = []

          this.host.afterNotesReady(() => {
            writeEffect = this.applyWrite(input, result, result.id!, undefined, false, removed)
          })
          const aliasContextChanged = legacyAliasesChanged(
            aliasesBefore,
            this.host.snap.notes.get(result.id)?.legacyNameAliases,
          )

          if (aliasContextChanged) {
            writeEffect = { ...writeEffect, graphChanged: true }
          }
          if (aliasContextChanged) {
            this.host.markInnerLinkIdentitiesDirty()
            this.host.syncInnerLinkIdentities()
          }
          if (writeEffect.directoryChanged || aliasContextChanged) {
            await this.host.rederiveGraphContext(
              result.filePath ? { upserts: [result.id], removed } : undefined,
            )
          }
          if (result.filePath) {
            this.host.emitChanged(
              [result.id],
              removed,
              writeEffect.graphChanged || aliasContextChanged,
            )
          }
        }

        if (!delayPublication) {
          await publishWrite()
        }
        const after = await this.readAfterWrite(input, result, undefined, opts?.resourceAdmitted)

        if (delayPublication && !after) {
          throw new Error('post-write exact read failed')
        }
        restoreVersionToken = after ? exactVersionToken(after) : undefined
        await this.journalWrite(
          input,
          result.id ?? input.originalId,
          baseline,
          after,
          result.class,
          opts?.requiredRevision,
        )
        if (opts?.beforePublish && result.id && restoreVersionToken) {
          await opts.beforePublish({ id: result.id, versionToken: restoreVersionToken })
        }
        trashRestoreJournalCommitted = delayPublication
        if (!after) {
          throw new Error('post-write exact read failed')
        }
        if (delayPublication) {
          await publishWrite()
        }

        return { ...result, title: input.title }
      } catch (err) {
        let failure: unknown = err

        if (
          requiredCompoundCreate &&
          !trashRestoreJournalCommitted &&
          restoreResult?.id &&
          restoreVersionToken
        ) {
          try {
            await this.rollbackUnjournaledTrashRestore(
              restoreResult.id,
              restoreResult,
              restoreVersionToken,
              opts?.resourceAdmitted,
            )
          } catch (rollbackErr) {
            this.host.reconcileSoon()
            failure = new AggregateError(
              [err, rollbackErr],
              'required create revision failed and the physical write could not be rolled back',
            )
          }
        } else if (
          requiredTrashRestore &&
          !trashRestoreJournalCommitted &&
          restoreResult?.id &&
          restoreVersionToken
        ) {
          const outcome = await this.requiredRestoreOutcome(
            restoreResult.id,
            input.journal!.sourceRevisionId,
          )

          if (outcome === 'committed') {
            trashRestoreJournalCommitted = true
          } else if (outcome === 'unknown') {
            this.host.reconcileSoon()
            failure = new AggregateError(
              [err],
              'trash restore journal outcome is unknown; physical state was preserved',
            )
          } else {
            try {
              await this.rollbackUnjournaledTrashRestore(
                restoreResult.id,
                restoreResult,
                restoreVersionToken,
              )
            } catch (rollbackErr) {
              this.host.reconcileSoon()
              failure = new AggregateError(
                [err, rollbackErr],
                'trash restore journal failed and the live restore could not be rolled back',
              )
            }
          }
        }
        if (trashRestoreJournalCommitted) {
          this.host.reconcileSoon()
        }
        throw failure
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
    let id = originalPath
      ? input.originalId!
      : (input.id ?? this.host.identity.idFor(predictedPath) ?? freshNoteId())
    // The engine speaks storage keys; this is the path the id binds to (or the
    // caller's raw key when the registry doesn't know it — the resolver channel).
    const storageKey = originalPath ?? input.originalId
    let live: NoteContent | undefined
    let capturedLegacyNameAliases: readonly string[] | undefined

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
        supportsExactIdentityAddress(this.host.inner)
          ? {
              identityOnly: true,
              ...(opts?.resourceAdmitted ? { resourceAdmitted: true } : {}),
            }
          : opts?.resourceAdmitted
            ? { resourceAdmitted: true }
            : undefined,
      )

      await opts?.assertCurrent?.(live)

      if (live.filePath !== storageKey) {
        throw noteNotFound(input.originalId)
      }
      const liveToken = exactVersionToken(live)

      if (liveToken !== input.versionToken) {
        throw versionConflict({
          ...live,
          id: live.id ?? input.originalId,
          versionToken: liveToken,
        })
      }
      if (live.title !== input.title || live.filePath !== predictedPath) {
        const record = await this.host.captureLegacyEvidence(id, live)

        id = record.id
        capturedLegacyNameAliases = record.legacyNameAliases
      }
    }
    const releaseGraphTransition = this.host.beginGraphTransition()
    const releaseIdentityPublication = !input.originalId
      ? this.host.beginIdentityPublication()
      : undefined
    let identityPublicationPending = false
    const requiredTrashRestore = input.journal?.kind === REVISION_KIND.restore && !input.originalId
    const requiredCompoundCreate = opts?.requiredRevision === true && !input.originalId
    const delayPublication = requiredTrashRestore || requiredCompoundCreate
    let restoreResult: WriteResult | undefined
    let restoreVersionToken: string | undefined
    let trashRestoreJournalCommitted = false
    // The notes this write displaced off its destination — the failure path below
    // needs them to say what it took away.
    const removed: string[] = []

    try {
      const result = await this.host.inner.write(
        {
          ...input,
          originalId: input.originalId
            ? this.innerNoteKey(input.originalId, storageKey)
            : storageKey,
          identityOnly: Boolean(input.originalId && supportsExactIdentityAddress(this.host.inner)),
          id,
          expectedSource: live?.physicalIncarnation,
        },
        opts?.resourceAdmitted ? { resourceAdmitted: true } : undefined,
      )
      restoreResult = result
      restoreVersionToken = result.versionToken
      const publishAfterIdentityFlush = !input.originalId && !this.host.isBulkActive()

      let writeEffect = NO_WRITE_SNAPSHOT_EFFECT

      const publishWrite = async () => {
        const aliasesBefore = this.host.snap.notes.get(id)?.legacyNameAliases

        this.host.afterNotesReady(() => {
          writeEffect = this.applyWrite(input, result, id, originalPath, false, removed)
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
        const aliasContextChanged = legacyAliasesChanged(
          aliasesBefore,
          this.host.snap.notes.get(id)?.legacyNameAliases,
        )

        if (aliasContextChanged) {
          writeEffect = { ...writeEffect, graphChanged: true }
        }
        if (publishAfterIdentityFlush || aliasContextChanged) {
          this.host.markInnerLinkIdentitiesDirty()
          this.host.syncInnerLinkIdentities()
        }
        if (writeEffect.directoryChanged || aliasContextChanged) {
          await this.host.rederiveGraphContext(
            result.filePath ? { upserts: [id], removed } : undefined,
          )
        }
        if (!publishAfterIdentityFlush && result.filePath) {
          this.host.emitChanged([id], removed, writeEffect.graphChanged || aliasContextChanged)
        }
      }

      if (!delayPublication) {
        await publishWrite()
      }

      // The post-write read serves double duty: the fresh token the save
      // answers with (the engine merges frontmatter — input bytes are not
      // authoritative) and the journaled after-state.
      let after = await this.readAfterWrite(input, result, storageKey, opts?.resourceAdmitted)

      if (
        !input.originalId &&
        after?.title != null &&
        after.filePath != null &&
        legacyNoteNameAlias(after.title, after.filePath)
      ) {
        const aliasesBefore = this.host.snap.notes.get(id)?.legacyNameAliases

        const previousId = id
        const record = await this.host.captureLegacyEvidence(previousId, after)

        id = record.id
        capturedLegacyNameAliases = record.legacyNameAliases
        if (id !== previousId) {
          const materialize = this.host.inner.materializeIdentityAtPath?.bind(this.host.inner)

          if (!materialize || !after.filePath) {
            this.host.reconcileSoon()
            throw new StoreError(`reminted identity cannot be materialized for ${previousId}`)
          }
          const materialized = await materialize({
            filePath: after.filePath,
            expectedClaimId: previousId,
            targetId: id,
          })

          if (materialized.status !== 'materialized') {
            this.host.reconcileSoon()
            throw new StoreError(
              // `unwritable` is a refusal by the BYTES, not a claim that moved — saying
              // "changed" sends the reader hunting for a writer that was never there.
              materialized.status === 'unwritable'
                ? `identity cannot be written into ${previousId}: ${materialized.reason}`
                : `reminted identity changed before materialization for ${previousId}`,
            )
          }
          this.host.identity.markMaterialized(id)
          after = await this.readAfterWrite(input, result, storageKey, opts?.resourceAdmitted)
          if (!after) {
            throw new Error('post-remint exact read failed')
          }
        }
        const meta = this.host.snap.notes.get(id)

        if (meta) {
          this.host.snap.notes.set(id, {
            ...meta,
            legacyNameAliases: [...capturedLegacyNameAliases],
          })
        }
        if (legacyAliasesChanged(aliasesBefore, capturedLegacyNameAliases)) {
          writeEffect = { ...writeEffect, graphChanged: true }
          this.host.markInnerLinkIdentitiesDirty()
          this.host.syncInnerLinkIdentities()
          await this.host.rederiveGraphContext(
            result.filePath ? { upserts: [id], removed } : undefined,
          )
        }
      }
      const baseline =
        live && !(await this.hasHistory(id))
          ? {
              content: live.content,
              logicalState: exactLogicalState(live),
              documentState: exactDocumentState(live),
              title: live.title ?? input.title,
              tags: normTags(live.frontmatter?.tags) ?? [],
              // The note's pre-edit custom slug, so the baseline is slug-faithful too.
              slug: live.slug ?? null,
            }
          : undefined

      if (delayPublication && !after) {
        throw new Error('post-write exact read failed')
      }
      restoreVersionToken = after ? exactVersionToken(after) : undefined
      await this.journalWrite(input, id, baseline, after, result.class, opts?.requiredRevision)
      if (opts?.beforePublish && restoreVersionToken) {
        await opts.beforePublish({ id, versionToken: restoreVersionToken })
      }
      trashRestoreJournalCommitted = delayPublication
      if (!after) {
        throw new Error('post-write exact read failed')
      }
      if (delayPublication) {
        await publishWrite()
      }
      // Flush a fresh id before answering: a create's id may be resolved in the very next request,
      // but global id→space resolution reads the meta-DB, not this write-behind registry, so a read
      // that beat the flush would 404 a note that exists. Updates skip it (already durable). Bulk
      // import skips the per-note flush (a starvation source) — the bulk controller's
      // broadcast flushes the registry before each coalesced `changed` instead, so
      // durability tracks visibility.
      if (publishAfterIdentityFlush) {
        await this.host.flushIdentityPublication()
        if (result.filePath) {
          this.host.emitChanged([id], removed, writeEffect.graphChanged)
        }
      }

      return {
        ...result,
        id,
        title: input.title,
        versionToken: exactVersionToken(after),
        legacyNameAliases:
          result.legacyNameAliases ??
          capturedLegacyNameAliases ??
          this.host.identity.recordFor(id)?.legacyNameAliases,
      }
    } catch (err) {
      let failure: unknown = err

      if (
        requiredCompoundCreate &&
        !trashRestoreJournalCommitted &&
        restoreResult &&
        restoreVersionToken
      ) {
        try {
          await this.rollbackUnjournaledTrashRestore(
            id,
            restoreResult,
            restoreVersionToken,
            opts?.resourceAdmitted,
          )
        } catch (rollbackErr) {
          this.host.reconcileSoon()
          failure = new AggregateError(
            [err, rollbackErr],
            'required create revision failed and the physical write could not be rolled back',
          )
        }
      } else if (
        requiredTrashRestore &&
        !trashRestoreJournalCommitted &&
        restoreResult &&
        restoreVersionToken
      ) {
        const outcome = await this.requiredRestoreOutcome(id, input.journal!.sourceRevisionId)

        if (outcome === 'committed') {
          trashRestoreJournalCommitted = true
        } else if (outcome === 'unknown') {
          this.host.reconcileSoon()
          failure = new AggregateError(
            [err],
            'trash restore journal outcome is unknown; physical state was preserved',
          )
        } else {
          try {
            await this.rollbackUnjournaledTrashRestore(id, restoreResult, restoreVersionToken)
          } catch (rollbackErr) {
            this.host.reconcileSoon()
            failure = new AggregateError(
              [err, rollbackErr],
              'trash restore journal failed and the live restore could not be rolled back',
            )
          }
        }
      }
      if (trashRestoreJournalCommitted) {
        this.host.reconcileSoon()
      }
      if (identityPublicationPending) {
        // A stand-in for the id set as it was BEFORE this create — reconstructed
        // here rather than copied up front, because "up front" meant copying the
        // whole corpus on every successful write to serve a branch only a failure
        // reaches. It is NOT that set: the map moved under it while this write was
        // awaiting. What the frame derives from it is `before \ current`, so the
        // union above resolves to exactly the notes THIS write displaced and did not
        // put back — which is what the frame owes its subscribers. A note some other
        // writer deleted meanwhile is in neither term and is not reported here; that
        // writer publishes its own frame.
        this.host.rememberIdentityRepair(new Set([...this.host.snap.notes.keys(), ...removed]))
      }
      throw failure
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
    if (input.restorePath) {
      return input.restorePath
    }
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

    // Whether a file is the package ROOT is a mount-relative question and this layer holds
    // full storage paths only — `<pkg>/references/SKILL.md` ends like a manifest and is an
    // auxiliary. The engine answers it where the mount is known, and `preservePath` is how
    // that answer arrives; a basename read here predicted a rename the engine did not make.
    if (
      currentPath &&
      (input.preservePath ||
        (currentMeta?.title === input.title &&
          input.fileName == null &&
          dir === directoryOf(currentPath)))
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

  /** The note as the engine actually stored it — null when the read-back fails.
   * Callers record an honest gap and fail the response: title/body input is not
   * authoritative after an engine has merged or normalised frontmatter. */
  private async readAfterWrite(
    input: WriteInput,
    result: WriteResult,
    storageKey?: string,
    resourceAdmitted = false,
  ): Promise<NoteContent | null> {
    try {
      const resultId = result.id ?? input.originalId
      const exactPath = result.filePath ?? storageKey

      // The write just returned this storage path while its mutation claim is
      // still held. A bare engine can read it directly and verify the answer,
      // avoiding a full id→path registry rebuild after every create in a bulk
      // import. Interactive/stale-id operations still use the exact envelope.
      if (!this.host.inner.capabilities.identity && exactPath) {
        const detail = await this.host.inner.read(
          exactPath,
          resourceAdmitted ? { resourceAdmitted: true } : undefined,
        )

        return detail.filePath === exactPath ? detail : null
      }

      const key = resultId ? this.innerNoteKey(resultId, exactPath) : (exactPath ?? input.title)

      return await this.host.inner.read(
        key,
        supportsExactIdentityAddress(this.host.inner) && resultId
          ? { identityOnly: true, ...(resourceAdmitted ? { resourceAdmitted: true } : {}) }
          : resourceAdmitted
            ? { resourceAdmitted: true }
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

  /** Pre-write state for the journal baseline, projected from the same exact
   *  observation that supplies the identity-capable engine's physical fence. */
  private async baselineOf(
    noteId: string,
    live: NoteContent,
  ): Promise<
    | {
        content: string
        logicalState: LogicalNoteState
        documentState: DocumentState
        title: string
        tags: string[]
        slug: string | null
      }
    | undefined
  > {
    if (await this.hasHistory(noteId)) {
      return undefined
    }

    return {
      content: live.content,
      logicalState: exactLogicalState(live),
      documentState: exactDocumentState(live),
      title: live.title ?? '',
      tags: normTags(live.frontmatter?.tags) ?? [],
      // The custom slug the note already carried, so a restore of the baseline
      // brings it back too. null = no custom slug (the implicit default).
      slug: live.slug ?? null,
    }
  }

  /** Queue the write's journal revision. Ordinary saves stay fire-and-forget;
   * trash restore awaits the row because the permanent-purge decision is made
   * against that exact journal state. */
  private journalWrite(
    input: WriteInput,
    noteId: string | undefined,
    baseline?: {
      content: string
      logicalState: LogicalNoteState
      documentState: DocumentState
      title: string
      tags?: string[]
      slug?: string | null
    },
    after?: NoteContent | null,
    /** The written note's class, from the engine's WriteResult (mount-
     *  derived, authoritative). Recorded so the cursor-based delta can class-scope
     *  . Falls back to the create intent / the snapshot; the journal
     *  carries it forward on later body-less revisions. */
    cls?: string | null,
    required = false,
  ): Promise<void> {
    if (!noteId) {
      return Promise.resolve()
    }
    // The custom slug this write records — the same storedSlug the snapshot
    // mirror (applyWrite) uses (input already softened by uniqueSlug at write()): an
    // unaddressed slug stays `undefined` so the journal carries the PRIOR REVISION's
    // forward; a clear/collapse-to-default ('') records null. (applyWrite carries the
    // snapshot's prior slug instead — same sequence, different store.)
    const slugCh = storedSlug(input.slug, input.title)
    const content = after?.content ?? null
    const logicalState = after ? exactLogicalState(after) : null
    const documentState = after ? exactDocumentState(after) : null

    const record = {
      noteId,
      kind: input.journal?.kind ?? REVISION_KIND.write,
      principal: input.principal ?? null,
      agent: input.agent,
      content,
      logicalState,
      documentState,
      title: after?.title ?? input.title,
      class: cls ?? input.targetClass ?? this.host.snap.notes.get(noteId)?.class ?? null,
      slug: after ? (after.slug ?? null) : slugCh === undefined ? undefined : slugCh || null,
      tags: after ? (normTags(after.frontmatter?.tags) ?? []) : undefined,
      sourceRevisionId: input.journal?.sourceRevisionId,
      baseline,
    }

    if (required || (input.journal?.kind === REVISION_KIND.restore && !input.originalId)) {
      return this.host.journal.recordRequired(record).then(() => undefined)
    }
    void this.host.journal.record(record)
    return Promise.resolve()
  }

  /** A trash restore writes a new file before its journal row can acquire the
   * cross-replica persistence lock, while its read-model patch remains hidden.
   * If permanent purge wins that lock, the required append fails and this
   * conditionally compensates the physical write. */
  private async rollbackUnjournaledTrashRestore(
    id: string,
    result: WriteResult,
    versionToken: string,
    resourceAdmitted = false,
  ): Promise<void> {
    const path = result.filePath ?? this.pathFor(id)

    // The read-model deliberately has not published this restore yet, so its
    // id→path hints still describe a tombstone. Address the engine by the exact
    // path returned from the physical write; the identity envelope would sync
    // those old hints and make a path-keyed engine miss the just-created row.
    if (resourceAdmitted && path && this.host.inner.removeDir) {
      await this.host.inner.removeDir(directoryOf(path), {
        internalAddress: true,
        resourceAdmitted: true,
      })
    } else {
      await this.host.inner.remove(path ?? this.innerNoteKey(id), {
        identityOnly: path ? false : supportsExactIdentityAddress(this.host.inner),
        versionToken,
        physicalWriteClaim: result.physicalWriteClaim,
      })
    }
    if (path) {
      if (!this.host.identity.recordFor(id)) {
        this.host.identity.bindOwnedId(path, id)
      }
      this.host.identity.markDeleted(path)
    }
  }

  /** A required append may commit and then lose its acknowledgement. The unique
   * tombstone source id correlates the committed restore without trusting the
   * rejected promise. Unknown journal availability preserves physical bytes. */
  private async requiredRestoreOutcome(
    noteId: string,
    sourceRevisionId: string,
  ): Promise<'committed' | 'not-committed' | 'unknown'> {
    try {
      // Cross-process writers are not serialized by this instance's queue. Do not
      // cap the lookup to a recent page: the correlated restore may already have
      // moved behind arbitrary externally appended revisions when the ACK is lost.
      const { items } = await this.host.journal.list(noteId, {
        offset: 0,
        limit: 2_147_483_647,
      })

      return items.some(
        (revision) =>
          revision.kind === REVISION_KIND.restore && revision.sourceRevisionId === sourceRevisionId,
      )
        ? 'committed'
        : 'not-committed'
    } catch {
      return 'unknown'
    }
  }

  async move(input: MoveInput, opts?: MutationOptions): Promise<MoveResult> {
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
      await this.mutations.runStable(
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
      return {}
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
        let live = await this.host.inner.read(this.innerNoteKey(input.id, claimedPath), {
          identityOnly: supportsExactIdentityAddress(this.host.inner),
        })

        await opts?.assertCurrent?.(live)
        const capturedRecord = this.host.inner.capabilities.identity
          ? null
          : await this.host.captureLegacyEvidence(input.id, live)
        const finalId = capturedRecord?.id ?? input.id
        const capturedAliases = capturedRecord?.legacyNameAliases ?? live.legacyNameAliases

        if (!live.physicalIncarnation) {
          this.host.reconcileSoon()
          throw new StoreError(`exact storage incarnation is unavailable for ${input.id}`)
        }
        const identityRedirected = finalId !== input.id

        if (identityRedirected) {
          const materialize = this.host.inner.materializeIdentityAtPath?.bind(this.host.inner)

          if (!materialize || !claimedPath) {
            this.host.reconcileSoon()
            throw new StoreError(`reminted identity cannot be materialized for ${input.id}`)
          }
          const expectedClaimId =
            live.physicalIncarnation.owner.kind === 'claimed'
              ? live.physicalIncarnation.owner.id
              : null
          const materialized = await materialize({
            filePath: claimedPath,
            expectedClaimId,
            targetId: finalId,
          })

          if (materialized.status !== 'materialized') {
            this.host.reconcileSoon()
            throw new StoreError(
              materialized.status === 'unwritable'
                ? `identity cannot be written into ${input.id}: ${materialized.reason}`
                : `reminted identity changed before materialization for ${input.id}`,
            )
          }
          this.host.identity.markMaterialized(finalId)
          live = await this.host.inner.read(this.innerNoteKey(finalId, claimedPath), {
            identityOnly: supportsExactIdentityAddress(this.host.inner),
          })
          if (
            live.filePath !== claimedPath ||
            !live.physicalIncarnation ||
            live.physicalIncarnation.owner.kind !== 'claimed' ||
            live.physicalIncarnation.owner.id !== finalId
          ) {
            this.host.reconcileSoon()
            throw new StoreError(`reminted identity is unproven for ${finalId}`)
          }
        }
        const releaseGraphTransition = this.host.beginGraphTransition()

        try {
          const result = await this.host.inner.move({
            ...input,
            id: this.innerNoteKey(finalId, claimedPath),
            identityOnly: supportsExactIdentityAddress(this.host.inner),
            expectedSource: live.physicalIncarnation,
          })
          const finalPath = result.filePath ?? input.destinationPath
          const finalAliases = result.legacyNameAliases ?? capturedAliases
          let directoryChanged = false
          const aliasesBefore = this.host.snap.notes.get(finalId)?.legacyNameAliases
          this.host.afterNotesReady(() => {
            directoryChanged = this.applyNoteMove(finalId, finalPath, claimedPath, finalAliases)
          })
          const aliasContextChanged = legacyAliasesChanged(aliasesBefore, finalAliases)

          this.host.markInnerLinkIdentitiesDirty()
          this.host.syncInnerLinkIdentities()
          if (directoryChanged || aliasContextChanged) {
            await this.host.rederiveGraphContext({ upserts: [finalId], removed: [] })
          }
          await opts?.finalize?.()
          if (identityRedirected) {
            await this.host.flushIdentityPublication()
          } else {
            this.host.emitChanged([finalId], [])
          }

          return {
            ...result,
            id: finalId,
            filePath: finalPath,
            legacyNameAliases: finalAliases,
          }
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

  async remove(id: string, opts?: RemoveOptions): Promise<void> {
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
            await this.host.rederiveGraphContext({ upserts: [], removed: [] })
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
    if (
      !(opts?.internalAddress
        ? isCanonicalInternalRelativeAddress(path)
        : isCanonicalSafeRelativeAddress(path))
    ) {
      throw folderFailed('path must be a canonical relative path')
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

            if (this.host.inner.removeDir) {
              if (opts?.internalAddress) {
                const captured: RemovalCapture[] = []

                await this.host.inner.removeDir(path, {
                  internalAddress: true,
                  beforeDetach: async () => {
                    await opts?.beforeDetach?.(victims)
                    for (const id of victims) {
                      captured.push(await this.captureRemoval(id, { resourceAdmitted: true }))
                    }
                  },
                  afterDetach: async () => {
                    for (const state of captured) {
                      await this.removeClaimed(state.id, opts, state, true)
                    }
                  },
                })
              } else {
                for (const id of victims) {
                  await this.removeClaimed(id, opts)
                }
                await this.host.inner.removeDir(path)
              }
              let directoryChanged = false
              this.host.afterNotesReady(() => {
                directoryChanged = this.host.dirs.removeSubtree(path)
              })
              if (directoryChanged) {
                await this.host.rederiveGraphContext({ upserts: [], removed: [] })
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

  private async captureRemoval(
    id: string,
    options: Pick<RemoveOptions, 'assertCurrent'> & { resourceAdmitted?: boolean } = {},
  ): Promise<RemovalCapture> {
    const storagePath = this.pathFor(id)
    const meta = this.host.snap.notes.get(id)
    const inboundSources = [...this.host.snap.sourceIdsTargeting([id])]

    // A repeated/stale delete must not manufacture a fresh tombstone after a
    // successful permanent purge. The live snapshot/path binding is the
    // admission fact; both engine implementations otherwise treat a missing
    // physical remove as an idempotent no-op.
    if (!storagePath && !meta) {
      throw noteNotFound(id)
    }
    // Capture the body BEFORE deleting: the trash is only a safety net if it
    // can resurrect the note, and a note never saved through us has no journaled
    // body to fall back on. One exact read on a rare op buys an always-restorable
    // tombstone and the physical incarnation required by conditional delete. A
    // failed or unprovable read aborts before effect and schedules reconciliation.
    let lastContent: string | null = null
    let lastLogicalState: LogicalNoteState | null = null
    let lastDocumentState: DocumentState | null = null
    let lastTags: string[] | undefined
    let lastClass: NoteClass | undefined
    let lastTitle: string | undefined
    // `undefined` only while the live read hasn't run / failed (→ carry the journal's
    // last slug forward); a successful read sets it DEFINITIVELY (string | null).
    let lastSlug: string | null | undefined

    let live: NoteContent

    try {
      live = await this.host.inner.read(this.innerNoteKey(id, storagePath), {
        identityOnly: supportsExactIdentityAddress(this.host.inner),
        ...(options.resourceAdmitted ? { resourceAdmitted: true } : {}),
      })
      await options.assertCurrent?.(live)
      lastContent = live.content
      lastLogicalState = exactLogicalState(live)
      lastDocumentState = exactDocumentState(live)
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
    } catch (err) {
      this.host.reconcileSoon()
      throw err
    }
    if (!live.physicalIncarnation) {
      this.host.reconcileSoon()
      throw new StoreError(`exact storage incarnation is unavailable for ${id}`)
    }
    if (!this.host.inner.capabilities.identity) {
      const record = await this.host.captureLegacyEvidence(id, live)

      id = record.id
    }

    return {
      id,
      storagePath,
      meta,
      inboundSources,
      lastContent,
      lastLogicalState,
      lastDocumentState,
      lastTags,
      lastClass,
      lastTitle,
      lastSlug,
      physicalIncarnation: live.physicalIncarnation,
      removesLegacyAliasOwner: Boolean(
        live.legacyNameAliases?.length || meta?.legacyNameAliases?.length,
      ),
    }
  }

  private async removeClaimed(
    id: string,
    opts?: RemoveOptions,
    capture?: RemovalCapture,
    physicallyDetached = false,
  ): Promise<void> {
    const state = capture ?? (await this.captureRemoval(id, { assertCurrent: opts?.assertCurrent }))
    const {
      storagePath,
      meta,
      inboundSources,
      lastContent,
      lastLogicalState,
      lastDocumentState,
      lastTags,
      lastClass,
      lastTitle,
      lastSlug,
      physicalIncarnation,
      removesLegacyAliasOwner,
    } = state

    id = state.id
    const releaseGraphTransition = this.host.beginGraphTransition()

    try {
      // From the first physical mutation through the tombstone, snapshot removal,
      // exact-identity refresh and inbound re-derivation, no fresh graph surface
      // may observe the inner engine and read-model on opposite sides.
      // A package removal detaches the whole directory first, so its notes are
      // already gone from storage by the time each one is journalled.
      if (!physicallyDetached) {
        await this.host.inner.remove(this.innerNoteKey(id, storagePath), {
          identityOnly: supportsExactIdentityAddress(this.host.inner),
          expectedSource: physicalIncarnation,
        })
      }
      const lastPath = storagePath ?? meta?.filePath
      // The tombstone revision: carries the final body (a blob in the CAS) so
      // the undelete flow resurrects the exact last state. When the read above
      // failed, content is null and the journal keeps the last known hash instead.
      // Agent package deletion opts into recordRequired: its single tombstone is
      // part of the operation, and an append failure escapes this after-detach
      // callback so the engine can rename the staged package back. Ordinary human
      // deletion keeps the historical best-effort journal behaviour.
      const record: JournalRecordInput = {
        noteId: id,
        kind: REVISION_KIND.delete,
        principal: opts?.principal ?? null,
        agent: opts?.agent,
        content: lastContent,
        logicalState: lastLogicalState,
        documentState: lastDocumentState,
        title: lastDocumentState?.projection?.skill?.title ?? meta?.title ?? lastTitle ?? '',
        class: meta?.class ?? lastClass,
        // Prefer the live snapshot's slug, fall back to the read; undefined (a
        // cold-boot delete that read neither) carries the prior slug forward.
        slug: meta?.slug ?? lastSlug,
        tags: lastTags,
      }

      if (opts?.requiredRevision) {
        await this.host.journal.recordRequired(record)
      } else {
        await this.host.journal.record(record)
      }
      // Tombstone the id↔path binding only after a required recovery point exists.
      // A failed required append must leave both the physical package and this
      // process's identity projection live for a clean retry.
      if (lastPath) {
        if (!this.host.identity.recordFor(id)) {
          this.host.identity.bindOwnedId(lastPath, id)
        }
        this.host.identity.markDeleted(lastPath)
      }
      // Single-note restore resolves tombstones from the durable causal
      // authority, not this process's warm registry. Publish the tombstone before
      // delete returns so an immediate restore cannot observe the old live row.
      await this.host.flushIdentityPublication()
      let snapshotRemoved = false

      this.host.afterNotesReady(() => {
        this.host.previewCache.delete(id)
        this.host.noteFactsCache.delete(id)
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
        if (removesLegacyAliasOwner) {
          await this.host.rederiveGraphContext({ upserts: [], removed: [id] })
        } else {
          await this.host.rederiveSources(inboundSources)
        }
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
  ): WriteSnapshotEffect {
    if (!result.filePath) {
      // Engine didn't tell us where the note landed — let the feed catch up.
      this.host.reconcileSoon()
      return NO_WRITE_SNAPSHOT_EFFECT
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
        this.host.noteFactsCache.delete(pathOwner)
        this.host.snap.edgesBySource.delete(pathOwner)
        removed.push(pathOwner)
      }
      if (pathOwner !== id) {
        this.host.identity.bindOwnedId(newPath, id, input.createdAt)
      }
      // The engine wrote the id into the file's frontmatter with this call.
      this.host.identity.markMaterialized(id)
    } else {
      // The engine owns identity; still surface a displaced note when the
      // write upserted onto a path another snapshot entry held. Asked of the path
      // index rather than by walking the snapshot: this runs on every write, and
      // the answer is almost always "nobody". The copy is because the loop body
      // unbinds the very list it reads.
      for (const otherId of [...this.host.snap.notes.idsAt(newPath)]) {
        if (otherId !== id) {
          this.host.snap.notes.delete(otherId)
          this.host.previewCache.delete(otherId)
          this.host.noteFactsCache.delete(otherId)
          this.host.snap.edgesBySource.delete(otherId)
          removed.push(otherId)
        }
      }
    }
    const prev = this.host.snap.notes.get(id)
    const wasGraphVisible = Boolean(
      prev && isVisibleOn(SURFACE.graph, prev.class ?? DEFAULT_NOTE_CLASS),
    )
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
    const incomingTags = input.frontmatter
      ? frontmatterEntryOf(input.frontmatter, 'tags')
      : undefined
    const incomingSourceLocator = input.frontmatter
      ? frontmatterEntryOf(input.frontmatter, IMPORT_SOURCE_FRONTMATTER_KEY)
      : undefined
    const incomingSlugValue = incomingSlug && frontmatterEntryValue(incomingSlug)
    const replacing = input.frontmatterMode === 'replace'
    const carriedAliases =
      incomingAliases !== undefined
        ? (normAliases(frontmatterEntryValue(incomingAliases)) ?? [])
        : replacing
          ? []
          : prev?.aliases
    const carriedSlug =
      incomingSlug !== undefined
        ? typeof incomingSlugValue === 'string'
          ? slugify(incomingSlugValue) || undefined
          : undefined
        : replacing
          ? undefined
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
      !replacing &&
      !input.preserveAliases &&
      input.originalId &&
      prev &&
      (prev.title !== input.title || prevEffSlug !== newEffSlug),
    )
    const aliases =
      renamed && prev
        ? nextAliasesMulti(prev.aliases, [prev.title, prevEffSlug!], [input.title, newEffSlug])
        : carriedAliases
    // Tags on the optimistic snapshot: the just-saved note is tag-filterable
    // immediately, without waiting for the delta poll. Mirror the engine's write
    // semantics — `undefined` LEAVES the prior tags, a value SETS them, `[]` clears.
    const carriedTags =
      incomingTags !== undefined
        ? (normTags(frontmatterEntryValue(incomingTags)) ?? [])
        : replacing
          ? []
          : prev?.tags
    const tags = input.tags === undefined ? carriedTags : (normTags(input.tags) ?? [])
    const rawSourceLocator = incomingSourceLocator
      ? frontmatterEntryValue(incomingSourceLocator)
      : undefined
    const sourceLocator =
      input.sourceLocator ??
      (replacing
        ? isImportNoteSourceLocator(rawSourceLocator)
          ? rawSourceLocator
          : undefined
        : prev?.sourceLocator)
    const nextMeta: NoteMeta = {
      id,
      title: input.title,
      ...(slug ? { slug } : {}),
      ...(aliases?.length ? { aliases } : {}),
      ...(result.legacyNameAliases?.length
        ? { legacyNameAliases: [...result.legacyNameAliases] }
        : rec?.legacyNameAliases.length
          ? { legacyNameAliases: [...rec.legacyNameAliases] }
          : {}),
      ...(tags?.length ? { tags } : {}),
      ...(sourceLocator ? { sourceLocator } : {}),
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
    }

    this.host.snap.notes.set(id, nextMeta)
    // Write-through keeps the preview warm too: the very snippet the Feed will
    // ask for next is computed here, from data the save already carried.
    // The caller's own text, not a parsed body: an editor may send a leading inline block
    // that the serializer folds into the file's frontmatter a moment later. This is the
    // one preview producer that holds unparsed bytes, so it answers for the block HERE.
    this.host.previewCache.set(id, derivePreview(stripFrontmatter(input.content ?? ''), input.tags))
    // Exact write merging (raw frontmatter carry-forward, title projection) belongs
    // to the engine. Drop the old fact and let the next context read derive once
    // from the published file; this adds no parsing work to bulk import.
    this.host.noteFactsCache.delete(id)
    const directoryChanged = this.host.dirs.add(directoryOf(newPath))
    // Directory context is part of the resolver index, so add it before deriving
    // even this note's own outbound edges.
    // Ghost re-resolution walks EVERY ghost and, when one resolves, every
    // source's edges — so per note it is O(corpus). A bulk import closes a ghost
    // on almost every write (each new note is the target the previous one linked
    // forward to), which made an import quadratic. Bulk already coalesces the
    // graph and re-derives it once at the end; the ghost pass joins it there.
    // The table this derives against joins it too: taking the exact one here
    // rebuilt it on every write — the note the write just published moved the very
    // counter the memo is keyed on — so the corpus was walked per note anyway, one
    // layer down from the loop that was fixed. Under the bracket both halves defer.
    const edgesChanged = this.host.snap.patchNoteEdges(id, input.content ?? '', {
      index: this.resolveIndex(),
      deferReresolve: this.host.isBulkActive(),
    })
    const isGraphVisible = isVisibleOn(SURFACE.graph, nextMeta.class ?? DEFAULT_NOTE_CLASS)
    const graphChanged =
      removed.length > 0 ||
      edgesChanged ||
      ((wasGraphVisible || isGraphVisible) && graphInputsChanged(prev, nextMeta))
    // `removed` is the ids this one write displaced from its path binding — identity
    // bookkeeping of at most a couple of registry rows, never document-sized.
    // eslint-disable-next-line no-restricted-syntax
    removedOut?.push(...removed)

    if (publish) {
      this.host.emitChanged([id], removed, graphChanged)
    }

    return { directoryChanged, graphChanged }
  }

  private applyNoteMove(
    id: string,
    destinationPath: string,
    oldPath?: string,
    legacyNameAliases?: readonly string[],
  ): boolean {
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
      ...(legacyNameAliases ? { legacyNameAliases: [...legacyNameAliases] } : {}),
      modifiedAt: this.host.iso(),
    })
    const directoryChanged = this.host.dirs.add(directoryOf(destinationPath))
    return directoryChanged
  }
}
