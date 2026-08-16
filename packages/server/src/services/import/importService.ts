// Import orchestration: classify the upload, then write each note through
// store.write.
//
// Two shapes reach this file. A FOREIGN export (Claude/ChatGPT/MCP memory) is
// parsed and written in one streaming pass, as it always has been. A MARKDOWN
// TREE is planned first — a complete zero-write pass over the archive — and only
// then executed, because reproducing a folder tree means every destination,
// collision and identity must be known before the first file lands.
// canon: docs/import.md#data-path · docs/import.md#importing-a-markdown-tree-302

import { NOTE_CLASS } from '@notarium/contract'
import {
  directoryOf,
  IF_EXISTS,
  type IfExists,
  IMPORT_FORMAT,
  IMPORT_SOURCE,
  type ImportFormat,
  type ImportNote,
  type KnowledgeStore,
  noteFilePath,
  rewriteWikilinkIdentities,
  STORE_ERROR_REASON,
  WikilinkRewriteError,
  type WriteInput,
} from '@notarium/core'

import { safeRelAddress } from '../../libs/relPath'
import { ImportFenceError } from '../metaDb/importFence'
import { IMPORT_PHASE, IMPORT_PROGRESS_EVERY, type ImportSourceKind } from './consts'
import { underRoot } from './helpers'
import {
  assertSettledPlanFits,
  asSettledPlan,
  identityMapOf,
  type IdentityPlanStore,
  settleTreeIdentities,
} from './identityPlan'
import { classifyImportArchive, ImportPlanConflictError, runMarkdownTreePlan } from './markdownTree'
import { isZipFile, streamImportFile } from './streamImport'
import { createSummaryCollector, type ImportSummary, type SummaryCollector } from './summary'
import type { ImportReservationPort } from './types'
import type {
  ImportPlanStore,
  ImportProgress,
  SettledMarkdownTreePlanV1,
  SettledPlanEntry,
} from './types'

/** The persisted phases that prove this job's write gate was never opened, and
 *  therefore the only ones under which a missing plan may be rebuilt. `null` is a
 *  row that never reported a phase at all — a job still pending. */
const PHASES_BEFORE_WRITING = new Set<string | null>([null, IMPORT_PHASE.planning])

export type { ImportFileResult, ImportSummary } from './summary'

/** Destination for memory.json entities: user-doc folder, the space's agent-memory
 *  mount, or skip. canon: docs/note-model.md#agent-memory */
export type MemoryMode = 'folder' | 'space' | 'skip'

/** Map an ImportNote to a create WriteInput.
 */
const toWriteInput = (
  n: ImportNote,
  directory: string,
  root: string,
  principal: string,
  opts: {
    targetClass?: 'agent-memory'
    ifExists: IfExists
    id?: string
    expectedDestinationId?: string | null
  },
): WriteInput => ({
  // The settled identity of a planned tree entry. It is the SAME id the body's
  // exact links were just rewritten to point at — minting a different one at the
  // write path would leave every internal link of the copy dangling.
  id: opts.id,
  // What the plan proved stood at this destination. The engine re-proves it on
  // disk under the publishing swap: between planning and writing, a note can
  // appear, and an unguarded overwrite would take its identity.
  expectedDestinationId: opts.expectedDestinationId,
  title: n.title,
  content: n.body,
  directory,
  noteType: n.noteType,
  tags: n.tags,
  // The source file's own frontmatter, carried verbatim (#280) — merged under our
  // typed fields by the write path. canon: docs/import.md#drag-and-drop-of-text-files-223
  frontmatter: n.frontmatter,
  fileName: n.fileName,
  legacyImportRoot: root,
  // Only `created:` is threaded; `modified` is left to file mtime so it never goes
  // stale or fights the journal.
  // canon: docs/import.md#dates-as-data
  createdAt: n.createdAt,
  principal,
  targetClass: opts.targetClass,
  ifExists: opts.ifExists,
})

