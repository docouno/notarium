import type { FastifyInstance, FastifyRequest } from 'fastify'
import { rm } from 'node:fs/promises'

import {
  ImportResponseSchema,
  ImportSummarySchema,
  JobListResponseSchema,
  JobSchema,
} from '@notarium/contract'
import { HTTP_STATUS } from '@notarium/contract/http'
import { freshNoteId, IMPORT_FORMAT, ImportError, type ImportFormat } from '@notarium/core'

import { safeRelAddress } from '../../../../libs/relPath'
import {
  ImportPlanConflictError,
  makeImportTempDir,
  runImport,
  saveUploadToTemp,
} from '../../../../services/import'
import { JOB_KIND_EXPORT, JOB_KIND_IMPORT, jobToWire } from '../../consumers'
import { type ApiRouteCtx, authz, notFound, parseRangeHeader, s } from '../_shared'

const IMPORT_FORMATS = new Set<string>([
  IMPORT_FORMAT.claudeConversations,
  IMPORT_FORMAT.claudeProjects,
  IMPORT_FORMAT.claudeMemory,
  IMPORT_FORMAT.claudeDesignChat,
  IMPORT_FORMAT.chatgpt,
  IMPORT_FORMAT.memoryJson,
  IMPORT_FORMAT.markdown,
])
const asImportFormat = (v: unknown): ImportFormat | undefined =>
  typeof v === 'string' && IMPORT_FORMATS.has(v) ? (v as ImportFormat) : undefined

/** The dropped file's mtime, as the browser reports it (`File.lastModified`, epoch
 *  ms) → ISO. Untrusted, so it is fenced on both sides: 0 (the browser's "unknown")
 *  and anything in the FUTURE are dropped — a note created tomorrow is not a
 *  chronology, it is a broken clock, and it would sit at the top of the Feed
 *  forever. A small skew is allowed for a client clock running slightly ahead.
 *  canon: docs/import.md#dates-as-data */
const CLOCK_SKEW_MS = 5 * 60 * 1000

const sourceModifiedIso = (raw: string | undefined): string | undefined => {
  const ms = Number(raw)

  if (!raw || !Number.isFinite(ms) || ms <= 0 || ms > Date.now() + CLOCK_SKEW_MS) {
    return undefined
  }

  return new Date(ms).toISOString()
}

