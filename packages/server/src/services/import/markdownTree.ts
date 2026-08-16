// Markdown-tree import: the zero-write classification/preflight pass that turns
// an untrusted ZIP into a frozen plan, and the executing pass that replays it.
//
// The invariant this file exists for: BEFORE the first note is written, the
// archive has one immutable classification and a complete plan — every
// importable member, its canonical destination, its date and its identity
// metadata. The executing pass adds no decisions of its own, which is what makes
// a durable retry land on exactly the same notes.
// canon: docs/import.md#importing-a-markdown-tree-302

import { createReadStream, promises as fs } from 'node:fs'
import { chain } from 'stream-chain'
import { parser } from 'stream-json'
import { streamArray } from 'stream-json/streamers/stream-array.js'

import {
  detectFromArrayItem,
  detectSingleObject,
  freshNoteId,
  FrontmatterLimitError,
  IMPORT_FORMAT,
  ImportError,
  type ImportFormat,
  type ImportNote,
  isImportTextPath,
  isMemoryObject,
  isMemoryRecord,
  markdownFileToNote,
  normTags,
  NOTE_ID_FRONTMATTER_KEY,
  noteFilePath,
} from '@notarium/core'
import { serializeNoteFile } from '@notarium/engine'

import { serializedImportPlanBytes } from '../../libs/importStaging'
import { safeRelAddress } from '../../libs/relPath'
import {
  ARCHIVE_KIND,
  IMPORT_DETAIL_CAP,
  IMPORT_PROGRESS_EVERY,
  type ImportSourceKind,
  MAX_ARCHIVE_ENTRIES,
  MAX_COMPRESSION_RATIO,
  MAX_MARKDOWN_TREE_EXPANDED_BYTES,
  MAX_MARKDOWN_TREE_METADATA_BYTES,
  MAX_PROBE_EXPANDED_BYTES,
  MEMBER_BYTE_CAP,
  MEMORY_OBJECT_CAP,
  PLAN_ENTRY_OVERHEAD_BYTES,
  PLAN_SETTLED_ENTRY_BYTES,
  TEXT_FILE_CAP,
} from './consts'
import { underRoot } from './helpers'
import type { ArchiveClassification, MarkdownTreePlanEntry, MarkdownTreePlanV1 } from './types'
import {
  drainMember,
  forEachZipMember,
  type MemberVisit,
  openZip,
  readMemberText,
  withExtractedMember,
  type ZipEntry,
  type ZipMember,
} from './zipArchive'

/** Charged per central-directory entry on top of its encoded name: an archive's
 *  metadata cost is dominated by its entry COUNT, and a 100 000-header archive
 *  must hit a ceiling before it hits the heap. Deliberately smaller than a
 *  planned entry's overhead — an ignored member never becomes a plan entry. */
const ARCHIVE_ENTRY_METADATA_OVERHEAD_BYTES = 64

const isTreeTextMember = (path: string, forcedMarkdown: boolean): boolean =>
  forcedMarkdown ? isImportTextPath(path) : /\.md$/i.test(path)

/** JSON shapes the auto classifier probes for a recognised foreign export. */
const JSON_MEMBER = /\.(json|jsonl)$/i

/** Regex sniff for the single-object memory shape (chooses the read-whole path
 *  over JSONL streaming) — the same predicate the foreign path uses. */
const looksLikeMemoryObject = (prefix: string): boolean => /"(entities|relations)"\s*:/.test(prefix)

/** A structural failure of the plan itself — the archive no longer matches what
 *  was frozen, or a planned destination changed owner. Deterministic by nature,
 *  so it fails the job TERMINALLY (a retry re-reads the same bytes and reaches
 *  the same conflict) while carrying the work already done. */
export class ImportPlanConflictError extends ImportError {
  constructor(
    message: string,
    /** Bounded summary of what this run completed before the conflict. */
    readonly partial?: unknown,
  ) {
    super(message)
    this.name = 'ImportPlanConflictError'
  }
}

/** A TREE ceiling was hit. Tagged rather than subclassed, following the store's
 *  own refusal idiom: the tag is what separates the two questions a failed member
 *  can raise. A STRUCTURAL refusal says "this member is not plannable"; a ceiling
 *  says "the plan may not grow past here". Both are held until the walk has decided
 *  what the archive IS, but only a ceiling also narrows the walk — a plan that may
 *  not grow is not worth building.
 *
 *  Narrowing the walk is all it does. The archive's own counters keep running
 *  underneath (see the walk below): they describe the upload, not the plan, and
 *  switching them off with the plan left the rest of an archive walked with no
 *  ceiling at all. */
const BUDGET_REFUSAL = 'import_budget'

