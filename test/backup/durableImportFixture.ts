// Materialises an unfinished durable import through the seams the server composes, so
// production maintenance judges it exactly as it judges a real one.
// canon: docs/jobs.md#input-staging-191

import { readFile, stat, utimes } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'

import { JOB_KIND_IMPORT } from '../../packages/server/src/apps/server/consumers'
import { dataPathsFromEnv } from '../../packages/server/src/apps/server/dataPaths'
import { parseCommandLine } from '../../packages/server/src/libs/commandLine'
import {
  createFsImportStagingStore,
  FINAL_GRACE_MS,
} from '../../packages/server/src/libs/importStaging'
import { createMetaDb } from '../../packages/server/src/services/metaDb'
import type { JobRecord, MetaDb } from '../../packages/server/src/services/metaDb'

/** Both finals are back-dated clear of the store's own grace, so the next sweep judges
 *  them on their ROW rather than on their age — that judgement is the thing under test,
 *  and inside the grace it would never happen. Derived, never copied: a literal here
 *  would silently stop clearing the window if the store's grace moved. */
const DEFAULT_AGE_MS = 2 * FINAL_GRACE_MS

/** The lifecycle facts a restore must carry across unchanged: identity, queue
 *  position, the production import params, and the fields whose reappearance would mean
 *  a restored row is in a state no live queue put it in — a restored `lockedBy` stalls
 *  the job until the reaper. `updatedAt` is the one omission that can legitimately move
 *  on its own; the rest of `JobRecord` is progress/artifact reporting a never-claimed
 *  row does not carry. */
export type DurableImportProjection = {
  id: string
  space: string
  kind: string
  status: string
  principal: string
  uploadRef: string | null
  filename: string | null
  runAt: string
  createdAt: string
  attempts: number
  maxAttempts: number
  error: string | null
  completedAt: string | null
  startedAt: string | null
  lockedBy: string | null
  phase: string | null
}

export type DurableImportFixtureOptions = {
  dataDir: string
  /** The STABLE space id, never a slug — staging is addressed by id in production. */
  space: string
  jobId: string
  orphanJobId: string
  principal: string
  filename: string
  content: string
  /** ISO not-before, far enough ahead that no runner claims the row mid-drill. */
  runAt: string
  ageMs?: number
}

export type DurableImportInspectOptions = {
  dataDir: string
  jobId: string
  /** Handed back by `create`, never rebuilt here, so the store keeps sole ownership
   *  of how a ref is spelled. */
  orphanRef: string
}

type StagedRef = { ref: string; path: string }

export type DurableImportFixture = {
  mode: 'create'
  upload: StagedRef
  orphan: StagedRef
  agedTo: string
  job: DurableImportProjection
}

export type DurableImportInspection = {
  mode: 'inspect'
  upload: { ref: string | null; path: string | null; present: boolean; bytes: string | null }
  orphan: StagedRef & { present: boolean }
  job: DurableImportProjection | null
}

const projectionOf = (row: JobRecord): DurableImportProjection => {
  const params = (row.params ?? {}) as { uploadRef?: unknown; filename?: unknown }

  return {
    id: row.id,
    space: row.space,
    kind: row.kind,
    status: row.status,
    principal: row.principal,
    uploadRef: typeof params.uploadRef === 'string' ? params.uploadRef : null,
    filename: typeof params.filename === 'string' ? params.filename : null,
    runAt: row.runAt,
    createdAt: row.createdAt,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    error: row.error,
    completedAt: row.completedAt,
    startedAt: row.startedAt,
    lockedBy: row.lockedBy,
    phase: row.phase,
  }
}

const exists = async (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  )

/** Env → the same derived locations the server would use. The ONE place either mode
 *  learns where the meta-DB and the staging tree are; a hand-joined path here would
 *  be a second answer to a question production already answers. */
const openDataRoot = async <T>(
  dataDir: string,
  use: (ctx: {
    metaDb: MetaDb
    staging: ReturnType<typeof createFsImportStagingStore>
  }) => Promise<T>,
): Promise<T> => {
  const paths = dataPathsFromEnv({ ...process.env, DATA_DIR: dataDir })
  const metaDb = createMetaDb(paths.metaDbUrl)

  try {
    return await use({ metaDb, staging: createFsImportStagingStore(paths.importStagingDir) })
  } finally {
    await metaDb.close()
  }
}

/** Stage → enqueue → stage the control orphan → age both. Production's order, and
 *  the ageing is last on purpose: a final is unprotected only between its rename and
 *  its row, and during that window it is still young enough for the store's grace to
 *  cover it. Ageing first would hand a correct sweep a real orphan. */