export const jobsRoutes = async (app: FastifyInstance, ctx: ApiRouteCtx) => {
  const { jobs, artifacts, staging, wakeJobs, spaceStoreFor, principalId } = ctx

  /** null → the route 404s: never distinguish "not yours" from "not found" (anti-enumeration). */
  const jobForReq = async (req: FastifyRequest, id: string) => {
    if (!jobs) {
      return null
    }
    const job = await jobs.get(id)

    if (!job || job.space !== req.spaceId) {
      return null
    }
    if (job.principal !== principalId(req) && !req.principal.admin) {
      return null
    }

    return job
  }

  app.get(s('/jobs'), { config: authz('space:read', 'space') }, async (req, reply) => {
    // No meta-DB ⇒ no async capability: 404 (a consistent signal), not a misleading 200 empty list.
    if (!jobs) {
      return notFound(reply, 'jobs_unavailable')
    }
    const kindRaw = (req.query as { kind?: string }).kind
    const kind = kindRaw === JOB_KIND_IMPORT ? JOB_KIND_IMPORT : JOB_KIND_EXPORT
    const list = await jobs.list(req.spaceId, {
      principal: req.principal.admin ? undefined : principalId(req),
      kind,
      limit: 20,
    })
    return JobListResponseSchema.parse({ jobs: list.map(jobToWire) })
  })

  app.get(s('/jobs/:id'), { config: authz('space:read', 'space') }, async (req, reply) => {
    const job = await jobForReq(req, (req.params as { id: string }).id)

    if (!job) {
      return notFound(reply)
    }

    return reply.send(JobSchema.parse(jobToWire(job)))
  })

  app.post(s('/jobs/:id/cancel'), { config: authz('space:read', 'space') }, async (req, reply) => {
    if (!jobs) {
      return notFound(reply, 'jobs_unavailable')
    }
    const job = await jobForReq(req, (req.params as { id: string }).id)

    if (!job) {
      return notFound(reply)
    }
    await jobs.cancel(job.id, new Date().toISOString())
    const updated = (await jobs.get(job.id)) ?? job
    return reply.send(JobSchema.parse(jobToWire(updated)))
  })

  app.get(s('/jobs/:id/download'), { config: authz('space:read', 'space') }, async (req, reply) => {
    if (!jobs || !artifacts) {
      return notFound(reply, 'jobs_unavailable')
    }
    const job = await jobForReq(req, (req.params as { id: string }).id)

    if (!job || job.status !== 'succeeded' || !job.artifactRef) {
      return notFound(reply)
    }
    const artifactRef = job.artifactRef
    const stat = await artifacts.stat(artifactRef)

    if (!stat) {
      return notFound(reply, 'artifact_gone')
    }
    const size = stat.size
    const filename = job.artifactName ?? 'export.zip'
    // ETag = id+size: If-Range guards a resumed range download against a changed artifact.
    const etag = `"${job.id}-${size}"`
    reply.header('Content-Type', 'application/zip')
    reply.header('Content-Disposition', `attachment; filename="${filename}"`)
    reply.header('Accept-Ranges', 'bytes')
    reply.header('Cache-Control', 'no-store')
    reply.header('ETag', etag)
    const range = parseRangeHeader(
      req.headers.range,
      size,
      req.headers['if-range'] as string | undefined,
      etag,
    )

    if (range === 'invalid') {
      return reply
        .code(HTTP_STATUS.RANGE_NOT_SATISFIABLE)
        .header('Content-Range', `bytes */${size}`)
        .send()
    }
    // Artifact can be GC-swept between the stat and opening the stream; headers are already
    // committed, so tear the response down on error (a retry gets a clean 404).
    const openArtifact = (r?: { start: number; end: number }) => {
      const stream = artifacts.createReadStream(artifactRef, r)
      stream.on('error', (err) => {
        console.error('[jobs] artifact stream error', err)
        reply.raw.destroy()
      })
      return stream
    }

    if (range) {
      reply.code(HTTP_STATUS.PARTIAL_CONTENT)
      reply.header('Content-Range', `bytes ${range.start}-${range.end}/${size}`)
      reply.header('Content-Length', String(range.end - range.start + 1))
      return reply.send(openArtifact(range))
    }
    reply.header('Content-Length', String(size))
    return reply.send(openArtifact())
  })

  // POST /import: one endpoint, two response modes chosen by capability — a durable job (202)
  // or a synchronous NDJSON fallback.
  // canon: docs/import.md#durable-import-via-the-jobs-layer-191 · docs/import.md#wire-and-ui-synchronous-fallback
  app.post(
    s('/import'),
    { config: { ...authz('space:write', 'space'), longLived: true } },
    async (req, reply) => {
      if (!req.isMultipart()) {
        return reply
          .code(HTTP_STATUS.BAD_REQUEST)
          .send({ error: 'expected a multipart file upload' })
      }
      const store = await spaceStoreFor(req)
      const file = await req.file()

      if (!file) {
        return reply.code(HTTP_STATUS.BAD_REQUEST).send({ error: 'no file in the upload' })
      }
      const fields = file.fields as Record<string, { value?: unknown } | undefined>
      const fieldStr = (k: string) =>
        typeof fields[k]?.value === 'string' ? (fields[k]!.value as string) : undefined
      const format = asImportFormat(fields.format?.value)
      const rootRaw = fieldStr('root')
      // `root` may name an existing legacy POSIX-only folder. The engine applies
      // the stricter portable-component rule if the import would create it.
      const root = rootRaw ? safeRelAddress(rootRaw) : ''

      if (root === null) {
        return reply.code(HTTP_STATUS.BAD_REQUEST).send({ error: 'bad import root' })
      }
      const skipExisting = fieldStr('skipExisting') === 'true'
      const memoryRaw = fieldStr('memory')
      const memoryMode = memoryRaw === 'space' || memoryRaw === 'skip' ? memoryRaw : 'folder'
      const sourceModifiedAt = sourceModifiedIso(fieldStr('lastModified'))

      if (jobs && staging) {
        const jobId = freshNoteId()
        let uploadRef: string

        try {
          uploadRef = await staging.stage(req.spaceId, jobId, file.file)
        } catch (err) {
          if ((err as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') {
            return reply.code(HTTP_STATUS.PAYLOAD_TOO_LARGE).send({ error: 'upload too large' })
          }
          throw err
        }
        if (file.file.truncated) {
          await staging.remove(uploadRef).catch(() => {})
          return reply.code(HTTP_STATUS.PAYLOAD_TOO_LARGE).send({ error: 'upload too large' })
        }
        // Stage-then-enqueue: the row becomes claimable only AFTER the upload is fully
        // on disk, so the runner never claims a job whose source is half-written (the
        // staging sweep's age grace covers the reverse µs-window before enqueue lands).
        const job = await jobs
          .enqueue({
            id: jobId,
            space: req.spaceId,
            kind: JOB_KIND_IMPORT,
            principal: principalId(req),
            params: {
              uploadRef,
              filename: file.filename,
              format,
              root,
              skipExisting,
              memoryMode,
              sourceModifiedAt,
            },
            // ZIP note count is unknown upfront (a stream) → indeterminate bar; handler reports live count.
            progressTotal: null,
            createdAt: new Date().toISOString(),
          })
          .catch(async (err) => {
            await staging.remove(uploadRef).catch(() => {})
            throw err
          })
        wakeJobs?.()
        return reply.code(HTTP_STATUS.ACCEPTED).send(JobSchema.parse(jobToWire(job)))
      }

      // Private temp dir (mkdtemp, 0700): the unpredictable path defeats the /tmp symlink race,
      // one rm-rf cleans upload + extracted members. We pipe the upload in ourselves because
      // Fastify's saveRequestFiles onResponse cleanup races a hijacked response.
      const tempDir = await makeImportTempDir()
      const cleanup = () => rm(tempDir, { recursive: true, force: true }).catch(() => {})
      let uploadPath: string

      try {
        uploadPath = await saveUploadToTemp(file.file, tempDir)
      } catch (err) {
        await cleanup()
        if ((err as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') {
          return reply.code(HTTP_STATUS.PAYLOAD_TOO_LARGE).send({ error: 'upload too large' })
        }
        throw err
      }
      if (file.file.truncated) {
        await cleanup()
        return reply.code(HTTP_STATUS.PAYLOAD_TOO_LARGE).send({ error: 'upload too large' })
      }

      reply.hijack()
      reply.raw.writeHead(200, {
        'Content-Type': 'application/x-ndjson',
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no',
      })
      const writeLine = (obj: unknown) => reply.raw.write(JSON.stringify(obj) + '\n')

      try {
        const summary = await runImport({
          store,
          uploadPath,
          tempDir,
          filename: file.filename,
          principal: principalId(req),
          format,
          root,
          skipExisting,
          memoryMode,
          sourceModifiedAt,
          // The legacy `imported` field stays exactly where it was; phase/done/total
          // ride alongside it so an old reader keeps working and a new one can draw
          // a determinate bar for a Markdown tree.
          onProgress: ({ phase, done, total, imported }) => {
            writeLine({ type: 'progress', imported, phase, done, total })
          },
          settle: () => store.settle?.(),
        })
        writeLine({ type: 'done', ...ImportResponseSchema.parse({ ok: true, ...summary }) })
      } catch (err) {
        const message = err instanceof ImportError ? err.message : 'import failed'

        if (!(err instanceof ImportError)) {
          console.error('[api] /import ->', (err as Error).message)
        }
        // The work already done rides out on the error line. A terminal conflict
        // after N notes has written N real notes, and a client that is shown only
        // the sentence has no way to learn that. This is the synchronous twin of the
        // durable job's `result`. canon: docs/import.md#what-an-import-reports-302
        //
        // Validated OUTSIDE the line, and with safeParse. `partial` is typed
        // `unknown`, so "it always matches the schema" is a convention, not a fact
        // the compiler holds — and a throw from inside the line literal would land
        // in the `finally`, which ends the response. The client would then be left
        // with a stream carrying neither `done` NOR `error`: exactly the outcome
        // this branch exists to prevent. A partial we cannot vouch for costs the
        // counts; it must never cost the sentence.
        const partial: unknown = err instanceof ImportPlanConflictError ? err.partial : undefined
        const parsed = partial === undefined ? undefined : ImportSummarySchema.safeParse(partial)

        if (parsed && !parsed.success) {
          console.error('[api] /import -> dropped a partial summary that is not one')
        }
        writeLine({
          type: 'error',
          error: message,
          ...(parsed?.success ? { partial: parsed.data } : {}),
        })
      } finally {
        reply.raw.end()
        await cleanup()
      }
    },
  )
}
