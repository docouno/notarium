import { ZipArchive } from 'archiver'
import type { FastifyInstance } from 'fastify'

import { ExportEnqueueRequestSchema, JobSchema } from '@notarium/contract'
import { HTTP_STATUS } from '@notarium/contract/http'
import { freshNoteId, READ_SCOPE, type ReadScope, stripFrontmatter } from '@notarium/core'

import { safeRelPath } from '../../../../libs/relPath'
import { JOB_KIND_EXPORT, jobToWire } from '../../consumers'
import { type ApiRouteCtx, authz, notFound, s } from '../_shared'

export const exportRoutes = async (app: FastifyInstance, ctx: ApiRouteCtx) => {
  const { spaceStoreFor, jobs, artifacts, wakeJobs, principalId, spaces } = ctx

  // Synchronous ZIP stream of note files — the fallback when jobs are unavailable.
  // canon: docs/export.md#synchronous-streaming-path-17-fallback
  app.get(
    s('/export'),
    { config: { ...authz('space:read', 'space'), longLived: true } },
    async (req, reply) => {
      const store = await spaceStoreFor(req)

      if (!store.exportNotes) {
        return notFound(reply, 'export_unavailable')
      }
      const query = req.query as { frontmatter?: string; scope?: string; folder?: string }
      const scope: ReadScope = query.scope === READ_SCOPE.all ? READ_SCOPE.all : READ_SCOPE.user
      const stripFm = query.frontmatter === 'strip'
      let folder = ''

      if (query.folder) {
        const safe = safeRelPath(query.folder)

        if (safe === null) {
          return reply.code(HTTP_STATUS.BAD_REQUEST).send({ error: 'bad folder path' })
        }
        folder = safe
      }
      const slug = spaces.slugOf(req.spaceId) ?? req.spaceId
      const filename = `${slug}-notes-${new Date().toISOString().slice(0, 10)}.zip`

      const archive = new ZipArchive({ zlib: { level: 6 } })
      archive.on('error', (err: Error) => {
        console.error('[api] /export archive ->', err.message)
        reply.raw.destroy(err)
      })

      // Hijacked stream: not JSON, so the response bypasses contract validation.
      reply.hijack()
      reply.raw.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no',
      })
      archive.pipe(reply.raw)

      // Client-gone: destroy the archive so the engine walk (async generator) stops
      // being pulled — a cancelled download must not keep reading the whole base.
      let aborted = false
      reply.raw.on('close', () => {
        if (!reply.raw.writableEnded) {
          aborted = true
          archive.destroy()
        }
      })

      try {
        const prefix = folder ? `${folder}/` : ''

        for await (const entry of store.exportNotes({ scope })) {
          if (aborted) {
            break
          }
          if (folder && !entry.path.startsWith(prefix)) {
            continue
          }
          const body = stripFm ? stripFrontmatter(entry.content).replace(/^\n+/, '') : entry.content
          archive.append(body, { name: entry.path })
          // Backpressure: wait for the socket to drain before reading the next file,
          // so a slow download doesn't buffer the whole base in archiver's queue.
          if (reply.raw.writableNeedDrain) {
            await new Promise<void>((res) => reply.raw.once('drain', res))
          }
        }
        if (!aborted) {
          await archive.finalize()
        }
      } catch (err) {
        console.error('[api] /export ->', (err as Error).message)
        archive.destroy(err as Error)
        if (!reply.raw.writableEnded) {
          reply.raw.end()
        }
      }
    },
  )

  // Async export via the durable job layer — the primary path; the synchronous GET
  // above is the capability fallback when jobs are unavailable.
  // canon: docs/export.md#async-export-via-the-jobs-layer-105

  app.post(s('/export'), { config: authz('space:read', 'space') }, async (req, reply) => {
    if (!jobs || !artifacts) {
      return notFound(reply, 'jobs_unavailable')
    }
    const store = await spaceStoreFor(req)

    if (!store.exportNotes) {
      return notFound(reply, 'export_unavailable')
    }
    const body = ExportEnqueueRequestSchema.safeParse(req.body ?? {})

    if (!body.success) {
      return reply.code(HTTP_STATUS.BAD_REQUEST).send({ error: 'bad export params' })
    }
    let folder: string | undefined

    if (body.data.folder) {
      const safe = safeRelPath(body.data.folder)

      if (safe === null) {
        return reply.code(HTTP_STATUS.BAD_REQUEST).send({ error: 'bad folder path' })
      }
      folder = safe
    }
    // Best-effort total for progress % — approximate (scope/folder narrow it); the
    // handler reports the real count at the end, so null is fine.
    let total: number | null = null

    try {
      total = (await store.list()).length
    } catch {
      total = null
    }
    const job = await jobs.enqueue({
      id: freshNoteId(),
      space: req.spaceId,
      kind: JOB_KIND_EXPORT,
      principal: principalId(req),
      params: { scope: body.data.scope, frontmatter: body.data.frontmatter, folder },
      progressTotal: total,
      createdAt: new Date().toISOString(),
    })
    wakeJobs?.()
    return reply.code(HTTP_STATUS.ACCEPTED).send(JobSchema.parse(jobToWire(job)))
  })
}