export const createDurableImportFixture = async (
  options: DurableImportFixtureOptions,
): Promise<DurableImportFixture> =>
  openDataRoot(options.dataDir, async ({ metaDb, staging }) => {
    const uploadRef = await staging.stage(
      options.space,
      options.jobId,
      Readable.from([options.content]),
    )
    const row = await metaDb.jobs.enqueue({
      id: options.jobId,
      space: options.space,
      kind: JOB_KIND_IMPORT,
      principal: options.principal,
      params: { uploadRef, filename: options.filename },
      runAt: options.runAt,
      createdAt: new Date().toISOString(),
    })
    // The control: same shape, same age, no row. Only the row-aware half of the
    // sweep tells the two apart, so its removal is what proves the pass ran at all.
    const orphanRef = await staging.stage(
      options.space,
      options.orphanJobId,
      Readable.from([options.content]),
    )
    const agedTo = new Date(Date.now() - (options.ageMs ?? DEFAULT_AGE_MS))
    const upload = { ref: uploadRef, path: staging.pathOf(uploadRef) }
    const orphan = { ref: orphanRef, path: staging.pathOf(orphanRef) }

    // LIVE first, control second, and the order is the barrier's proof. A sweep can
    // only reclaim the orphan once the orphan itself is aged, and by then the live
    // final is already aged too — so the pass that took the orphan necessarily judged
    // the live final against its row. Age the orphan first and a sweep landing between
    // the two skips the still-fresh live final without ever consulting `isLive`, and
    // the drill reports a causal proof that never happened.
    await utimes(upload.path, agedTo, agedTo)
    await utimes(orphan.path, agedTo, agedTo)

    // Returning at all is the proof that both finals exist at the paths reported: the
    // `utimes` calls above would have thrown ENOENT otherwise. Re-checking with a stat
    // would only reopen the window it looks like it closes — past its ageing the
    // control orphan is already reclaimable, so a maintenance tick landing before the
    // stat would report it missing when it had merely been swept on schedule.
    return { mode: 'create', upload, orphan, agedTo: agedTo.toISOString(), job: projectionOf(row) }
  })

/** Read the same facts back out of a data root. The upload is addressed by the ref
 *  the ROW carries: bytes moved away from the pointer and a pointer rewritten away
 *  from the bytes must both read as failures, and rebuilding the name here would hide
 *  either one. No row therefore means no upload to report. */
export const inspectDurableImportFixture = async (
  options: DurableImportInspectOptions,
): Promise<DurableImportInspection> =>
  openDataRoot(options.dataDir, async ({ metaDb, staging }) => {
    const row = (await metaDb.jobs.get(options.jobId)) ?? null
    const job = row ? projectionOf(row) : null
    const uploadRef = job?.uploadRef ?? null
    const uploadPath = uploadRef === null ? null : staging.pathOf(uploadRef)
    const present = uploadPath !== null && (await exists(uploadPath))
    const orphanPath = staging.pathOf(options.orphanRef)

    return {
      mode: 'inspect',
      upload: {
        ref: uploadRef,
        path: uploadPath,
        present,
        bytes: uploadPath !== null && present ? await readFile(uploadPath, 'utf8') : null,
      },
      orphan: { ref: options.orphanRef, path: orphanPath, present: await exists(orphanPath) },
      job,
    }
  })

const MODE_OPTIONS = {
  create: [
    'data-dir',
    'job-id',
    'space',
    'orphan-job-id',
    'principal',
    'filename',
    'content',
    'run-at',
    'age-ms',
  ],
  inspect: ['data-dir', 'job-id', 'orphan-ref'],
} as const satisfies Record<string, readonly string[]>

const required = (parsed: ReturnType<typeof parseCommandLine>, name: string): string => {
  const value = parsed.value(name)

  if (!value) {
    throw new Error(`--${name} is required`)
  }

  return value
}

/** The CLI contract: one JSON object on success, a throw otherwise. Returning the
 *  line instead of printing it keeps the failure path incapable of emitting a success
 *  document the driver could mistake for one. */
export const main = async (argv: readonly string[]): Promise<string> => {
  const parsed = parseCommandLine(argv, {
    'data-dir': 'value',
    space: 'value',
    'job-id': 'value',
    'orphan-job-id': 'value',
    'orphan-ref': 'value',
    principal: 'value',
    filename: 'value',
    content: 'value',
    'run-at': 'value',
    'age-ms': 'value',
  })
  const mode = parsed.positionals[0]

  if (parsed.positionals.length !== 1 || (mode !== 'create' && mode !== 'inspect')) {
    throw new Error('usage: durableImportFixture.ts <create|inspect> --data-dir=<dir> …')
  }
  // The parser rejects unknown options but knows only the union of both modes, so an
  // option belonging to the other mode would otherwise be accepted and dropped.
  const allowed: readonly string[] = MODE_OPTIONS[mode]
  const stray = parsed.provided.filter((name) => !allowed.includes(name))

  if (stray.length) {
    throw new Error(`--${stray[0]} is not an option of ${mode}`)
  }
  const dataDir = required(parsed, 'data-dir')
  const jobId = required(parsed, 'job-id')

  if (mode === 'inspect') {
    return JSON.stringify(
      await inspectDurableImportFixture({
        dataDir,
        jobId,
        orphanRef: required(parsed, 'orphan-ref'),
      }),
    )
  }
  const ageMs = parsed.value('age-ms')

  // `utimes` accepts an Invalid Date without complaint, so an unchecked value would
  // back-date both finals to garbage and only fail afterwards.
  if (ageMs !== undefined && !/^\d+$/.test(ageMs)) {
    throw new Error(`--age-ms must be a non-negative integer, got '${ageMs}'`)
  }

  return JSON.stringify(
    await createDurableImportFixture({
      dataDir,
      jobId,
      space: required(parsed, 'space'),
      orphanJobId: required(parsed, 'orphan-job-id'),
      principal: required(parsed, 'principal'),
      filename: required(parsed, 'filename'),
      content: required(parsed, 'content'),
      runAt: required(parsed, 'run-at'),
      ...(ageMs === undefined ? {} : { ageMs: Number(ageMs) }),
    }),
  )
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main(process.argv.slice(2)).then(
    (line) => process.stdout.write(`${line}\n`),
    (err: Error) => {
      console.error(`durable import fixture failed: ${err.message}`)
      process.exitCode = 1
    },
  )
}