const budgetRefusal = (message: string): ImportError => {
  const err = new ImportError(message) as ImportError & { reason?: string }

  err.reason = BUDGET_REFUSAL

  return err
}

const isBudgetRefusal = (err: unknown): boolean =>
  (err as { reason?: string } | null)?.reason === BUDGET_REFUSAL

/** Every ceiling classification enforces, as one injectable value. Production
 *  always passes the constants below; the seam exists so the limits can be
 *  proven at test scale instead of by building a six-gigabyte fixture — and so
 *  each counter is provably wired to its OWN limit (a header the archive
 *  declares and the bytes that actually arrive are different facts).
 *
 *  TWO families, and the split is the point rather than tidiness.
 *
 *  The PLAN ceilings — entries, declared bytes, real bytes, metadata, the
 *  per-file cap — are charged for a MARKDOWN TREE. An archive that turns out to be
 *  a foreign export pays none: it never did before #302, and making it pay made
 *  the same set of members classify differently depending on the order the ZIP
 *  lists them in. So they are HELD, never thrown where they fire.
 *
 *  The PROBE ceilings bound what answering "is this archive a foreign export?" is
 *  allowed to inflate into temp. That question is asked on BOTH paths and outlives
 *  every held plan ceiling — it is still being asked after the plan has stopped
 *  growing — so it is metered on its own. Holding a refusal is what keeps the
 *  verdict order-free; it must not also be a licence to inflate the rest of the
 *  archive to disk.
 *
 *  The compression ratio belongs to neither family and is the one ceiling that can
 *  act where it fires: see `isDecompressionBomb`.
 *  canon: docs/import.md#resource-limits-on-a-markdown-tree-302 */
export type ArchiveLimits = {
  maxEntries: number
  /** Ceiling on the summed `uncompressedSize` HEADERS. */
  maxDeclaredExpandedBytes: number
  /** Ceiling on the bytes really read — the one an archive cannot lie about. */
  maxExpandedBytes: number
  maxMetadataBytes: number
  maxCompressionRatio: number
  maxMarkdownBytes: number
  /** Ceiling on ONE probe's extraction. A member too large to read whole is not an
   *  export we could parse either, so crossing it answers the question — "not a
   *  recognised export" — instead of refusing the archive. Per member and therefore
   *  order-free, which is why it is allowed to answer at all. */
  maxProbeMemberBytes: number
  /** Ceiling on what ALL the probes of one classification inflate together. Unlike
   *  every ceiling above it is thrown where it fires: it says nothing about what the
   *  archive is, only that finding out has already cost more than an archive is
   *  allowed to expand to, and there is nothing left to buy by continuing. */
  maxProbeBytes: number
}

export const DEFAULT_ARCHIVE_LIMITS: ArchiveLimits = {
  maxEntries: MAX_ARCHIVE_ENTRIES,
  maxDeclaredExpandedBytes: MAX_MARKDOWN_TREE_EXPANDED_BYTES,
  maxExpandedBytes: MAX_MARKDOWN_TREE_EXPANDED_BYTES,
  maxMetadataBytes: MAX_MARKDOWN_TREE_METADATA_BYTES,
  maxCompressionRatio: MAX_COMPRESSION_RATIO,
  maxMarkdownBytes: TEXT_FILE_CAP,
  maxProbeMemberBytes: MEMBER_BYTE_CAP,
  maxProbeBytes: MAX_PROBE_EXPANDED_BYTES,
}

export type ClassifyArchiveArgs = {
  uploadPath: string
  /** Private temp dir for the probes' extracted members; owned by the caller. */
  tempDir: string
  /** The staged upload this plan will be keyed by. */
  uploadRef: string
  /** Explicit format, when the caller forced one. */
  format?: ImportFormat
  /** Only the server-built browser bridge may reinterpret its private comments. */
  sourceKind?: ImportSourceKind
  /** Destination root the archive tree is reproduced under. */
  root: string
  signal?: AbortSignal
  /** Heartbeat during the scan, called once every `IMPORT_PROGRESS_EVERY` members.
   *
   *  Neither the lease nor the cancel depends on it, and claiming either was wrong
   *  twice: the runner refreshes the lease on a timer of its own, and the same timer
   *  aborts the signal when the row stops being ours — a preflight that reported
   *  nothing would still be canceled, at the next tick. What this adds is a
   *  PUBLISHED phase from inside a pass that otherwise says nothing for its whole
   *  duration, and a caller-raised failure at a member boundary rather than a
   *  half-read member torn down by an abort. */
  onScanProgress?: (scanned: number) => void | Promise<void>
  /** Host-internal test seam; production uses `DEFAULT_ARCHIVE_LIMITS`. */
  limits?: ArchiveLimits
}

