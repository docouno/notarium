import type { FastifyInstance, FastifyRequest } from 'fastify'

import {
  CONTEXT_KIND,
  ContextOrderRequestSchema,
  ContextPinRequestSchema,
  ContextSetCreateRequestSchema,
  ContextSetItemRequestSchema,
  ContextSetOrderRequestSchema,
  ContextSetPatchRequestSchema,
  ContextSetResponseSchema,
  ContextSetsResponseSchema,
  OkResponseSchema,
} from '@notarium/contract'
import { HTTP_STATUS } from '@notarium/contract/http'
import { freshNoteId } from '@notarium/core'

import { can } from '../../../../services/authz'
import type { ContextSetRecord } from '../../../../services/metaDb'
import { readNoteAccess } from '../../../../services/storeAccess'
import { type ApiRouteCtx, authz, notFound, s } from '../_shared'

export const contextSetsRoutes = async (app: FastifyInstance, ctx: ApiRouteCtx) => {
  const { contextSets, projects, scopePins, contextOrder, spaces, auth } = ctx

  // ── context sets: named cross-space collections + scope attachments ──
  // canon: docs/projects.md#context-sets-209-reusable-cross-space-bundles

  /** Wire view of a set for the manager, degraded per-reader. */
  const describeContextSet = async (req: FastifyRequest, set: ContextSetRecord) => {
    const items = await Promise.all(
      set.items.map(async (ref) => {
        const hit = await readNoteAccess(ctx.storeAccess, req.principal, ref.noteId, 'note:read')
        return {
          noteId: hit?.noteId ?? ref.noteId,
          // Null the space like the title — never leak the slug of a space the reader can't reach.
          space: hit ? (spaces.slugOf(hit.space) ?? hit.space) : null,
          title: hit ? (hit.note.title ?? '') : null,
        }
      }),
    )
    const attachments = contextSets ? await contextSets.attachmentsForSet(set.id) : []
    // Per-reader redaction: drop attachments to scopes the reader can't `space:read`.
    // A personal space is single-member → others never learn it loads this set.
    const attachmentsWire = (
      await Promise.all(
        attachments.map(async (a) => {
          if (a.targetKind === CONTEXT_KIND.personal) {
            if (!can(req.principal, 'space:read', { space: a.targetId })) {
              return null
            }

            return { kind: CONTEXT_KIND.personal, id: a.targetId, label: 'Personal' }
          }
          const proj = projects ? await projects.getById(a.targetId) : null

          if (!proj || !can(req.principal, 'space:read', { space: proj.space })) {
            return null
          }

          return {
            kind: CONTEXT_KIND.project,
            id: a.targetId,
            label: `${spaces.slugOf(proj.space) ?? proj.space}/${proj.slug}`,
          }
        }),
      )
    ).filter((a): a is NonNullable<typeof a> => a != null)
    return {
      id: set.id,
      name: set.name,
      homeSpace: spaces.slugOf(set.homeSpace) ?? set.homeSpace,
      personal: await auth.isPersonalSpace(set.homeSpace),
      items,
      attachments: attachmentsWire,
      createdAt: set.createdAt,
    }
  }

  app.get('/api/context-sets', { config: authz('self:read', 'host') }, async (req) => {
    if (!contextSets) {
      return ContextSetsResponseSchema.parse({ sets: [] })
    }
    const readable = spaces
      .list()
      .map((sp) => sp.id)
      .filter((id) => can(req.principal, 'space:read', { space: id }))
    const all = (await Promise.all(readable.map((id) => contextSets.listSetsForSpace(id)))).flat()
    const sets = await Promise.all(all.map((set) => describeContextSet(req, set)))
    return ContextSetsResponseSchema.parse({ sets })
  })

  app.post(s('/context-sets'), { config: authz('space:write', 'space') }, async (req, reply) => {
    if (!contextSets) {
      return notFound(reply)
    }
    const body = ContextSetCreateRequestSchema.safeParse(req.body ?? {})

    if (!body.success) {
      return reply
        .code(HTTP_STATUS.BAD_REQUEST)
        .send({ error: body.error.issues[0]?.message || 'bad request' })
    }
    const set: ContextSetRecord = {
      id: freshNoteId(),
      homeSpace: req.spaceId,
      name: body.data.name,
      items: [],
      createdAt: new Date().toISOString(),
    }
    await contextSets.createSet(set)
    return ContextSetResponseSchema.parse({ set: await describeContextSet(req, set) })
  })

  app.patch(
    s('/context-sets/:id'),
    { config: authz('space:write', 'space') },
    async (req, reply) => {
      if (!contextSets) {
        return notFound(reply)
      }
      const id = (req.params as { id?: string }).id ?? ''
      const set = await contextSets.getSet(id)

      if (!set || set.homeSpace !== req.spaceId) {
        return notFound(reply)
      }
      const body = ContextSetPatchRequestSchema.safeParse(req.body ?? {})

      if (!body.success) {
        return reply
          .code(HTTP_STATUS.BAD_REQUEST)
          .send({ error: body.error.issues[0]?.message || 'bad request' })
      }
      await contextSets.renameSet(id, body.data.name)
      return ContextSetResponseSchema.parse({
        set: await describeContextSet(req, { ...set, name: body.data.name }),
      })
    },
  )

  app.delete(
    s('/context-sets/:id'),
    { config: authz('space:write', 'space') },
    async (req, reply) => {
      if (!contextSets) {
        return notFound(reply)
      }
      const id = (req.params as { id?: string }).id ?? ''
      const set = await contextSets.getSet(id)

      if (!set || set.homeSpace !== req.spaceId) {
        return notFound(reply)
      }
      await contextSets.deleteSet(id)
      return OkResponseSchema.parse({ ok: true })
    },
  )

  // Item space comes from the registry (via noteStore), never the request body.
  app.post(
    s('/context-sets/:id/items'),
    { config: authz('space:write', 'space') },
    async (req, reply) => {
      if (!contextSets) {
        return notFound(reply)
      }
      const id = (req.params as { id?: string }).id ?? ''
      const set = await contextSets.getSet(id)

      if (!set || set.homeSpace !== req.spaceId) {
        return notFound(reply)
      }
      const body = ContextSetItemRequestSchema.safeParse(req.body ?? {})

      if (!body.success) {
        return reply
          .code(HTTP_STATUS.BAD_REQUEST)
          .send({ error: body.error.issues[0]?.message || 'bad request' })
      }
      const hit = await readNoteAccess(
        ctx.storeAccess,
        req.principal,
        body.data.noteId,
        'note:read',
      )

      if (!hit) {
        return notFound(reply)
      }
      // Atomic add, idempotent by noteId — no read-modify-write race.
      const updated = await contextSets.addItem(id, { space: hit.space, noteId: hit.noteId })

      if (!updated) {
        return notFound(reply)
      }

      return ContextSetResponseSchema.parse({ set: await describeContextSet(req, updated) })
    },
  )

  app.delete(
    s('/context-sets/:id/items/:noteId'),
    { config: authz('space:write', 'space') },
    async (req, reply) => {
      if (!contextSets) {
        return notFound(reply)
      }
      const p = req.params as { id?: string; noteId?: string }
      const set = await contextSets.getSet(p.id ?? '')

      if (!set || set.homeSpace !== req.spaceId) {
        return notFound(reply)
      }
      const requestedId = p.noteId ?? ''
      const live = await readNoteAccess(ctx.storeAccess, req.principal, requestedId, 'note:read')
      const updated = await contextSets.removeItem(set.id, live?.noteId ?? requestedId)

      if (!updated) {
        return notFound(reply)
      }

      return ContextSetResponseSchema.parse({ set: await describeContextSet(req, updated) })
    },
  )

  // Atomic rewrite to the given note-id sequence: unknown ids ignored, a
  // concurrently-added item missing from the sequence is appended (never dropped).
  app.put(
    s('/context-sets/:id/order'),
    { config: authz('space:write', 'space') },
    async (req, reply) => {
      if (!contextSets) {
        return notFound(reply)
      }
      const id = (req.params as { id?: string }).id ?? ''
      const set = await contextSets.getSet(id)

      if (!set || set.homeSpace !== req.spaceId) {
        return notFound(reply)
      }
      const body = ContextSetOrderRequestSchema.safeParse(req.body ?? {})

      if (!body.success) {
        return reply
          .code(HTTP_STATUS.BAD_REQUEST)
          .send({ error: body.error.issues[0]?.message || 'bad request' })
      }
      const noteIds = await Promise.all(
        body.data.noteIds.map(async (noteId) => {
          const live = await readNoteAccess(ctx.storeAccess, req.principal, noteId, 'note:read')
          return live?.noteId ?? noteId
        }),
      )
      const updated = await contextSets.reorderItems(id, noteIds)

      if (!updated) {
        return notFound(reply)
      }

      return ContextSetResponseSchema.parse({ set: await describeContextSet(req, updated) })
    },
  )

  // ownership ≥ attachment: a personal-homed set can't attach to a shared project — 400.
  app.put(
    s('/projects/:pid/context-sets/:id'),
    { config: authz('space:write', 'space') },
    async (req, reply) => {
      if (!contextSets || !projects) {
        return notFound(reply)
      }
      const p = req.params as { pid?: string; id?: string }
      const proj = await projects.getById(p.pid ?? '')

      if (!proj || proj.space !== req.spaceId) {
        return notFound(reply)
      }
      const set = await contextSets.getSet(p.id ?? '')

      if (!set || !can(req.principal, 'space:read', { space: set.homeSpace })) {
        return notFound(reply)
      }
      if (await auth.isPersonalSpace(set.homeSpace)) {
        return reply.code(HTTP_STATUS.BAD_REQUEST).send({
          error:
            'a personal set cannot be attached to a shared project — move it to a shared space first',
        })
      }
      await contextSets.attach({
        setId: set.id,
        targetKind: CONTEXT_KIND.project,
        targetId: proj.id,
        targetSpace: req.spaceId,
        createdAt: new Date().toISOString(),
      })
      return OkResponseSchema.parse({ ok: true })
    },
  )

  // Re-check the project lives in THIS space: the space:write gate is on the URL slug,
  // not the resource — else a writer of one space could mutate a project in another.
  app.delete(
    s('/projects/:pid/context-sets/:id'),
    { config: authz('space:write', 'space') },
    async (req, reply) => {
      if (!contextSets || !projects) {
        return notFound(reply)
      }
      const p = req.params as { pid?: string; id?: string }
      const proj = await projects.getById(p.pid ?? '')

      if (!proj || proj.space !== req.spaceId) {
        return notFound(reply)
      }
      await contextSets.detach(p.id ?? '', 'project', proj.id)
      return OkResponseSchema.parse({ ok: true })
    },
  )

  // Loose cross-space pin: the note need only be READABLE; its space comes from the
  // registry, not the body.
  app.put(
    s('/projects/:pid/context-pins'),
    { config: authz('space:write', 'space') },
    async (req, reply) => {
      if (!scopePins || !projects) {
        return notFound(reply)
      }
      const p = req.params as { pid?: string }
      const proj = await projects.getById(p.pid ?? '')

      if (!proj || proj.space !== req.spaceId) {
        return notFound(reply)
      }
      const body = ContextPinRequestSchema.safeParse(req.body ?? {})

      if (!body.success) {
        return reply
          .code(HTTP_STATUS.BAD_REQUEST)
          .send({ error: body.error.issues[0]?.message || 'bad request' })
      }
      const hit = await readNoteAccess(
        ctx.storeAccess,
        req.principal,
        body.data.noteId,
        'note:read',
      )

      if (!hit) {
        return notFound(reply)
      }
      await scopePins.addPin({
        targetKind: CONTEXT_KIND.project,
        targetId: proj.id,
        targetSpace: req.spaceId,
        noteSpace: hit.space,
        noteId: hit.noteId,
        createdAt: new Date().toISOString(),
      })
      return OkResponseSchema.parse({ ok: true })
    },
  )

  app.delete(
    s('/projects/:pid/context-pins/:noteId'),
    { config: authz('space:write', 'space') },
    async (req, reply) => {
      if (!scopePins || !projects) {
        return notFound(reply)
      }
      const p = req.params as { pid?: string; noteId?: string }
      const proj = await projects.getById(p.pid ?? '')

      if (!proj || proj.space !== req.spaceId) {
        return notFound(reply)
      }
      const requestedId = p.noteId ?? ''
      const live = await readNoteAccess(ctx.storeAccess, req.principal, requestedId, 'note:read')
      await scopePins.removePin('project', proj.id, live?.noteId ?? requestedId)
      return OkResponseSchema.parse({ ok: true })
    },
  )

  // Replace the whole order overlay atomically. Membership isn't re-validated here —
  // a stale entry just ranks nothing.
  app.put(
    s('/projects/:pid/context-order'),
    { config: authz('space:write', 'space') },
    async (req, reply) => {
      if (!contextOrder || !projects) {
        return notFound(reply)
      }
      const p = req.params as { pid?: string }
      const proj = await projects.getById(p.pid ?? '')

      if (!proj || proj.space !== req.spaceId) {
        return notFound(reply)
      }
      const body = ContextOrderRequestSchema.safeParse(req.body ?? {})

      if (!body.success) {
        return reply
          .code(HTTP_STATUS.BAD_REQUEST)
          .send({ error: body.error.issues[0]?.message || 'bad request' })
      }
      const entries = await Promise.all(
        body.data.entries.map(async (entry) => {
          if (entry.kind !== 'pin') {
            return { entryKind: entry.kind, entryRef: entry.ref }
          }
          const live = await readNoteAccess(ctx.storeAccess, req.principal, entry.ref, 'note:read')
          return { entryKind: entry.kind, entryRef: live?.noteId ?? entry.ref }
        }),
      )
      await contextOrder.setOrder('project', proj.id, req.spaceId, entries)
      return OkResponseSchema.parse({ ok: true })
    },
  )
}