export type RunImportArgs = {
  /** Write port + optional bulk-mode bracket (beginBulk/endBulk). A Markdown
   *  tree additionally needs `list` and `checkpoint`: it must know what already
   *  stands at each destination BEFORE it mints an identity for it.
   *  canon: docs/import.md#cooperative-responsiveness-on-large-imports-192 */
  store: Pick<KnowledgeStore, 'write'> &
    Partial<IdentityPlanStore> & {
      beginBulk?: () => void
      endBulk?: () => void | Promise<void>
    }
  uploadPath: string
  /** Temp dir for extracted ZIP members; owned and cleaned by the caller. */
  tempDir: string
  /** Original filename — a hint only; format is detected from content. */
  filename: string
  principal: string
  format?: ImportFormat
  /** Root folder the default structure nests under; empty = the space root.
   *  Untrusted — normalised and traversal-rejected. */
  root?: string
  skipExisting?: boolean
  memoryMode?: MemoryMode
  /** The staged upload's ref — the key a Markdown-tree plan is bound to. The
   *  synchronous path has no durable staging and passes a request-scoped value. */
  uploadRef?: string
  /** Durable plan seam: present for a durable job, absent for the synchronous
   *  path. It is what makes a retry replay the SAME plan instead of deciding
   *  again. canon: docs/import.md#importing-a-markdown-tree-302 */
  planStore?: ImportPlanStore
  /** Durable destination arbitration. Absent on the synchronous path. */
  reservation?: ImportReservationPort
  /** The dropped file's own mtime (from the browser's `File.lastModified`) — the
   *  creation date a `markdown` note falls back to when its frontmatter names none,
   *  so a dragged-in archive keeps its chronology instead of piling onto today.
   *  canon: docs/import.md#dates-as-data */
  sourceModifiedAt?: string
  /** Internal provenance for the browser-folder bridge. */
  sourceKind?: ImportSourceKind
  /** Progress, fired every `progressEvery` items and on every phase change.
   *  `done` counts PROCESSED work (a skip and a failure advance it too);
   *  `imported` remains the successful-write counter the NDJSON wire carries. */
  onProgress?: (progress: ImportProgress) => void | Promise<void>
  /** Drain the read-model's write-behind (journal) queue every `progressEvery`
   *  notes so a bulk import doesn't accumulate un-flushed revisions. */
  settle?: () => void | Promise<void>
  progressEvery?: number
  /** Cooperative cancel: checked before each note write. A throw unwinds the bulk
   *  bracket (endBulk still drains the deferred work) and maps to JobAbortedError.
   *  canon: docs/import.md#durable-import-via-the-jobs-layer-191 */
  signal?: AbortSignal
}

/** Run a streaming import. Throws ImportError (from classification or the
 *  foreign stream) when nothing recognisable was uploaded. */