/** A member claiming an expansion ratio no honest packer produces: a zip bomb by
 *  its own header, refused before a single byte is decompressed.
 *
 *  Kept out of the budget below because it is the one ceiling that answers about a
 *  SINGLE member from its header alone. Every counter in the budget is cumulative,
 *  so where it fires depends on where the ZIP lists its members, and it can only be
 *  HELD; this one gives the same answer about the same member wherever the member
 *  appears. That is what lets it act rather than accumulate — the member is not
 *  decompressed by anybody, neither planned nor probed — without handing the
 *  archive's classification to its entry order. Inflating a declared bomb to find
 *  out what it is has already spent exactly what the guard exists to save. */
const isDecompressionBomb = (member: ZipMember, limits: ArchiveLimits): boolean =>
  !member.isDirectory &&
  member.compressedBytes > 0 &&
  member.declaredBytes / member.compressedBytes > limits.maxCompressionRatio

/** Accumulates every cumulative ceiling in one place so a violation reads as one
 *  sentence and can never be enforced in two different spellings. */
const createBudget = (limits: ArchiveLimits) => {
  let entries = 0
  let metadataBytes = 0
  let declaredBytes = 0
  let actualBytes = 0
  let probedBytes = 0

  const chargeMetadata = (bytes: number) => {
    metadataBytes += bytes
    if (metadataBytes > limits.maxMetadataBytes) {
      throw budgetRefusal('archive metadata is too large to plan — refusing to import it')
    }
  }

  return {
    get actualBytes() {
      return actualBytes
    },
    /** Charge one central-directory record, before its name enters any map.
     *
     *  Charged for EVERY member the walk hands over, including the ones it reaches
     *  after a ceiling has already fired. How many records an archive holds and what
     *  they declare is true of the upload whatever it is classified as — the plan is
     *  what stops growing, not the archive. */
    entry: (member: ZipMember) => {
      if (++entries > limits.maxEntries) {
        throw budgetRefusal(
          `archive declares more than ${limits.maxEntries} entries — refusing to import it`,
        )
      }
      chargeMetadata(Buffer.byteLength(member.name) + ARCHIVE_ENTRY_METADATA_OVERHEAD_BYTES)
      if (member.isDirectory) {
        return
      }
      declaredBytes += member.declaredBytes
      if (declaredBytes > limits.maxDeclaredExpandedBytes) {
        throw budgetRefusal('archive declares more expanded data than the import limit allows')
      }
    },
    /** Charge bytes that REALLY arrived for the TREE. The declared total above is a
     *  header the archive author writes; this one they cannot lie about. */
    bytes: (n: number) => {
      actualBytes += n
      if (actualBytes > limits.maxExpandedBytes) {
        throw budgetRefusal('archive expands past the import limit')
      }
    },
    /** Charge bytes a foreign-format probe really inflated into temp — the same
     *  cannot-lie-about measure as `bytes`, over the other question.
     *
     *  Deliberately NOT a budget refusal: this is the one ceiling here that is not
     *  held. A held refusal keeps the tree verdict out of the hands of entry order,
     *  and holding is affordable exactly because the plan stops growing with it.
     *  Nothing stops growing when the probes are the ones spending, so held would
     *  mean unbounded. */
    probeBytes: (n: number) => {
      probedBytes += n
      if (probedBytes > limits.maxProbeBytes) {
        throw new ImportError(
          'classifying this archive expands past the import limit — refusing to import it',
        )
      }
    },
    /** Charge a planned entry's serialized shape BEFORE it is accumulated. */
    planEntry: (entry: MarkdownTreePlanEntry) => {
      chargeMetadata(Buffer.byteLength(JSON.stringify(entry)) + PLAN_ENTRY_OVERHEAD_BYTES)
    },
  }
}

/** Detection-only probe of one JSON/JSONL member: which foreign format is this,
 *  if any? Deliberately separate from the parsers — classification must not emit
 *  a single note. The MCP-memory shapes come first because the generic detectors
 *  return null for them by design.
 *
 *  Every read below takes the signal. Reading is the expensive part of a probe
 *  (up to `MEMORY_OBJECT_CAP` whole), so a cancel that only reached the archive
 *  would leave this running against a temp file nobody is waiting for. */
const probeForeignFormat = async (
  path: string,
  signal?: AbortSignal,
): Promise<ImportFormat | null> => {
  const prefix = await peekStart(path, signal)
  const first = prefix.trimStart()[0]

  if (first === '{' && (firstLineIsMemory(prefix) || looksLikeMemoryObject(prefix))) {
    return IMPORT_FORMAT.memoryJson
  }
  if (first === '[') {
    return await probeArrayHead(path, signal)
  }
  if (first === '{') {
    const { size } = await fs.stat(path)

    if (size > MEMORY_OBJECT_CAP) {
      return null
    }
    // The read is OUTSIDE the try on purpose: unparseable JSON is "not a
    // recognised export", but an aborted read is not an answer about the file at
    // all, and swallowing it would report a canceled probe as a verdict.
    const raw = await fs.readFile(path, { encoding: 'utf8', signal })

    try {
      return detectSingleObject(JSON.parse(raw))
    } catch {
      return null
    }
  }

  return null
}

