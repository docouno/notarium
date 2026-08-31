import type { FastifyInstance, FastifyReply } from 'fastify'
import { randomBytes } from 'node:crypto'

import {
  BoardMoveRequestSchema,
  BoardMoveResponseSchema,
  DraftViewQueryRequestSchema,
  DraftViewQueryResponseSchema,
  ViewManifestQuerySchema,
  ViewManifestResponseSchema,
  ViewWindowRequestSchema,
  ViewWindowResponseSchema,
} from '@notarium/contract'
import { HTTP_STATUS } from '@notarium/contract/http'
import { decodeViewRef } from '@notarium/core'

import { safeRelAddress } from '../../../../libs/relPath'
import { BoardMoveError, BoardMoveService } from '../../../../services/views/boardMove'
import {
  ViewExecutionCancelledError,
  ViewExecutionService,
  ViewSnapshotConflictError,
} from '../../../../services/views/execution'
import { VIEW_READER_REGISTRY, VIEW_SOURCE_REGISTRY } from '../../../../services/views/registry'
import { viewCacheScope } from '../../../../services/views/sourceRegistry'
import { type ApiRouteCtx, authz, notFound, s } from '../_shared'

const requestAbort = (reply: FastifyReply): AbortSignal => {
  const abort = new AbortController()

  reply.raw.on('close', () => {
    if (!reply.raw.writableEnded) {
      abort.abort()
    }
  })
  return abort.signal
}

