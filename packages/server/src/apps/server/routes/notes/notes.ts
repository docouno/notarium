import type { FastifyInstance, FastifyRequest } from 'fastify'

import {
  BucketsQuerySchema,
  BucketsResponseSchema,
  CreateNoteRequestSchema,
  FAVORITE_ENTITY_KIND,
  NotesQuerySchema,
  NotesResponseSchema,
  SaveResponseSchema,
  TagsQuerySchema,
  TagsResponseSchema,
} from '@notarium/contract'
import { HTTP_STATUS } from '@notarium/contract/http'
import { bucketCounts, deriveNoteTitle, type NoteMeta, queryNotes, tagFacet } from '@notarium/core'

import { safeRelPath } from '../../../../libs/relPath'
import type { SpaceStore } from '../../../../services/spaces'
import { type ApiRouteCtx, authz, missing, s } from '../_shared'
import { createToDomain, noteToWire } from '../wire'

export const notesRoutes = async (app: FastifyInstance, ctx: ApiRouteCtx) => {
  const { spaceStoreFor, favoriteOwner, favorites, principalId } = ctx

  /** Cap on the lexical-hit set intersected into a `q`-narrowed Feed query.
   *  list() and search() both default to scope 'user', so the intersection stays visibility-consistent.
   *  canon: docs/feed-page.md#data-flow */
  const FEED_Q_CAP = 10_000

  const notesForQuery = async (store: SpaceStore, q?: string): Promise<NoteMeta[]> => {
    const notes = await store.list()
    const text = (q ?? '').trim()

    if (!text) {
      return notes
    }
    const hits = await store.search(text, { pageSize: FEED_Q_CAP, lexicalOnly: true })

    // Hitting the cap means the q-narrowed `total` is an undercount — warn rather than fail silently.
    if (hits.length >= FEED_Q_CAP) {
      console.warn(`[api] q="${text}" hit FEED_Q_CAP (${FEED_Q_CAP}); the Feed's q-total is capped`)
    }
    const ids = new Set(hits.map((h) => h.id).filter((id): id is string => id != null))
    return notes.filter((n) => n.id != null && ids.has(n.id))
  }
  const favoriteNoteIdsFor = (req: FastifyRequest): Promise<string[]> =>
    favorites
      ? favorites.ids(favoriteOwner(req), req.spaceId, FAVORITE_ENTITY_KIND.note)
      : Promise.resolve([])

  // Windowed list: server-side filter+sort+slice, `total` for honest scrollbars.
  // `?preview=1` peeks the WARM preview cache only (never an engine read); cold notes return null for the client to batch via POST /api/previews.
  app.get(s('/notes'), { config: authz('space:read', 'space') }, async (req, reply) => {
    const q = NotesQuerySchema.safeParse(req.query)

    if (!q.success) {
      return reply
        .code(HTTP_STATUS.BAD_REQUEST)
        .send({ error: q.error.issues[0]?.message || 'bad query' })
    }
    const store = await spaceStoreFor(req)
    const ids = q.data.favorite === '1' ? await favoriteNoteIdsFor(req) : undefined
    const page = queryNotes(await notesForQuery(store, q.data.q), { ...q.data, ids })
    const withPreview = q.data.preview === '1'
    return NotesResponseSchema.parse({
      notes: page.notes.map((n) => ({
        ...noteToWire(n),
        ...(withPreview ? { preview: n.id ? store.previewPeek(n.id) : null } : {}),
      })),
      total: page.total,
    })
  })

  // Date histogram of the same query as /notes; its buckets sum to that endpoint's `total`.
  app.get(s('/notes/buckets'), { config: authz('space:read', 'space') }, async (req, reply) => {
    const q = BucketsQuerySchema.safeParse(req.query)

    if (!q.success) {
      return reply
        .code(HTTP_STATUS.BAD_REQUEST)
        .send({ error: q.error.issues[0]?.message || 'bad query' })
    }
    const ids = q.data.favorite === '1' ? await favoriteNoteIdsFor(req) : undefined
    return BucketsResponseSchema.parse(
      bucketCounts(await notesForQuery(await spaceStoreFor(req), q.data.q), { ...q.data, ids }),
    )
  })

  // Tag facet over store.list(), which defaults to scope 'user' — agent-memory tags never surface here.
  // canon: docs/note-model.md#tags-as-a-navigation-axis-109 · docs/note-model.md#agent-memory
  app.get(s('/tags'), { config: authz('space:read', 'space') }, async (req, reply) => {
    const q = TagsQuerySchema.safeParse(req.query)

    if (!q.success) {
      return reply
        .code(HTTP_STATUS.BAD_REQUEST)
        .send({ error: q.error.issues[0]?.message || 'bad query' })
    }

    return TagsResponseSchema.parse(tagFacet(await (await spaceStoreFor(req)).list(), q.data))
  })

  // Create a note (collection POST; updates are id-addressed elsewhere).
  // `directory` is untrusted: normalised and traversal-rejected here, BEFORE the engine (defense in depth).
  // canon: docs/contract.md#routing
  app.post(s('/notes'), { config: authz('space:write', 'space') }, async (req, reply) => {
    const body = (req.body || {}) as Record<string, unknown>
    const parsed = CreateNoteRequestSchema.parse(body)

    // Title is body-first: the editor sends no `title`, authoring it as the leading `# H1`.
    // Fail closed only when neither an explicit title nor a derivable first line exists.
    if (!deriveNoteTitle(parsed.content ?? '', parsed.title)) {
      return missing(reply, 'title')
    }
    let directory: string | undefined

    if (parsed.directory !== undefined) {
      const safe = safeRelPath(parsed.directory)

      if (safe === null) {
        return reply.code(HTTP_STATUS.BAD_REQUEST).send({ error: 'bad directory path' })
      }
      directory = safe
    }
    const store = await spaceStoreFor(req)
    const r = await store.write(createToDomain({ ...parsed, directory }, principalId(req)))
    return SaveResponseSchema.parse({
      ok: true,
      id: r.id,
      filePath: r.filePath,
      versionToken: r.versionToken,
    })
  })
}