/** First ~256 KB as text — enough to sniff array-vs-object and read one line. */
const peekStart = async (path: string, signal?: AbortSignal): Promise<string> => {
  if (signal?.aborted) {
    throw new Error('import canceled')
  }
  const fh = await fs.open(path, 'r')

  try {
    const { buffer, bytesRead } = await fh.read(Buffer.alloc(256 * 1024), 0, 256 * 1024, 0)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    await fh.close()
  }
}

const firstLineIsMemory = (prefix: string): boolean => {
  const line = prefix.split(/\r?\n/).find((l) => l.trim())

  if (!line) {
    return false
  }
  try {
    return isMemoryRecord(JSON.parse(line.trim()))
  } catch {
    return false
  }
}

/** Stream a JSON array only as far as the first meaningful element — a 600 MB
 *  conversations.json must not be materialised to answer "is this ChatGPT?". */
const probeArrayHead = async (path: string, signal?: AbortSignal): Promise<ImportFormat | null> => {
  const readStream = createReadStream(path, { signal })
  const source = chain([readStream, parser(), streamArray()])
  let sniffed = 0

  try {
    for await (const { value } of source as AsyncIterable<{ value: unknown }>) {
      const format = detectFromArrayItem(value)

      if (format) {
        return format
      }
      if (++sniffed >= 10) {
        return null
      }
    }
  } catch (err) {
    if (signal?.aborted) {
      throw err // a canceled read says nothing about the file — do not call it a verdict
    }

    return null // unparseable JSON is simply not a recognised export
  } finally {
    readStream.destroy()
  }

  return null
}

/** Whether a JSONL/object member is the MCP memory graph — probed on the whole
 *  object only when the cheap prefix sniff already suggested it. */
const isMemoryObjectFile = async (path: string, signal?: AbortSignal): Promise<boolean> => {
  const { size } = await fs.stat(path)

  if (size > MEMORY_OBJECT_CAP) {
    return false
  }
  const raw = await fs.readFile(path, { encoding: 'utf8', signal })

  try {
    return isMemoryObject(JSON.parse(raw))
  } catch {
    return false
  }
}

/** The archive-relative directory and basename of an importable member, or an
 *  ImportError naming exactly why the path is refused. A `.md` we cannot place
 *  is FATAL, never a silent skip: dropping a note the user can see in their
 *  vault is the failure mode this import exists to remove. */
const memberAddress = (member: ZipMember): { directory: string; base: string } => {
  const canonical = safeRelAddress(member.name)

  if (canonical === null || !canonical) {
    throw new ImportError(`${member.name}: unsafe path in archive — refusing to import it`)
  }
  const cut = canonical.lastIndexOf('/')

  return {
    directory: cut === -1 ? '' : canonical.slice(0, cut),
    base: cut === -1 ? canonical : canonical.slice(cut + 1),
  }
}

/** Prove the note this member becomes can actually be WRITTEN, using the real
 *  serializer with the typed fields the write path will add. A source that is
 *  fine on its own but overflows the frontmatter cap once `title:`/`created:`/
 *  the identity are added must fail here — after the first write it would be a
 *  partial import instead of a refused one.
 *
 *  The preview id is a fresh one rather than the settled target: ids are
 *  fixed-width, so the byte count is exact, and identity settlement happens
 *  after this pass by design. */
const proveWritable = (note: ImportNote, member: ZipMember): void => {
  try {
    serializeNoteFile({
      title: note.title,
      noteType: note.noteType,
      tags: normTags(note.tags),
      id: freshNoteId(),
      createdAt: note.createdAt,
      frontmatter: note.frontmatter,
      body: note.body,
      existingRaw: null,
    })
  } catch (err) {
    if (err instanceof FrontmatterLimitError) {
      throw new ImportError(`${member.name}: ${err.message}`)
    }
    throw new ImportError(`${member.name}: ${(err as Error).message}`)
  }
}