export const runImport = async (args: RunImportArgs): Promise<ImportSummary> => {
  const {
    uploadPath,
    tempDir,
    format,
    root = '',
    uploadRef = uploadPath,
    planStore,
    reservation,
    onProgress,
    signal,
  } = args
  const collector = createSummaryCollector()

  // An explicit foreign format is the caller's answer to the question
  // classification asks, so classification is not asked: the archive's own members
  // get no vote. Letting them vote meant a forced `memory-json` whose first record
  // the probe did not recognise came back as "no recognised export", and the same
  // archive with any stray `.md` came back as a markdown tree the caller never
  // requested. `markdown` is the one explicit format the tree path implements.
  const forcedForeign = format != null && format !== IMPORT_FORMAT.markdown

  // Classification runs BEFORE the bulk bracket, and before any write: it is the
  // one place the archive's kind is decided, and it must be able to fail with
  // nothing written. (The read-model also refuses a checkpoint inside a bulk
  // mutation, which the tree planner needs — one more reason the order is fixed.)
  if (!forcedForeign && (await isZipFile(uploadPath))) {
    // A published plan is adopted, never re-derived: re-deriving is how a retry
    // would quietly decide something different from the run it is resuming.
    const adopted = asSettledPlan(await planStore?.load())

    if (adopted && adopted.uploadRef === uploadRef) {
      await claimDestinations(reservation, adopted, adopted.root)

      return await runMarkdownTreeImport(args, adopted, collector)
    }
    const classification = await classifyImportArchive({
      uploadPath,
      tempDir,
      uploadRef,
      format,
      sourceKind: args.sourceKind,
      root,
      signal,
      // `done` stays 0 while planning: the writing phase counts from zero, and a
      // rising scan counter would make the reported progress go BACKWARDS at the
      // phase change. What the call is FOR is the cancel reaction window: the
      // durable report it drives fails once the row stops being ours, which is how
      // a cancel lands inside a long preflight instead of after it. (The lease is
      // not its business — the runner refreshes that on its own timer.)
      onScanProgress: () =>
        onProgress?.({ phase: IMPORT_PHASE.planning, done: 0, total: null, imported: 0 }),
    })

    if (classification.kind === 'markdown-tree') {
      // Rebuilding a missing plan is safe only while the write gate is provably
      // still closed — so the gate is an ALLOWLIST of phases that prove it, not a
      // denylist of `writing`. `done` is persisted by the handler BEFORE the runner
      // records the job as succeeded, so a crash in that window reopens the row at
      // `phase='done'`: under a denylist that phase read as "never wrote" and let a
      // fully written import plan itself again. An unknown phase (a newer build's)
      // is no better evidence and is refused the same way.
      //
      // It is asked AFTER the verdict, and that placement is the gate's precondition
      // rather than a detail: only a Markdown tree ever publishes a plan, so "the
      // plan is missing" is a statement about a tree and about nothing else. Asked of
      // every auto-detected ZIP, it failed the ordinary Claude/ChatGPT archive — which
      // the web never forces a format for — the moment its job was re-claimed past
      // `planning`, and turned a finished foreign import into `failed` on reclaim.
      if (planStore && !PHASES_BEFORE_WRITING.has(planStore.persistedPhase)) {
        throw new ImportPlanConflictError(
          'the import plan is missing or unreadable after writing began',
        )
      }
      if (!args.store.list) {
        throw new Error('import cannot plan a markdown tree without a store that can list notes')
      }
      // Identities settle BEFORE the plan is published, and the plan is published
      // BEFORE the first write. That order is what makes a retry safe: the
      // sidecar a later claim adopts already names the identity every entry
      // writes under, so the links the first run wrote still point at the notes
      // the second run creates. Settling after publication would mint fresh ids
      // on retry and strand every link the first run had already written.
      const settled = await settleTreeIdentities(
        args.store as IdentityPlanStore,
        classification.plan,
      )
      assertSettledPlanFits(settled)
      // Absent planStore and failed publication are NOT the same answer, and
      // folding them into one `??` made the second silently behave like the
      // first: a durable run would have gone on writing from a plan no retry
      // could ever read back. The synchronous path has no sidecar by design; a
      // durable one that could not publish has lost its recovery story and stops
      // before the first write. It is not deterministic (the next attempt may
      // publish fine), so it stays retryable rather than terminal.
      // A durable plan publication can replace a refused old-build sidecar. Hold
      // the CURRENT job fence over that compare/replace: rename is atomic, but by
      // itself it cannot stop a reaped worker from replacing the newer worker's
      // canonical plan after it lost the queue lease. The reservation description
      // may carry this candidate's ids; paths are the exclusion it sells, and ids
      // remain informational by contract if a peer plan wins publication.
      const importRoot = settled.root

      await claimDestinations(reservation, settled, importRoot)
      const published = planStore
        ? reservation
          ? await reservation.fenced(plannedDestination(importRoot, settled.entries[0]), () =>
              planStore.publish(settled),
            )
          : await planStore.publish(settled)
        : settled

      if (!published) {
        throw new Error('the import plan was not published durably — refusing to write without it')
      }
      const canonical = asSettledPlan(published)

      if (!canonical || canonical.uploadRef !== uploadRef) {
        throw new ImportPlanConflictError('the published import plan is unreadable or incompatible')
      }

      return await runMarkdownTreeImport(args, canonical, collector)
    }
  }

  return await runForeignImport(args, collector)
}

/** A note's own non-fatal diagnostics — today only an unreadable identity claim,
 *  which imports as an ordinary fresh note but must not do so silently. */
const warningsOf = (note: ImportNote): string[] =>
  note.sourceIdentityWarning ? [note.sourceIdentityWarning] : []

