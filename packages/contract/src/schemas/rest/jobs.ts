import { z } from 'zod'
import { EXPORT_SCOPE, FRONTMATTER_MODE, JOB_STATUS } from '../../consts/jobs'
import { enumValues } from '../../libs/enumValues'

export const ImportFileResultSchema = z.object({
  /** Archive-relative name of the member parsed (or the upload's filename). */
  file: z.string(),
  /** The detected format: 'claude-conversations' | 'chatgpt' | 'memory-json' |
   *  'claude-projects' | 'claude-memory' | 'claude-design-chat', or 'unsupported'
   *  for a JSON member we recognised as data but can't parse (skipped). */
  format: z.string(),
  imported: z.number().int().nonnegative(),
  /** Skipped because the note already existed and `skipExisting` was on. */
  skipped: z.number().int().nonnegative(),
  /** Non-fatal parse notes (e.g. nameless entities skipped). */
  warnings: z.array(z.string()),
})

/** The import outcome — per-file results plus a roll-up. Shared by two carriers:
 *  the synchronous NDJSON `done` line (as ImportResponse, `ok`-tagged) and a
 *  durable import job's `result`, which surfaces the SAME shape once the
 *  job succeeds. `imported` counts notes written (idempotent re-import overwrites
 *  the same files — the count is stable, not additive). */
export const ImportSummarySchema = z.object({
  imported: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  /** The DETAIL collections are capped server-side (a 10 000-note import must not
   *  answer with 10 000 rows) while the counters above stay exact. No `.max()`
   *  here on purpose: a result persisted by an older build may carry more, and
   *  refusing to parse it would lose a real outcome. Readers bound it themselves. */
  files: z.array(ImportFileResultSchema),
  /** Recognised members not present in `files`. Absent when nothing was dropped. */
  filesOmitted: z.number().int().nonnegative().optional(),
  errors: z.array(z.object({ title: z.string().optional(), error: z.string() })),
  /** Per-note failures not present in `errors`. Absent when nothing was dropped. */
  errorsOmitted: z.number().int().nonnegative().optional(),
  /** Notes that imported with their internal links still pointing at the SOURCE
   *  corpus, because the rewriter refused to guess. A COUNT of notes, exact and
   *  uncapped: the same fact rides `files[].warnings`, but that collection stops
   *  at the detail cap, so on a 10 000-file archive the warning is the first
   *  thing to disappear and this is the only thing left saying it happened.
   *  Absent when every repoint was proven. */
  repointFailed: z.number().int().nonnegative().optional(),
  /** Non-Markdown members a Markdown-tree archive carried: counted exactly,
   *  sampled boundedly, never imported (attachments have no ingestion seam yet).
   *  Absent for every other import format. */
  ignored: z
    .object({
      count: z.number().int().nonnegative(),
      files: z.array(z.string()),
      filesOmitted: z.number().int().nonnegative().optional(),
    })
    .optional(),
  /** Ids of the notes created, in write order — CAPPED (a huge import doesn't send
   *  thousands). The DnD surface opens the first when a single file landed; the
   *  counts above stay authoritative. Absent/empty when nothing was created. Rides
   *  BOTH carriers (the sync `done` line and a durable import job's `result`). */
  created: z.array(z.string()).optional(),
})

export const ImportResponseSchema = ImportSummarySchema.extend({ ok: z.literal(true) })

export const JobStatusSchema = z.enum(enumValues(JOB_STATUS))

export const JobSchema = z.object({
  id: z.string(),
  /** Open kind discriminator — 'export' and 'import' today (purge/… later). */
  kind: z.string(),
  status: JobStatusSchema,
  progress: z.object({
    done: z.number().int().nonnegative(),
    /** Best-effort total for the %; null when unknown upfront (a stream). */
    total: z.number().int().nonnegative().nullable(),
    /** 0..1 when total is known, else null. */
    ratio: z.number().min(0).max(1).nullable(),
    /** Free-form current phase ('archiving' | 'done' | …); null when unset. */
    phase: z.string().nullable(),
  }),
  /** Present only on a succeeded job that produced a downloadable file. */
  artifact: z
    .object({
      name: z.string(),
      bytes: z.number().int().nonnegative().nullable(),
      /** ISO TTL — the download 404s once GC has swept it. */
      expiresAt: z.string().nullable(),
    })
    .nullable(),
  /** A structured, kind-specific data outcome. An import job carries its ImportSummary
   *  here (imported/skipped/failed/files); an export job carries `{count}` (its
   *  downloadable outcome is the artifact, not this). Null before a job completes / for
   *  a kind with no data outcome. The client parses it by `kind` (an import client reads
   *  it as ImportSummarySchema). */
  result: z.unknown().nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().nullable(),
})

export const JobListResponseSchema = z.object({ jobs: z.array(JobSchema) })

/** The `job` named-channel payload — same schema the poll endpoint returns, so the SSE
 *  and poll paths validate identically (parse-guarded on emit). A zod schema, so it lives
 *  here, not in the zod-free ./events consts.
 *  canon: docs/contract.md#wire-consts */
export const SseJobPayloadSchema = JobSchema

/** POST /api/s/:space/export body — the same knobs as the sync export. */
export const ExportEnqueueRequestSchema = z.object({
  scope: z.enum(enumValues(EXPORT_SCOPE)).optional(),
  frontmatter: z.enum(enumValues(FRONTMATTER_MODE)).optional(),
  /** Subtree filter: export only files under this folder. */
  folder: z.string().optional(),
})

export type ImportResponse = z.infer<typeof ImportResponseSchema>

export type ImportSummary = z.infer<typeof ImportSummarySchema>

export type ImportFileResult = z.infer<typeof ImportFileResultSchema>
export type Job = z.infer<typeof JobSchema>

export type JobListResponse = z.infer<typeof JobListResponseSchema>

export type ExportEnqueueRequest = z.infer<typeof ExportEnqueueRequestSchema>