export const classifyImportArchive = async ({
  uploadPath,
  tempDir,
  uploadRef,
  format,
  sourceKind,
  root,
  signal,
  onScanProgress,
  limits = DEFAULT_ARCHIVE_LIMITS,
}: ClassifyArchiveArgs): Promise<ArchiveClassification> => {
  const forcedMarkdown = format === IMPORT_FORMAT.markdown
  // Canonical once, then carried IN the plan. The executing pass reads this value
  // back instead of independently normalizing the job param, so a sidecar has one
  // spelling of where every destination lives.
  const plannedRoot = safeRelAddress(root)
  const budget = createBudget(limits)
  const entries: MarkdownTreePlanEntry[] = []
  const destinations = new Map<string, string>()
  const sources = new Map<string, string>()
  const ignoredFiles: string[] = []
  let ignoredCount = 0
  let deferredDrain = 0
  let foreign: ImportFormat | null = null
  /** The first refusal this archive earned AS A TREE, held rather than thrown:
   *  whether it is a tree at all is not settled until the walk ends. */
  let treeRefusal: Error | null = null
  /** A ceiling has fired. The PLAN stops growing here — the numbers those ceilings
   *  guard are the plan's — and the walk narrows to the one question a ceiling does
   *  not answer. The archive's own counters below are not part of that narrowing:
   *  they keep running to the last member. */
  let ceilingHit = false
  let scanned = 0
  const zipfile = await openZip(uploadPath)

  /** Record an ignored member: counted exactly, named boundedly. */
  const sample = (member: ZipMember): void => {
    ignoredCount++
    if (ignoredFiles.length < IMPORT_DETAIL_CAP) {
      ignoredFiles.push(member.name)
    }
  }

  /** Which recognised foreign export this JSON member is, if any.
   *
   *  Charged to no tree budget: a probe reads in order to answer "is this archive a
   *  tree?", and charging that to the ceilings that only apply once the answer is
   *  yes is what let the tree's own budget decide the classification. It is charged
   *  to its OWN two, because "not the tree's" is not the same as "free" — the tree
   *  budget stops being spent the moment a tree ceiling is held, and this one keeps
   *  spending, whole members at a time, into a temp directory. */
  const probeMember = async (entry: ZipEntry): Promise<ImportFormat | null> => {
    const tooLarge = new ImportError('archive member is too large')
    let read = 0

    try {
      return await withExtractedMember(
        zipfile,
        entry,
        tempDir,
        (bytes) => {
          // Aggregate first: it refuses the ARCHIVE, while the per-member cap below
          // only answers a question about this one member.
          budget.probeBytes(bytes)
          read += bytes
          if (read > limits.maxProbeMemberBytes) {
            throw tooLarge
          }
        },
        async (path, probeSignal) => {
          const found = await probeForeignFormat(path, probeSignal)

          // The memory prefix sniff is a regex; confirm the real shape before
          // letting an ordinary JSON member with an "entities" key hijack the
          // whole archive's classification.
          return found === IMPORT_FORMAT.memoryJson && !(await isMemoryLikeFile(path, probeSignal))
            ? null
            : found
        },
        signal,
      )
    } catch (err) {
      // Identity, not a message or a tag: this is the one error this call raises
      // itself, and everything else — an abort, an unreadable archive — belongs to
      // the caller.
      if (err !== tooLarge) {
        throw err
      }

      return null
    }
  }

  /** Ask the narrowed question and nothing else. Nothing is sampled or planned —
   *  those belong to a plan that is no longer being built — but the reading is
   *  metered exactly as before, by the probe's own budget: the walk narrowed, the
   *  archive did not stop being untrusted. */
  const probeOnlyMember = async (member: ZipMember, entry: ZipEntry): Promise<MemberVisit> => {
    if (
      forcedMarkdown ||
      member.isDirectory ||
      member.isContainerNoise ||
      !JSON_MEMBER.test(member.name)
    ) {
      return 'continue'
    }
    const detected = await probeMember(entry)

    if (detected) {
      foreign = detected

      return 'stop'
    }

    return 'continue'
  }

  /** The full walk, while this archive can still become a tree. */
  const planMember = async (member: ZipMember, entry: ZipEntry): Promise<MemberVisit> => {
    // Directory records and container noise are structure, not user files:
    // neither imported nor counted as something the user lost.
    if (member.isDirectory || member.isContainerNoise) {
      return 'continue'
    }
    if (isTreeTextMember(member.name, forcedMarkdown)) {
      try {
        const { directory, base } = memberAddress(member)

        if (plannedRoot === null || safeRelAddress(underRoot(plannedRoot, directory)) === null) {
          throw new ImportError(`${member.name}: unsafe destination directory`)
        }
        let expandedBytes = 0
        const raw = await readMemberText(
          zipfile,
          entry,
          limits.maxMarkdownBytes,
          (n) => {
            expandedBytes += n
            budget.bytes(n)
          },
          signal,
        )
        const note = markdownFileToNote(raw, base, member.modifiedAt ?? undefined)

        proveWritable(note, member)
        // The final directory is proven safe here, but the plan stores the
        // ROOT-RELATIVE destination: repeating a long root 10 000 times is the
        // difference between a plan of kilobytes and one of megabytes. Since the
        // root is constant for the whole plan, a collision on the relative key is
        // a collision on the final one.
        const destinationPath = noteFilePath(note.title, directory, note.fileName, undefined, true)
        const clash = destinations.get(destinationPath)

        if (clash) {
          throw new ImportError(
            `${member.name}: destination collision with ${clash} at ${destinationPath}`,
          )
        }
        destinations.set(destinationPath, member.name)
        // Two files claiming ONE identity cannot both be mapped, and picking a
        // winner would silently drop the other's inbound links. Refuse instead.
        if (note.sourceId) {
          const twin = sources.get(note.sourceId)

          if (twin) {
            throw new ImportError(
              `${member.name}: duplicate ${NOTE_ID_FRONTMATTER_KEY} claim, also held by ${twin}`,
            )
          }
          sources.set(note.sourceId, member.name)
        }
        const planEntry: MarkdownTreePlanEntry = {
          archivePath: member.name,
          directory,
          fileName: note.fileName,
          destinationPath,
          expandedBytes,
          ...(member.modifiedAt ? { sourceCreatedAt: member.modifiedAt } : {}),
          ...(note.sourceId ? { sourceId: note.sourceId } : {}),
        }

        budget.planEntry(planEntry)
        entries.push(planEntry)
      } catch (err) {
        // A markdown member that cannot be planned refuses the TREE, and whether
        // this archive IS a tree is not settled yet: a recognised foreign export
        // later in the central directory wins it outright, and that export never
        // needed this member read at all. Holding the refusal until the walk has
        // answered keeps the verdict out of the hands of the order a zip happens
        // to list its members in.
        //
        // A member past the per-file cap arrives here untagged and STAYS untagged:
        // it is one member that will not be planned, not a statement about the
        // archive. Retagging it as a ceiling narrowed the walk one member earlier —
        // and nothing else, because a narrowed walk changes no verdict and the
        // reading it saves is bounded by the aggregate ceiling either way. A tag
        // with no observable consequence is a claim, not a mechanism.
        if (isBudgetRefusal(err)) {
          throw err
        }
        treeRefusal ??= err as Error
      }

      return 'continue'
    }
    // A JSON member is the one kind that can still settle what this archive IS, so
    // it is opened before it is written off as ignored. The probe answers the
    // FOREIGN question and is metered as that question's cost, not the tree's.
    if (!forcedMarkdown && JSON_MEMBER.test(member.name)) {
      const detected = await probeMember(entry)

      if (detected) {
        foreign = detected

        return 'stop'
      }
    }
    // Anything the branches above did not claim is an ordinary ignored member:
    // never decoded, never materialised, and — for now — not even read. Its REAL
    // bytes still have to be metered, including a JSON member the probe just
    // declined, but only a TREE ever needs that number and whether this archive is
    // one is not settled until the walk ends. See `drainIgnoredMembers` below.
    //
    // Reaching this line IS `isDrainOnlyMember`: the three branches above are its
    // three clauses, in its own order. Asking it again here read as a guard and
    // evaluated as a constant — what actually holds the two passes to one set of
    // members is the count they are compared by, below.
    deferredDrain++
    sample(member)

    return 'continue'
  }

  /** Hold a refusal instead of raising it. Whether this archive is a tree at all is
   *  not settled until the walk ends, and a refusal raised where it fires put the
   *  verdict in the hands of the order a ZIP lists its members in: the same members
   *  with the JSON first classified as a foreign export, and with the JSON last were
   *  refused for entries, declared bytes or actual bytes. The foreign path was never
   *  metered by any of this before #302 and is not now. */
  const hold = (err: Error): void => {
    treeRefusal ??= err
    // A ceiling holds a second thing besides the refusal: the plan may not grow
    // past here, so the walk narrows to the one question a ceiling does not answer.
    ceilingHit ||= isBudgetRefusal(err)
  }

  await forEachZipMember(
    zipfile,
    async (member, entry) => {
      // Charged for every member the archive has, whatever the walk has already
      // decided about it. These counters describe the UPLOAD — how many records its
      // central directory holds, how much its headers claim they expand to — and
      // narrowing the walk after a ceiling used to switch them off along with the
      // plan they were confused with, which left every member after the first
      // refusal walked, and read, against no ceiling at all.
      try {
        budget.entry(member)
      } catch (err) {
        // `entry` raises nothing but ceilings, so this rethrow does not execute
        // today and is not here for coverage: HOLDING is what discards a refusal
        // when the archive turns out to be foreign, and a bug held that way would
        // be discarded with it. Only a ceiling may be held.
        if (!isBudgetRefusal(err)) {
          throw err
        }
        hold(err as Error)
      }
      if (++scanned % IMPORT_PROGRESS_EVERY === 0) {
        await onScanProgress?.(scanned)
      }
      // The one refusal that is about this member and nothing else, so the one that
      // can act where it fires: a member its own header calls a bomb is decompressed
      // by nobody — not planned, and not probed either.
      if (isDecompressionBomb(member, limits)) {
        hold(budgetRefusal(`${member.name}: suspicious compression ratio — refusing to import it`))

        return 'continue'
      }
      if (ceilingHit) {
        return await probeOnlyMember(member, entry)
      }
      try {
        return await planMember(member, entry)
      } catch (err) {
        if (!isBudgetRefusal(err)) {
          throw err
        }
        hold(err as Error)

        // The member the ceiling fired on may itself be the export that settles it.
        return await probeOnlyMember(member, entry)
      }
    },
    signal,
    sourceKind,
  )

  if (foreign) {
    return { kind: ARCHIVE_KIND.foreign }
  }
  if (treeRefusal) {
    throw treeRefusal
  }
  if (!entries.length) {
    throw new ImportError(
      forcedMarkdown
        ? 'No Markdown files found in the upload (expected an archive of .md files).'
        : 'No recognised export files found in the upload (expected a Claude/ChatGPT conversations.json, a Claude projects.json, an MCP memory.json, or a Claude memories/design-chats export).',
    )
  }
  // Ordered on purpose, and the drain is LAST of the four. Each check above already
  // knows the answer, and draining first would inflate an archive's every attachment
  // to meter a plan that was never going to exist — which is the cost the deferral
  // was introduced to avoid, paid on the one path where nothing is even planned.
  if (deferredDrain) {
    const drained = await drainIgnoredMembers({
      uploadPath,
      onBytes: budget.bytes,
      onScanProgress,
      signal,
      forcedMarkdown,
      sourceKind,
    })

    // The COUNT is what holds the two passes to one set of members, and it is the
    // whole guarantee: the classification walk arrives at this set by exhausting its
    // branches, the drain pass selects it by asking `isDrainOnlyMember`, and only
    // agreeing on how many there were proves the two spellings still mean the same
    // thing. It also catches the other half — the second walk must see the same
    // archive the first one did. The staged upload is immutable, so a mismatch is our
    // bug, not bad input; it still refuses the import rather than planning one it did
    // not measure.
    if (drained !== deferredDrain) {
      throw new ImportError('archive could not be measured consistently — refusing to import it')
    }
  }
  const plan: MarkdownTreePlanV1 = {
    version: 1,
    uploadRef,
    // A tree has at least one planned Markdown entry, and that branch refuses a
    // null root before it can add one. The assertion records that proof for TS.
    root: plannedRoot!,
    entriesTotal: entries.length,
    expandedBytes: budget.actualBytes,
    ignored: {
      count: ignoredCount,
      files: ignoredFiles,
      ...(ignoredCount > ignoredFiles.length
        ? { filesOmitted: ignoredCount - ignoredFiles.length }
        : {}),
    },
    entries,
  }

  // The accumulated charge above bounds the plan as it is built. What a sidecar
  // actually costs is the SETTLED plan, though — identity settlement runs after
  // this pass and adds three fields to every entry — so the artifact is proven at
  // its published size, settlement reserve included. Measuring the unsettled plan
  // here was a cap on a document that is never written.
  const sidecarBytes = serializedImportPlanBytes(plan) + entries.length * PLAN_SETTLED_ENTRY_BYTES

  if (sidecarBytes > limits.maxMetadataBytes) {
    throw new ImportError('archive metadata is too large to plan — refusing to import it')
  }

  return { kind: ARCHIVE_KIND.markdownTree, plan }
}