/** Point the copy's internal exact links at the copies — or keep the author's
 *  bytes and SAY SO.
 *
 *  The rewriter refuses rather than guessing: it re-reads its own output and
 *  raises when it cannot prove the result holds exactly the links the source held,
 *  remapped. That refusal is about one note, not about the import, so the note
 *  still lands — but a copy whose links still point back at the corpus it came
 *  from is a real, user-visible outcome, and it left in `imported` looking exactly
 *  like a note whose links had been moved. The warning is the whole difference.
 *  canon: docs/import.md#what-an-import-reports-302 */
const repointed = (
  body: string,
  identityMap: ReadonlyMap<string, string>,
): { body: string; warnings: string[] } => {
  try {
    return { body: rewriteWikilinkIdentities(body, identityMap), warnings: [] }
  } catch (err) {
    if (!(err instanceof WikilinkRewriteError)) {
      throw err
    }

    return {
      body,
      warnings: [`internal links were left pointing at the source: ${err.message}`],
    }
  }
}

/** Bracket the whole write pass in bulk-write mode; the finally guarantees we
 *  leave it (and drain deferred work) even if the stream throws mid-way. */
const inBulk = async <T>(store: RunImportArgs['store'], run: () => Promise<T>): Promise<T> => {
  store.beginBulk?.()
  try {
    return await run()
  } finally {
    // A throw from endBulk here would mask the original parse/stream failure (JS
    // finally semantics), so swallow and log; the import's own error propagates.
    try {
      await store.endBulk?.()
    } catch (err) {
      console.error('[import] endBulk failed:', (err as Error).message)
    }
  }
}

/** Execute a frozen Markdown-tree plan. Every decision was made by the planner;
 *  this pass reads one member at a time and writes it where the plan says. */
/** Where a planned entry actually lands. The plan stores destinations RELATIVE to
 *  the root (the root is kept once, so a long root does not multiply across 10 000
 *  entries) — but a claim is about the real address in the space, and two imports
 *  into different roots share every relative path. Joining is therefore not a
 *  formality: it is what makes the claim mean the destination. */
const plannedDestination = (root: string, entry: SettledPlanEntry): string =>
  underRoot(root, entry.destinationPath)

/** Take the batch of destinations this plan will write, before it writes any. A
 *  refusal is deterministic — another live import owns one of these paths, or this
 *  job no longer owns itself — so it is an ImportError, not a retryable fault. */
const claimDestinations = async (
  reservation: ImportReservationPort | undefined,
  plan: SettledMarkdownTreePlanV1,
  root: string,
): Promise<void> => {
  if (!reservation) {
    return
  }
  await reservation.claim(
    plan.entries.map((entry) => ({
      entryKey: entry.archivePath,
      destinationPath: plannedDestination(root, entry),
      targetId: entry.targetId,
      expectedId: entry.expectedDestinationId,
      ownership: entry.ownership,
    })),
  )
}

