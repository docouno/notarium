import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import {
  OkResponseSchema,
  PatchSpaceRequestSchema,
  PurgeSpaceRequestSchema,
  RestoreSpacesRequestSchema,
  RestoreSpacesResponseSchema,
  SpaceSchema,
  SpacesResponseSchema,
  StatusResponseSchema,
} from '@notarium/contract'
import { HTTP_STATUS } from '@notarium/contract/http'
import { freshNoteId, idToSlug, slugify, uniqueSlug } from '@notarium/core'

import { can } from '../../../../services/authz'
import { recordSpaceRename } from '../../../../services/projects'
import { type ApiRouteCtx, authz, batchFailure, notFound } from '../_shared'

/** Domain space record → wire row. canon: docs/contract.md#mappers */
const spaceToWire = (s: {
  id: string
  slug: string
  displayName: string
  aliases: string[]
  archivedAt?: string | null
}) => ({
  id: s.id,
  slug: s.slug,
  displayName: s.displayName,
  ...(s.aliases.length ? { aliases: s.aliases } : {}),
  ...(s.archivedAt ? { archivedAt: s.archivedAt } : {}),
})

export const spacesRoutes = async (app: FastifyInstance, ctx: ApiRouteCtx) => {
  const { spaces, auth, spacesPersistence, markerStore, spaceStoreFor } = ctx

  const canManageSpaceId = (req: FastifyRequest, id: string): boolean =>
    can(req.principal, 'space:manage', { space: id })

  /** Map a SpaceManager lifecycle error to its HTTP code. */
  const mapSpaceError = (err: unknown, reply: FastifyReply) => {
    const e = err as { reason?: string; isNotFound?: boolean }

    if (e.isNotFound) {
      return notFound(reply)
    }
    if (e.reason === 'unsupported') {
      return notFound(reply)
    }
    if (e.reason === 'not_archived') {
      return reply.code(HTTP_STATUS.CONFLICT).send({ error: (err as Error).message })
    }
    if (e.reason === 'personal_space' || e.reason === 'config_pinned') {
      return reply.code(HTTP_STATUS.BAD_REQUEST).send({ error: (err as Error).message })
    }
    throw err // unexpected — let the error handler turn it into a 500
  }

  // Membership IS the filter: a space you can't read isn't in the list (anti-enumeration).
  app.get('/api/spaces', { config: authz('spaces:list', 'host') }, async (req) =>
    SpacesResponseSchema.parse({
      spaces: spaces
        .list()
        .filter((s) => can(req.principal, 'space:read', { space: s.id }))
        .map(spaceToWire),
    }),
  )

  // Mint a space; only where the engine owns namespaces — else 404 (capability declared
  // in /api/config). canon: docs/spaces.md#deployment-notarium-engine-69
  app.post('/api/spaces', { config: authz('spaces:create', 'host') }, async (req, reply) => {
    if (!spaces.capabilities.spaceCreate) {
      return notFound(reply)
    }
    const body = (req.body || {}) as Record<string, unknown>
    // Handle is DERIVED from the human name (slugify romanises any script); an explicit
    // slug is only the derivation base, not the final handle.
    const explicit = typeof body.slug === 'string' ? slugify(body.slug) : ''
    const displayName =
      (typeof body.displayName === 'string' && body.displayName.trim()) || explicit

    if (!displayName) {
      return reply.code(HTTP_STATUS.BAD_REQUEST).send({ error: 'a name is required' })
    }
    const base = explicit || slugify(displayName)
    const free = (s: string) => !spaces.resolveId(s)
    // A derived handle is soft-suffixed on clash, never a 409 (409 is reserved for an
    // EXPLICIT rename); a name with no romanisable chars falls back to an id-shaped handle.
    // The retry loop covers the rare concurrent-mint race on the chosen slug.
    let rec: Awaited<ReturnType<typeof spaces.create>> | undefined

    for (let attempt = 0; attempt < 8 && !rec; attempt++) {
      const candidate = uniqueSlug(base || idToSlug(freshNoteId()), free)

      try {
        rec = await spaces.create({ slug: candidate, displayName })
      } catch (e) {
        if ((e as { reason?: string }).reason !== 'space_exists') {
          throw e
        }
      }
    }
    if (!rec) {
      return reply
        .code(HTTP_STATUS.CONFLICT)
        .send({ error: 'could not allocate a free space handle' })
    }
    // In 'none' auth mode there's no user to grant; the system principal already sees all.
    if (req.principal.username) {
      await auth.grantOwner(rec.id, req.principal.username)
      // Nudge the creator's other tabs so the new space appears without a reload — the
      // access-side notify grantOwner itself omits.
      auth.notifyGrantsChanged(req.principal.username)
    }

    return reply.code(HTTP_STATUS.CREATED).send(SpaceSchema.parse(spaceToWire(rec)))
  })

  // ── archived spaces (soft-delete) ───────────────────────────────────────
  // Id-addressed (no live URL/slug); 'host' authz only gates auth — each handler
  // re-checks space:manage and answers a plain 404 to a non-manager (anti-enumeration).
  // canon: docs/spaces.md#deleting-a-space-soft-archive-110

  // Membership stays intact while archived, so the space:manage gate is also the
  // listing filter (anti-enumeration).
  app.get('/api/spaces/archived', { config: authz('spaces:list', 'host') }, async (req) => {
    const mine = spaces.listArchived().filter((srec) => canManageSpaceId(req, srec.id))
    // Resolve "deleted by" to a privacy-filtered Author, relative to the viewer.
    const rows = await Promise.all(
      mine.map(async (srec) => ({
        ...spaceToWire(srec),
        archivedBy: await auth.describeAuthor(srec.archivedBy, req.principal.username),
      })),
    )
    return SpacesResponseSchema.parse({ spaces: rows })
  })

  // Restore an archived space (un-archive); id-addressed, manage-gated in-handler.
  app.post(
    '/api/spaces/:id/restore',
    { config: authz('spaces:list', 'host') },
    async (req, reply) => {
      const id = (req.params as { id: string }).id

      if (!spaces.has(id) || !canManageSpaceId(req, id)) {
        return notFound(reply)
      }
      try {
        const rec = await spaces.restore(id)
        await auth.notifySpaceRestored(id)
        return SpaceSchema.parse(spaceToWire(rec))
      } catch (err) {
        return mapSpaceError(err, reply)
      }
    },
  )

  // Best-effort batch restore: per-id failures are reported back; one stale/foreign
  // id must not block the rest.
  app.post(
    '/api/spaces/restore-many',
    { config: authz('spaces:list', 'host') },
    async (req, reply) => {
      const body = RestoreSpacesRequestSchema.safeParse(req.body)

      if (!body.success) {
        return reply
          .code(HTTP_STATUS.BAD_REQUEST)
          .send({ error: body.error.issues[0]?.message || 'bad request' })
      }

      const restored: Array<ReturnType<typeof spaceToWire>> = []
      const failed: Array<ReturnType<typeof batchFailure>> = []

      for (const id of [...new Set(body.data.ids)]) {
        if (!spaces.has(id) || !canManageSpaceId(req, id)) {
          failed.push({ id, error: 'space not found', reason: 'not_found' })
          continue
        }
        try {
          const rec = await spaces.restore(id)
          restored.push(spaceToWire(rec))
          await auth.notifySpaceRestored(id).catch((err) => {
            console.error('[api] /api/spaces/restore-many notify ->', (err as Error).message)
          })
        } catch (err) {
          failed.push(batchFailure(id, err, 'restore failed'))
        }
      }

      return RestoreSpacesResponseSchema.parse({ ok: true, restored, failed })
    },
  )

  // Permanently purge an archived space (hard-delete, irreversible); only an already-
  // archived space can be purged. Body `confirm` must equal the space's CURRENT slug —
  // a server belt against a fat-fingered id.
  app.delete('/api/spaces/:id', { config: authz('spaces:list', 'host') }, async (req, reply) => {
    const id = (req.params as { id: string }).id

    if (!spaces.has(id) || !canManageSpaceId(req, id)) {
      return notFound(reply)
    }
    const body = PurgeSpaceRequestSchema.safeParse(req.body)

    if (!body.success) {
      return reply.code(HTTP_STATUS.BAD_REQUEST).send({ error: 'a confirmation is required' })
    }
    if (body.data.confirm !== spaces.slugOf(id)) {
      return reply
        .code(HTTP_STATUS.BAD_REQUEST)
        .send({ error: 'confirmation does not match the space handle' })
    }
    try {
      await spaces.purge(id)
      return OkResponseSchema.parse({ ok: true })
    } catch (err) {
      return mapSpaceError(err, reply)
    }
  })

  // ── space-scoped family: /api/s/:space/… ────────────────────────────────────

  const s = (path: string) => `/api/s/:space${path}`

  // Rename a space (slug and/or display name, by id). canon: docs/spaces.md#model
  // A config-pinned space (env-frozen slug) refuses a slug change; a slug already in
  // use → 409 (an explicit rename is never silently suffixed, unlike a derived handle).
  app.patch(s(''), { config: authz('space:manage', 'space') }, async (req, reply) => {
    if (!spacesPersistence) {
      return notFound(reply)
    }
    const body = PatchSpaceRequestSchema.safeParse(req.body)

    if (!body.success) {
      return reply
        .code(HTTP_STATUS.BAD_REQUEST)
        .send({ error: body.error.issues[0]?.message || 'bad request' })
    }
    const id = req.spaceId

    if (body.data.slug !== undefined && spaces.isConfigPinned(id)) {
      return reply
        .code(HTTP_STATUS.BAD_REQUEST)
        .send({ error: 'this space is pinned by host config — its slug is fixed' })
    }
    const result = await recordSpaceRename(
      { spaces: spacesPersistence, markerStore, now: () => new Date() },
      { id, slug: body.data.slug, displayName: body.data.displayName },
    )

    if (result.code !== 'ok') {
      if (result.code === 'not_found') {
        return notFound(reply)
      }
      if (result.code === 'collision') {
        return reply
          .code(HTTP_STATUS.CONFLICT)
          .send({ error: 'a space with that slug already exists' })
      }

      return reply.code(HTTP_STATUS.BAD_REQUEST).send({ error: 'bad slug' })
    }
    // Re-key the in-memory slug→id index so the new slug resolves immediately; the
    // store/engine are untouched (the id and notes_dir never changed).
    spaces.applyRename(result.record)
    // SSE `rename` event so other tabs follow the new slug without a reload; the stream
    // is keyed by the unchanged id, so it still resolves.
    auth.notifySpaceRenamed(id)
    return SpaceSchema.parse(spaceToWire(result.record))
  })

  // Archive a space (soft-delete): stop serving it while data/journal/index stay whole;
  // restore reverses it.
  // A personal space and a config-pinned space refuse it. Slug-addressed (still live at
  // archive time), unlike id-addressed restore/purge.
  app.delete(s(''), { config: authz('space:manage', 'space') }, async (req, reply) => {
    const id = req.spaceId

    try {
      // Record WHO archived it (attribution resolved to an Author on the archived listing).
      await spaces.archive(id, req.principal.id)
    } catch (err) {
      return mapSpaceError(err, reply)
    }
    // Drive the access-lost flow for every member (close live viewers → takeover; drop
    // the space from their switcher).
    await auth.notifySpaceArchived(id)
    return OkResponseSchema.parse({ ok: true })
  })

  // Read-model sync state for this space (boot scan, delta poll, engine indexing).
  // canon: docs/core.md#read-model
  app.get(s('/status'), { config: authz('space:read', 'space') }, async (req) =>
    StatusResponseSchema.parse(await (await spaceStoreFor(req)).syncStatus()),
  )
}