/** Meter every ignored member's REAL bytes, once the archive is known to be a
 *  tree.
 *
 *  Deferred rather than drained in the classification walk, and the reason is a
 *  measurement: a foreign export that ships a 40 MB blob before its
 *  `conversations.json` paid ~300 ms to inflate bytes nobody would ever look at,
 *  because the walk could not yet know a recognised export was coming. Nothing is
 *  weakened by waiting — the ceiling this enforces exists to catch a dishonest
 *  `uncompressedSize`, and it still runs before the plan is returned and
 *  therefore before the first write. A foreign archive skips it entirely, which
 *  is correct: those members are never read at all on that path. */
const drainIgnoredMembers = async ({
  uploadPath,
  onBytes,
  onScanProgress,
  signal,
  forcedMarkdown,
  sourceKind,
}: {
  uploadPath: string
  onBytes: (bytes: number) => void
  onScanProgress?: (scanned: number) => void | Promise<void>
  signal?: AbortSignal
  forcedMarkdown: boolean
  sourceKind?: ImportSourceKind
}): Promise<number> => {
  const zipfile = await openZip(uploadPath)
  let drained = 0

  await forEachZipMember(
    zipfile,
    async (member, entry) => {
      if (!isDrainOnlyMember(member, forcedMarkdown)) {
        return 'continue'
      }
      await drainMember(zipfile, entry, onBytes, signal)
      // The same heartbeat the classification walk gives: inflating an archive's
      // attachments is the longest stretch of a preflight, and the phase it reports
      // is the only sign of life a caller gets across it. (Neither the lease nor the
      // cancel rides on it — the runner refreshes one and raises the other on a timer
      // of its own, whatever a handler reports.)
      if (++drained % IMPORT_PROGRESS_EVERY === 0) {
        await onScanProgress?.(drained)
      }

      return 'continue'
    },
    signal,
    sourceKind,
  )

  return drained
}