const runMarkdownTreeImport = async (
  args: RunImportArgs,
  plan: SettledMarkdownTreePlanV1,
  collector: SummaryCollector,
): Promise<ImportSummary> => {
  const {
    store,
    uploadPath,
    principal,
    skipExisting = false,
    reservation,
    onProgress,
    settle,
    progressEvery = IMPORT_PROGRESS_EVERY,
    signal,
  } = args
  // A retry executes the location frozen in the durable plan. Re-reading the job
  // parameter here gave reservations and writes two independent root spellings.
  const importRoot = plan.root

  // The map is read off the plan, not rebuilt: the plan is what a retry adopts.
  const identityMap = identityMapOf(plan)

  collector.ignored(plan.ignored)
  let processed = 0
  const report = () =>
    onProgress?.({
      phase: IMPORT_PHASE.writing,
      done: processed,
      total: plan.entriesTotal,
      imported: collector.importedCount,
    })

  // The determinate bar starts the moment the plan exists, before the first
  // write: the total is now known, and a user watching a 10 000-file import
  // should see that immediately rather than after the first batch.
  await report()

  const run = async (): Promise<ImportSummary> => {
    await runMarkdownTreePlan({
      uploadPath,
      plan,
      signal,
      onEntry: async (note, entry) => {
        // Cancel check BEFORE the write's try/catch, so an abort propagates (stops
        // the stream) instead of being counted as a per-note failure.
        if (signal?.aborted) {
          throw new Error('import canceled')
        }
        const repoint = repointed(note.body, identityMap)

        collector.file(entry.archivePath, 'markdown', [...warningsOf(note), ...repoint.warnings])
        // Counted as well as warned. `files` is a bounded SAMPLE, so on an archive
        // past the detail cap the warning above is dropped on the floor — and a
        // refusal on member 5 000 of 10 000 then reached the user as a green
        // "Imported 10 000 notes." with nothing anywhere admitting the copies still
        // point at the corpus they were copied from.
        if (repoint.warnings.length > 0) {
          collector.repointFailed()
        }
        // The plan's destination is root-relative (the root is stored once); the
        // write path takes the joined directory, and the same `underRoot` rule
        // the planner proved safe applies here.
        const directory = underRoot(importRoot, directoryOf(entry.destinationPath))
        const input = toWriteInput(
          { ...note, body: repoint.body },
          directory,
          importRoot,
          principal,
          {
            ifExists: skipExisting ? IF_EXISTS.fail : IF_EXISTS.overwrite,
            id: entry.targetId,
            expectedDestinationId: entry.expectedDestinationId,
          },
        )

        try {
          // The physical CAS happens INSIDE the exclusion, never beside it: the
          // fence proves the job still owns this destination, and it is still held
          // when the bytes land. Without a reservation (the synchronous path) this
          // is a plain call.
          const w = reservation
            ? await reservation.fenced(plannedDestination(importRoot, entry), () =>
                store.write(input),
              )
            : await store.write(input)

          collector.imported(entry.archivePath, w.id)
        } catch (err) {
          const reason = (err as { reason?: string }).reason

          // "Occupied" reaches this catch only after the guard upstream has already
          // decided WHOSE note stands there: a stranger on a path the plan proved
          // free is refused as a destination-owner conflict and never gets this far.
          // So an occupied destination here is the plan's own note -- the first
          // attempt's, on a retry -- and skipping it is exactly what `skipExisting`
          // asked for. Re-deciding that question here, from a plan field, is what
          // broke durable retry: the error carries no occupant id, so the caller
          // cannot tell a stranger from its own replay, and the layer that can
          // already did.
          if (skipExisting && reason === STORE_ERROR_REASON.noteAlreadyExists) {
            collector.skipped(entry.archivePath)
          } else if (
            err instanceof ImportFenceError ||
            reason === STORE_ERROR_REASON.destinationOwnerConflict
          ) {
            // Neither is THIS note's failure. The fence refusing and the destination
            // having changed owner both say the plan this run is executing no longer
            // holds, so the run stops. Recorded per note they produced the two worst
            // outcomes available: an import that refused every single write still
            // ended `succeeded`, and a cancel mid-archive spent the rest of the tree
            // writing the same sentence into `errors`, one refused destination at a
            // time.
            throw new ImportPlanConflictError(`${entry.archivePath}: ${(err as Error).message}`)
          } else {
            // A single note's write failure is recorded, not fatal — the rest import.
            collector.failed(note.title, (err as Error).message)
          }
        }
        // Every planned member advances the bar, whether it landed, was skipped or
        // failed: the bar tracks WORK, and calling processed "imported" would let a
        // failing import look like a succeeding one.
        if (++processed % progressEvery === 0) {
          await settle?.()
          await report()
        }
        // Cooperative yield after each write so an interactive request that arrived
        // mid-import is serviced now, not queued behind the stream.
        await new Promise((resolve) => setImmediate(resolve))
      },
    })
    await report()

    return collector.snapshot()
  }

  try {
    return await inBulk(store, run)
  } catch (err) {
    // A plan conflict is terminal, and the notes already written are real: carry
    // the bounded partial so the failure reports work instead of erasing it.
    if (err instanceof ImportPlanConflictError && !err.partial) {
      throw new ImportPlanConflictError(err.message, collector.snapshot())
    }
    throw err
  }
}

/** The foreign (Claude/ChatGPT/MCP-memory) path, unchanged in behaviour: parse
 *  and write in one streaming pass, tolerating one bad member. */