export const viewsRoutes = async (app: FastifyInstance, ctx: ApiRouteCtx) => {
  const { noteStore, projects, fieldSchemaStore, spaceStoreFor } = ctx
  const readers = ctx.viewReaders ?? VIEW_READER_REGISTRY
  const sources = ctx.viewSources ?? VIEW_SOURCE_REGISTRY
  const views = new ViewExecutionService(readers, sources)
  const mover = new BoardMoveService(() => (randomBytes(1)[0]! & 1) as 0 | 1, readers, sources)
  const projectRows = (space: string) => projects?.listForSpace(space) ?? Promise.resolve([])

  app.get('/api/note/views', { config: authz('note:read', 'note') }, async (req, reply) => {
    const query = ViewManifestQuerySchema.safeParse(req.query)

    if (!query.success) {
      return reply
        .code(HTTP_STATUS.BAD_REQUEST)
        .send({ error: query.error.issues[0]?.message ?? 'bad query' })
    }
    const hit = await noteStore(req.principal, query.data.id, 'note:read')

    if (!hit) {
      return notFound(reply)
    }
    const [projectList, schema] = await Promise.all([
      projectRows(hit.space),
      fieldSchemaStore?.read(hit.space),
    ])
    let saved: Awaited<ReturnType<ViewExecutionService['saved']>>

    try {
      saved = await views.saved({
        store: hit.store,
        noteId: query.data.id,
        projects: projectList,
        schema,
        signal: requestAbort(reply),
        cacheScope: viewCacheScope(hit.space, req.principal.id),
      })
    } catch (error) {
      if (error instanceof ViewExecutionCancelledError) {
        return reply
      }
      throw error
    }
    const primaryType =
      saved.parsed.primaryReader.kind === 'value' ? saved.parsed.primaryReader.value : undefined
    const marker =
      typeof saved.note.frontmatter.view === 'string' && saved.note.frontmatter.view.trim()
        ? saved.note.frontmatter.view.trim()
        : undefined
    return ViewManifestResponseSchema.parse({
      documentId: saved.note.id ?? query.data.id,
      documentVersionToken: saved.note.versionToken,
      snapshotGeneration: saved.snapshotGeneration,
      ...(schema ? { schemaVersionToken: schema.versionToken } : {}),
      ...(marker ? { marker } : {}),
      ...(primaryType ? { primaryType } : {}),
      ...((marker ?? null) !== (primaryType ?? null) ? { markerMismatch: true } : {}),
      views: saved.parsed.views.map((view) => {
        const prepared = view.viewRef ? saved.prepared.get(view.viewRef) : undefined

        return {
          viewRef: view.viewRef,
          block: view.block,
          occurrence: view.occurrence,
          name: view.name,
          type: view.type,
          status: prepared?.status ?? 'invalid',
          total: prepared?.total,
          groups: prepared?.groups,
          totalGroups: prepared?.totalGroups,
          groupsTruncated: prepared?.groupsTruncated,
          diagnostics: prepared?.diagnostics,
          execution: prepared?.execution,
          capabilities: prepared?.capabilities,
          snapshotGeneration: prepared?.snapshotGeneration,
          schemaVersionToken: prepared?.schemaVersionToken,
        }
      }),
      diagnostics: saved.parsed.diagnostics.map((diagnostic) => diagnostic.message),
    })
  })

  app.post('/api/note/view-window', { config: authz('note:read', 'note') }, async (req, reply) => {
    const body = ViewWindowRequestSchema.safeParse(req.body)

    if (!body.success) {
      return reply
        .code(HTTP_STATUS.BAD_REQUEST)
        .send({ error: body.error.issues[0]?.message ?? 'bad request' })
    }
    const decoded = decodeViewRef(body.data.viewRef)

    if (!decoded) {
      return reply.code(HTTP_STATUS.CONFLICT).send({ error: 'stale viewRef' })
    }
    const hit = await noteStore(req.principal, decoded.documentId, 'note:read')

    if (!hit) {
      return notFound(reply)
    }
    const [projectList, schema] = await Promise.all([
      projectRows(hit.space),
      fieldSchemaStore?.read(hit.space),
    ])
    let prepared: Awaited<ReturnType<ViewExecutionService['prepare']>>

    try {
      prepared = (
        await views.savedView({
          store: hit.store,
          viewRef: body.data.viewRef,
          snapshotGeneration: body.data.snapshotGeneration,
          schemaVersionToken: body.data.schemaVersionToken,
          projects: projectList,
          schema,
          signal: requestAbort(reply),
          cacheScope: viewCacheScope(hit.space, req.principal.id),
        })
      ).prepared
    } catch (error) {
      if (error instanceof ViewExecutionCancelledError) {
        return reply
      }
      if (error instanceof ViewSnapshotConflictError) {
        return reply.code(HTTP_STATUS.CONFLICT).send({ error: error.message })
      }
      throw error
    }

    if (prepared.status !== 'ready' && prepared.status !== 'incomplete') {
      return reply.code(HTTP_STATUS.CONFLICT).send({ error: 'view is not executable' })
    }
    let window: ReturnType<ViewExecutionService['window']>

    try {
      window = views.window(prepared, body.data, schema)
    } catch (error) {
      return reply
        .code(HTTP_STATUS.BAD_REQUEST)
        .send({ error: (error as Error).message || 'bad view window' })
    }

    return ViewWindowResponseSchema.parse({
      ...body.data,
      total: window.total,
      rows: window.rows,
      snapshotGeneration: prepared.snapshotGeneration,
      schemaVersionToken: prepared.schemaVersionToken,
      execution: prepared.execution ?? {
        exactReads: 0,
        exactCacheHits: 0,
        exactRemaining: 0,
      },
    })
  })

  app.post('/api/note/board-move', { config: authz('note:write', 'note') }, async (req, reply) => {
    const body = BoardMoveRequestSchema.safeParse(req.body)

    if (!body.success) {
      return reply
        .code(HTTP_STATUS.BAD_REQUEST)
        .send({ error: body.error.issues[0]?.message ?? 'bad request' })
    }
    const decoded = decodeViewRef(body.data.viewRef)

    if (!decoded) {
      return reply.code(HTTP_STATUS.CONFLICT).send({ error: 'stale viewRef' })
    }
    const [viewHit, cardHit] = await Promise.all([
      noteStore(req.principal, decoded.documentId, 'note:write'),
      noteStore(req.principal, body.data.cardId, 'note:write'),
    ])

    if (
      !viewHit ||
      !cardHit ||
      viewHit.space !== cardHit.space ||
      viewHit.store !== cardHit.store
    ) {
      return notFound(reply)
    }
    const [projectList, schema] = await Promise.all([
      projectRows(viewHit.space),
      fieldSchemaStore?.read(viewHit.space),
    ])

    try {
      return BoardMoveResponseSchema.parse(
        await mover.move({
          request: body.data,
          store: viewHit.store,
          space: viewHit.space,
          projects: projectList,
          schema,
          fieldSchemaStore,
          principal: ctx.principalId(req),
        }),
      )
    } catch (error) {
      if (error instanceof BoardMoveError) {
        return reply.code(error.status).send({ error: error.message })
      }
      throw error
    }
  })

  app.post(s('/view-query'), { config: authz('space:read', 'space') }, async (req, reply) => {
    const body = DraftViewQueryRequestSchema.safeParse(req.body)

    if (!body.success) {
      return reply
        .code(HTTP_STATUS.BAD_REQUEST)
        .send({ error: body.error.issues[0]?.message ?? 'bad request' })
    }
    const store = await spaceStoreFor(req)
    const directory = safeRelAddress(body.data.context.directory)

    if (directory == null) {
      return reply.code(HTTP_STATUS.BAD_REQUEST).send({ error: 'bad draft directory' })
    }
    const [projectList, schema] = await Promise.all([
      projectRows(req.spaceId),
      fieldSchemaStore?.read(req.spaceId),
    ])
    let prepared: Awaited<ReturnType<ViewExecutionService['prepareDraft']>>

    try {
      prepared = await views.prepareDraft({
        store,
        source: body.data.source,
        view: body.data.view,
        directory,
        projects: projectList,
        schema,
        signal: requestAbort(reply),
        snapshotGeneration: body.data.snapshotGeneration,
        schemaVersionToken: body.data.schemaVersionToken,
        cacheScope: viewCacheScope(req.spaceId, req.principal.id),
      })
    } catch (error) {
      if (error instanceof ViewExecutionCancelledError) {
        return reply
      }
      if (error instanceof ViewSnapshotConflictError) {
        return reply.code(HTTP_STATUS.CONFLICT).send({ error: error.message })
      }
      throw error
    }

    if (prepared.status !== 'ready' && prepared.status !== 'incomplete') {
      return reply
        .code(HTTP_STATUS.BAD_REQUEST)
        .send({ error: prepared.diagnostics?.[0] ?? 'view is not executable' })
    }
    let window: ReturnType<ViewExecutionService['window']>

    try {
      window =
        prepared.groups?.length && !body.data.window.group
          ? { total: prepared.total ?? 0, rows: [] }
          : views.window(prepared, body.data.window, schema)
    } catch (error) {
      return reply
        .code(HTTP_STATUS.BAD_REQUEST)
        .send({ error: (error as Error).message || 'bad view window' })
    }

    return DraftViewQueryResponseSchema.parse({
      draft: true,
      ...body.data.window,
      total: window.total,
      rows: window.rows,
      snapshotGeneration: prepared.snapshotGeneration,
      schemaVersionToken: prepared.schemaVersionToken,
      groups: prepared.groups,
      execution: prepared.execution ?? {
        exactReads: 0,
        exactCacheHits: 0,
        exactRemaining: 0,
      },
    })
  })
}