/** Members whose only cost is their bytes: not structure, not noise, not Markdown.
 *  A JSON member the classifier opened and declined is one of them — the probe read
 *  it to answer a different question and charged the tree nothing for it.
 *
 *  The rule as the DRAIN pass asks it. The classification walk reaches the same set
 *  by falling through its own branches instead of asking again, because there the
 *  question is already answered and a second call read as a guard while evaluating
 *  to a constant. The two are tied together by the count they are compared by, not
 *  by sharing this call. */
const isDrainOnlyMember = (member: ZipMember, forcedMarkdown: boolean): boolean =>
  !member.isDirectory && !member.isContainerNoise && !isTreeTextMember(member.name, forcedMarkdown)

/** Confirm a memory-shaped member really is one (JSONL first line or the whole
 *  `{entities,relations}` object). */
const isMemoryLikeFile = async (path: string, signal?: AbortSignal): Promise<boolean> => {
  const prefix = await peekStart(path, signal)

  if (firstLineIsMemory(prefix)) {
    return true
  }
  if (!looksLikeMemoryObject(prefix)) {
    return false
  }

  return await isMemoryObjectFile(path, signal)
}

/** Generic in the ENTRY, not fixed to the preflight shape: the executing pass
 *  replays whatever plan it is handed, and production only ever hands it a
 *  settled one — the parameter is what carries that guarantee through to the
 *  writer instead of making it re-check three fields per entry. */