const runForeignImport = async (
  args: RunImportArgs,
  collector: SummaryCollector,
): Promise<ImportSummary> => {
  const {
    store,
    uploadPath,
    tempDir,
    filename,
    principal,
    format,
    root = '',
    skipExisting = false,
    memoryMode = 'folder',
    sourceModifiedAt,
    onProgress,
    settle,
    progressEvery = IMPORT_PROGRESS_EVERY,
    signal,
  } = args

  return await inBulk(store, async () => {
    // Re-import may intentionally overwrite a path from an EARLIER run, but two
    // distinct records in this run must never overwrite each other silently. Keep
    // the set across every streamed ZIP member; format-local checks cannot see a
    // collision produced by two separate files.
    const writtenDestinations = new Set<string>()

    await streamImportFile({
      uploadPath,
      tempDir,
      filename,
      format,
      signal,
      sourceModifiedAt,
      // Registered the moment its member finishes, so `files` keeps ARCHIVE order.
      // Doing it after the stream put every member that produced no note behind
      // every member that did — a reordering of the wire result nobody asked for.
      onFile: (meta) => collector.file(meta.file, meta.format, meta.warnings),
      onNote: async (note, ctx) => {
        // Cancel check BEFORE the write's try/catch, so an abort propagates (stops the
        // stream) instead of being counted as a per-note failure.
        if (signal?.aborted) {
          throw new Error('import canceled')
        }
        const isMemory = note.source === IMPORT_SOURCE.memory

        if (isMemory && memoryMode === 'skip') {
          return
        } // dropped, not counted
        // Memory → space agent-mount: root namespaces user-doc notes only, so drop the
        // `memory/` prefix and force class to agent-memory.
        const toSpaceMemory = isMemory && memoryMode === 'space'
        const dirRaw = toSpaceMemory
          ? note.directory.replace(/^memory\//, '')
          : underRoot(root, note.directory)
        // The root may be an existing legacy POSIX-only folder. The store owns
        // the stateful check: every component it would create must be portable.
        const dir = safeRelAddress(dirRaw)

        if (dir === null) {
          collector.failed(note.title, `unsafe directory: ${dirRaw}`)
          return
        }
        // The ONE place a create is allowed to clobber, and it is stated out loud:
        // idempotency rests on the deterministic fileName, so a re-import must land on
        // the SAME file. `skipExisting` is the user's opt-out.
        // canon: docs/import.md#idempotency-dedup-on-re-import
        const importRoot = toSpaceMemory ? '' : (safeRelAddress(root) ?? root)
        const input = toWriteInput(note, dir, importRoot, principal, {
          targetClass: toSpaceMemory ? NOTE_CLASS.agentMemory : undefined,
          ifExists: skipExisting ? IF_EXISTS.fail : IF_EXISTS.overwrite,
        })
        const destinationKey = `${toSpaceMemory ? NOTE_CLASS.agentMemory : NOTE_CLASS.userDoc}:${noteFilePath(note.title, dir, note.fileName, undefined, true)}`

        if (writtenDestinations.has(destinationKey)) {
          collector.failed(
            note.title,
            `import destination collision: ${destinationKey.slice(destinationKey.indexOf(':') + 1)}`,
          )
          return
        }
        // Reserve before the await. A store failure after physical publication is
        // an uncertain outcome; allowing a later colliding record through would
        // turn that uncertainty into a guaranteed overwrite.
        writtenDestinations.add(destinationKey)

        try {
          const w = await store.write(input)

          collector.imported(ctx.file, w.id)
          if (collector.importedCount % progressEvery === 0) {
            await settle?.()
            await onProgress?.({
              phase: IMPORT_PHASE.writing,
              done: collector.importedCount,
              total: null,
              imported: collector.importedCount,
            })
          }
        } catch (err) {
          if (
            skipExisting &&
            (err as { reason?: string }).reason === STORE_ERROR_REASON.noteAlreadyExists
          ) {
            collector.skipped(ctx.file)
            return
          }
          // A single note's write failure is recorded, not fatal — the rest import.
          collector.failed(note.title, (err as Error).message)
        }
        // Cooperative yield after each write so an interactive request that arrived
        // mid-import is serviced now, not queued behind the stream.
        await new Promise((resolve) => setImmediate(resolve))
      },
    })

    return collector.snapshot()
  })
}
