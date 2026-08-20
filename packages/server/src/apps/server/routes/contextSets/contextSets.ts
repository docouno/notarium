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
  MeRoleContextResponseSchema,
  OkResponseSchema,
  RoleContextQuerySchema,
} from '@notarium/contract'
import { HTTP_STATUS } from '@notarium/contract/http'
import { decodeAbilityLocator, freshNoteId } from '@notarium/core'

import { can } from '../../../../services/authz'
import type { ContextSetRecord } from '../../../../services/metaDb'
import { projectSummaryOf } from '../../../../services/projects'
import {
  ownedRoleLocator,
  parseRoleContextTarget,
  type ResolvedOwnedRole,
  roleContextTargetOf,
  weighRoleContext,
} from '../../../../services/roles'
import { curatePersonalScope } from '../../../../services/spaces'
import { peekPersonalSpace } from '../../../../services/spaces'
import { readNoteAccess } from '../../../../services/storeAccess'
import { type ApiRouteCtx, authz, notFound, s } from '../_shared'
import { roleContextIdentityOf } from '../wire'

export const contextSetsRoutes = async (app: FastifyInstance, ctx: ApiRouteCtx) => {
  const { contextSets, projects, scopePins, contextOrder, spaces, auth, roles } = ctx

  /** Resolve the exact enabled owned Role placement carried by the route. The
   * locator already contains its immutable location; display names and a separate
   * project query never participate in mutation addressing. */
  const resolveRoleTarget = async (
    req: FastifyRequest,
    encodedLocator: string,
  ): Promise<ResolvedOwnedRole | null> => {
    if (!roles) {
      return null
    }
    const locator = decodeAbilityLocator(encodedLocator)

    if (locator?.source !== 'owned' || locator.kind !== 'role') {
      return null
    }

    return roles.addressedRoleAt(
      locator,
      req.principal,
      await peekPersonalSpace({ auth, spaces }, req.principal),
    )
  }

  /** A personal role is owned by the caller. Shared placements retain their space's
   * writer gate: selecting a role never expands the caller's rights. */
  const canWriteRole = (req: FastifyRequest, role: ResolvedOwnedRole): boolean =>
    role.location.scope === 'personal' ||
    can(req.principal, 'space:write', { space: role.location.space })

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
    // A property of the CALLER, not of an attachment: reading it per item asked the
    // same question once per row of the set.
    const personalSpace = await peekPersonalSpace({ auth, spaces }, req.principal)
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
          if (a.targetKind === CONTEXT_KIND.role) {
            const target = parseRoleContextTarget(a.targetId)

            if (!target) {
              return null
            }
            // A role target names its own placement, so the space to authorise against
            // and the label's tail both follow from that one reading — asked once here
            // rather than re-derived per scope.
            const project =
              target.scope === 'project' && projects ? await projects.getById(target.ownerId) : null
            const space = target.scope === 'project' ? project?.space : target.ownerId

            if (
              space == null ||
              (target.scope === 'project' ? space : target.ownerId) !== a.targetSpace ||
              !can(req.principal, 'space:read', { space })
            ) {
              return null
            }
            const role = await roles?.addressedRoleAt(
              ownedRoleLocator(
                target.scope === 'project'
                  ? { scope: 'project', space, projectId: target.ownerId }
                  : { scope: target.scope, space: target.ownerId },
                target.packageId,
              ),
              req.principal,
              personalSpace,
            )
            const where =
              target.scope === 'personal'
                ? 'Personal'
                : target.scope === 'space'
                  ? (spaces.slugOf(space) ?? space)
                  : `${spaces.slugOf(space) ?? space}/${project!.slug}`

            return {
              kind: CONTEXT_KIND.role,
              id: a.targetId,
              label: `Role · ${role?.role.name ?? target.packageId} · ${where}`,
            }
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

  // ── role presets: the same context facets, keyed by one exact owned placement ──

  /** The IDENTITY door: which role this address names, its editable layer, and whether
   *  the agent would load it where the caller is standing.
   *
   *  Separate from the context PREVIEW on purpose, and the separation is the fix for a
   *  defect the preview kept producing either way. Fold the two together and one of the
   *  two answers is always wrong: answer identity only when the role is effective, and a
   *  member who switched a shared role off for themselves is told it does not exist on
   *  the very page that configures its shared context; answer it always, and the layer
   *  of a role the agent does not load gets charged to the session budget and displaces
   *  a pin that IS loaded. So identity is answered here, without a budget, and the
   *  preview goes on mirroring the agent exactly.
   *
   *  `self:read` rather than `self:manage`: reading which role an address names is not
   *  a mutation, and the write gate stays on the five routes below. Reach is a question
   *  about a project, so `?project=` is how a caller asks it about one. */
  app.get(
    '/api/me/agent-roles/:locator/context',
    { config: authz('self:read', 'host') },
    async (req, reply) => {
      if (!roles) {
        return notFound(reply)
      }
      const p = req.params as { locator?: string }
      const locator = decodeAbilityLocator(p.locator ?? '')

      if (locator?.source !== 'owned' || locator.kind !== 'role') {
        return notFound(reply)
      }
      const query = RoleContextQuerySchema.parse(req.query)
      const asked = query.project ? await projects?.getById(query.project) : null
      // A project id off the wire is a CLAIM, and `getById` is a raw registry accessor
      // that answers for every space at once. Without this gate the parameter told a
      // non-member two things it may not know: that an id exists (404 against 200), and
      // the slug of the space holding it — including a personal one. The five doors
      // below and the space-cornered twin both gate this; this one did not, and it is
      // the same anti-enumeration rule they keep. Unreadable and absent answer the SAME
      // 404 on purpose: a distinguishable refusal is the oracle, not the disclosure.
      const project =
        asked && can(req.principal, 'space:read', { space: asked.space }) ? asked : null

      if (query.project && !project) {
        return notFound(reply)
      }
      const status = await roles.addressedRoleStatus(
        {
          personalSpace: await peekPersonalSpace({ auth, spaces }, req.principal),
          ...(project ? { project } : {}),
        },
        req.principal,
        locator,
      )

      if (!status) {
        return notFound(reply)
      }
      // The handle of the project this ROLE STANDS IN — not of the project the caller
      // asked about, and not a space slug. Those are three different strings, and this
      // field had all three: a raw registry id without `?project=`, a space slug with
      // it, and the handle from the preview door on the same role. Read from the
      // ADDRESSED placement, so it needs no gate of its own: the caller has already
      // proved it may read that placement.
      const placement = status.role.location
      const placementProject =
        placement.scope === 'project' && placement.projectId
          ? await projects?.getById(placement.projectId)
          : null
      const layer = await weighRoleContext(
        { store: ctx.storeAccess, spaces, contextSets, scopePins, contextOrder },
        req.principal,
        status.role,
      )
      // Curation is asked for the ORDER and for nothing else. Its dedup is a rule about
      // LOADING — "a note the agent would load twice loads once" — and this door is not
      // about loading: it is the surface that edits the list. Applied here it deleted the
      // second membership of a note that legitimately sits in two sets on one role, and
      // with the row gone there was no `Remove from set` to reach it by. So the sequence
      // comes from the shared producer and the CONTENT stays exactly what the author put
      // on the role.
      const ordered = curatePersonalScope([], [], [], Number.MAX_SAFE_INTEGER, [], layer)
      const pinOrder = new Map((ordered.role?.pins ?? []).map((pin) => [pin.noteId, pin.order]))
      const setOrder = new Map((ordered.role?.sets ?? []).map((set) => [set.id, set.order]))
      // `loaded` is a formality here: the identity producer below strips it, because this
      // door weighs no budget. Kept true rather than invented false — under a budget
      // nothing can exceed, that is also what curation says about every row it kept.
      const authored = {
        pins: layer.pins.map((pin, index) => ({
          ...pin,
          loaded: true,
          order: pinOrder.get(pin.noteId) ?? index,
        })),
        sets: layer.sets.map((set, index) => ({
          ...set,
          order: setOrder.get(set.id) ?? index,
          items: set.items.map((item, itemIndex) => ({ ...item, loaded: true, order: itemIndex })),
        })),
      }

      return MeRoleContextResponseSchema.parse({
        role: roleContextIdentityOf(
          status,
          locator,
          (space) => spaces.slugOf(space) ?? space,
          placementProject
            ? projectSummaryOf(
                placementProject,
                spaces.slugOf(placementProject.space) ?? placementProject.space,
              ).handle
            : null,
          authored,
        ),
        active: status.active,
        ...(status.active ? {} : { inactive: status.inactive }),
      })
    },
  )

  app.put(
    '/api/me/agent-roles/:locator/context-sets/:id',
    { config: authz('self:manage', 'host') },
    async (req, reply) => {
      if (!contextSets) {
        return notFound(reply)
      }
      const p = req.params as { locator?: string; id?: string }
      const role = await resolveRoleTarget(req, p.locator ?? '')

      if (!role) {
        return notFound(reply)
      }
      if (!canWriteRole(req, role)) {
        return reply.code(HTTP_STATUS.FORBIDDEN).send({ error: 'forbidden' })
      }
      const set = await contextSets.getSet(p.id ?? '')

      if (!set || !can(req.principal, 'space:read', { space: set.homeSpace })) {
        return notFound(reply)
      }
      if (role.location.scope !== 'personal' && (await auth.isPersonalSpace(set.homeSpace))) {
        return reply.code(HTTP_STATUS.BAD_REQUEST).send({
          error:
            'a personal set cannot be attached to a shared role — move it to a shared space first',
        })
      }
      const target = roleContextTargetOf(role)
      await contextSets.attach({
        setId: set.id,
        targetKind: CONTEXT_KIND.role,
        targetId: target.id,
        targetSpace: target.space,
        createdAt: new Date().toISOString(),
      })
      return OkResponseSchema.parse({ ok: true })
    },
  )

  app.delete(
    '/api/me/agent-roles/:locator/context-sets/:id',
    { config: authz('self:manage', 'host') },
    async (req, reply) => {
      if (!contextSets) {
        return notFound(reply)
      }
      const p = req.params as { locator?: string; id?: string }
      const role = await resolveRoleTarget(req, p.locator ?? '')

      if (!role) {
        return notFound(reply)
      }
      if (!canWriteRole(req, role)) {
        return reply.code(HTTP_STATUS.FORBIDDEN).send({ error: 'forbidden' })
      }
      await contextSets.detach(p.id ?? '', CONTEXT_KIND.role, roleContextTargetOf(role).id)
      return OkResponseSchema.parse({ ok: true })
    },
  )

  app.put(
    '/api/me/agent-roles/:locator/context-pins',
    { config: authz('self:manage', 'host') },
    async (req, reply) => {
      if (!scopePins) {
        return notFound(reply)
      }
      const p = req.params as { locator?: string }
      const role = await resolveRoleTarget(req, p.locator ?? '')

      if (!role) {
        return notFound(reply)
      }
      if (!canWriteRole(req, role)) {
        return reply.code(HTTP_STATUS.FORBIDDEN).send({ error: 'forbidden' })
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
      const target = roleContextTargetOf(role)
      await scopePins.addPin({
        targetKind: CONTEXT_KIND.role,
        targetId: target.id,
        targetSpace: target.space,
        noteSpace: hit.space,
        noteId: hit.noteId,
        createdAt: new Date().toISOString(),
      })
      return OkResponseSchema.parse({ ok: true })
    },
  )

  app.delete(
    '/api/me/agent-roles/:locator/context-pins/:noteId',
    { config: authz('self:manage', 'host') },
    async (req, reply) => {
      if (!scopePins) {
        return notFound(reply)
      }
      const p = req.params as { locator?: string; noteId?: string }
      const role = await resolveRoleTarget(req, p.locator ?? '')

      if (!role) {
        return notFound(reply)
      }
      if (!canWriteRole(req, role)) {
        return reply.code(HTTP_STATUS.FORBIDDEN).send({ error: 'forbidden' })
      }
      const requestedId = p.noteId ?? ''
      const live = await readNoteAccess(ctx.storeAccess, req.principal, requestedId, 'note:read')
      await scopePins.removePin(
        CONTEXT_KIND.role,
        roleContextTargetOf(role).id,
        live?.noteId ?? requestedId,
      )
      return OkResponseSchema.parse({ ok: true })
    },
  )

  app.put(
    '/api/me/agent-roles/:locator/context-order',
    { config: authz('self:manage', 'host') },
    async (req, reply) => {
      if (!contextOrder) {
        return notFound(reply)
      }
      const p = req.params as { locator?: string }
      const role = await resolveRoleTarget(req, p.locator ?? '')

      if (!role) {
        return notFound(reply)
      }
      if (!canWriteRole(req, role)) {
        return reply.code(HTTP_STATUS.FORBIDDEN).send({ error: 'forbidden' })
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
      const target = roleContextTargetOf(role)
      await contextOrder.setOrder(CONTEXT_KIND.role, target.id, target.space, entries)
      return OkResponseSchema.parse({ ok: true })
    },
  )
}