export type MarkdownTreeRunArgs<E extends MarkdownTreePlanEntry = MarkdownTreePlanEntry> = {
  uploadPath: string
  plan: Omit<MarkdownTreePlanV1, 'entries'> & { entries: E[] }
  signal?: AbortSignal
  /** Called once per planned member, in archive order, awaited (backpressure). */
  onEntry: (note: ImportNote, entry: E) => Promise<void>
}

/** Replay the frozen plan: reopen the archive, and for each planned member (and
 *  ONLY those) re-read its bytes, re-parse it and hand it to the writer. No
 *  destination, date or identity is derived here — deriving one again is exactly
 *  how a retry would diverge from the run it is resuming. */
export const runMarkdownTreePlan = async <E extends MarkdownTreePlanEntry>({
  uploadPath,
  plan,
  signal,
  onEntry,
}: MarkdownTreeRunArgs<E>): Promise<void> => {
  const pending = new Map(plan.entries.map((entry) => [entry.archivePath, entry]))
  const zipfile = await openZip(uploadPath)

  await forEachZipMember(
    zipfile,
    async (member, entry) => {
      const planned = pending.get(member.name)

      if (!planned) {
        return 'continue'
      }
      pending.delete(member.name)
      let bytes = 0
      const raw = await readMemberText(
        zipfile,
        entry,
        TEXT_FILE_CAP,
        (n) => {
          bytes += n
        },
        signal,
      )

      // The staged upload is immutable, so a member that no longer matches the
      // frozen plan means the plan is not describing this archive. Retargeting
      // silently is the one outcome forbidden here.
      if (bytes !== planned.expandedBytes) {
        throw new ImportPlanConflictError(
          `${member.name}: archive member changed since the import was planned`,
        )
      }
      // The parser derives the title fallback and the deterministic storage name
      // from the basename, so it must be handed the SAME string preflight used.
      const note = markdownFileToNote(raw, memberAddress(member).base, planned.sourceCreatedAt)

      await onEntry(note, planned)

      return pending.size ? 'continue' : 'stop'
    },
    signal,
  )

  if (pending.size) {
    const [missing] = pending.keys()

    throw new ImportPlanConflictError(`${missing}: planned archive member is missing`)
  }
}
