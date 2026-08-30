import type { FastifyInstance } from 'fastify'

import {
  ABILITY_KIND,
  AgentContextQuerySchema,
  CONTEXT_KIND,
  MarkProjectRequestSchema,
  PatchProjectRequestSchema,
  PROJECT_STATUS,
  ProjectAgentContextResponseSchema,
  ProjectMemoryQuerySchema,
  ProjectMemoryResponseSchema,
  ProjectRowSchema,
  ProjectsResponseSchema,
  RemoveResponseSchema,
} from '@notarium/contract'
import { HTTP_STATUS } from '@notarium/contract/http'
import { decodeAbilityLocator, folderPageFilePath } from '@notarium/core'

import { withAuthors } from '../../../../libs/authors'
import { safeRelAddress, safeRelPath } from '../../../../libs/relPath'
import {
  markFolderAsProject,
  projectSummaryOf,
  renameProjectSlug,
  unmarkProject,
} from '../../../../services/projects'
import { ROLE_SCOPE, weighRoleContext } from '../../../../services/roles'
import {
  curateProjectScope,
  enqueueConditionalNotePin,
  listMemoryCategories,
  peekPersonalSpace,
  PROJECT_TOKEN_BUDGET,
  projectIndexSummary,
  weighAlwaysLoad,
} from '../../../../services/spaces'
import {
  weighScopeContextSets,
  weighScopeOrder,
  weighScopePins,
} from '../../../../services/storeAccess'
import { type ApiRouteCtx, authz, notFound, s } from '../_shared'
import { contextRoleSummaryOf, contextSetViewOf, roleContextViewOf } from '../wire'

export const projectsRoutes = async (app: FastifyInstance, ctx: ApiRouteCtx) => {
  const { projects, markerStore, folders, spaces, spaceStoreFor, principalId } = ctx
  const { storeAccess, contextSets, scopePins, contextOrder, auth, roles, abilities } = ctx

  // Mark a folder (or space root, folderPath: '') as a project: write-through the
  // `.notariummeta` marker + upsert the registry row. Idempotent; marking is
  // explicit — space creation never marks. No registry/marker storage → 404 (P5).
  // canon: docs/projects.md#project-identity-the-marker-file-pattern-51-lifted-notefolder
  app.post(s('/projects'), { config: authz('space:write', 'space') }, async (req, reply) => {
    if (!projects) {
      return notFound(reply)
    }
    const body = MarkProjectRequestSchema.safeParse(req.body)

    if (!body.success) {
      return reply
        .code(HTTP_STATUS.BAD_REQUEST)
        .send({ error: body.error.issues[0]?.message || 'bad request' })
    }
    // Existing legacy folders remain addressable, but `create:true` is a public
    // creation capability and may materialize only portable components.
    const safe = body.data.create
      ? safeRelPath(body.data.folderPath)
      : safeRelAddress(body.data.folderPath)

    if (safe === null) {
      return reply.code(HTTP_STATUS.BAD_REQUEST).send({ error: 'bad folder path' })
    }
    const space = req.spaceId

    if (markerStore) {
      if (!markerStore.available(space)) {
        return notFound(reply)
      }
      const exists = await markerStore.folderExists(space, safe)

      // `create` addresses a fresh path that the space store materializes below;
      // a plain mark addresses an EXISTING folder.
      if (body.data.create) {
        if (exists) {
          return reply
            .code(HTTP_STATUS.CONFLICT)
            .send({ error: 'a folder with that name already exists' })
        }
      } else if (!exists) {
        return reply.code(HTTP_STATUS.BAD_REQUEST).send({ error: 'no such folder' })
      }
    }
    const store = await spaceStoreFor(req)

    if (body.data.create) {
      if (!store.makeDir) {
        return notFound(reply)
      }
      try {
        // The space store is the sole owner of user-visible directories: it
        // updates the engine and CachedStore's directory index atomically. The
        // marker write below is metadata-only and requires this folder to exist.
        await store.makeDir(safe)
      } catch (err) {
        if ((err as { isToolError?: boolean }).isToolError) {
          return reply
            .code(HTTP_STATUS.CONFLICT)
            .send({ error: 'a folder with that name already exists' })
        }
        throw err
      }
    }
    const pageFile = folderPageFilePath(safe)
    const page = (await store.list()).find((note) => note.id && note.filePath === pageFile)
    let openTransition!: (created: boolean) => void
    const transition = new Promise<boolean>((resolve) => {
      openTransition = resolve
    })
    const autoPin = page?.id
      ? enqueueConditionalNotePin(store, page.id, transition, principalId(req))
      : null
    // The authoritative reservation read may fail while the primary mark is still
    // doing marker/DB I/O. Observe it NOW so Node never sees a temporarily unhandled
    // rejection; keep the error as data for the lifecycle-specific log below.
    const autoPinOutcome = autoPin?.completion.then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    )
    let record

    try {
      record = await markFolderAsProject(
        { projects, folders, markerStore, now: () => new Date() },
        { space, folderPath: safe, displayName: body.data.displayName },
      )
    } catch (err) {
      openTransition(false)
      const pinOutcome = await autoPinOutcome

      if (pinOutcome && !pinOutcome.ok) {
        req.log.error(
          { err: pinOutcome.error, noteId: page?.id },
          '[projects] project overview auto-pin cleanup failed after mark error',
        )
      }
      throw err
    }
    openTransition(record.createdActive)
    const pinOutcome = await autoPinOutcome

    if (pinOutcome && !pinOutcome.ok) {
      req.log.error(
        { err: pinOutcome.error, noteId: page?.id },
        '[projects] project overview auto-pin failed after mark',
      )
    }

    return reply
      .code(HTTP_STATUS.CREATED)
      .send(ProjectRowSchema.parse(projectSummaryOf(record, spaces.slugOf(space) ?? '')))
  })

  // List the space's active projects. canon: docs/projects.md#lifecycle
  app.get(s('/projects'), { config: authz('space:read', 'space') }, async (req) => {
    const space = req.spaceId
    const rows = projects ? await projects.listForSpace(space) : []
    const spaceSlug = spaces.slugOf(space) ?? ''
    return ProjectsResponseSchema.parse({
      projects: rows
        .filter((r) => r.status === PROJECT_STATUS.active)
        .map((r) => projectSummaryOf(r, spaceSlug)),
    })
  })

  // Unmark a project. Anti-enumeration: an id outside this space 404s exactly
  // like an unknown one — never confirms a foreign id exists.
  app.delete(s('/projects/:id'), { config: authz('space:write', 'space') }, async (req, reply) => {
    if (!projects) {
      return notFound(reply)
    }
    const space = req.spaceId
    const id = (req.params as { id?: string }).id ?? ''
    const ok = await unmarkProject({ projects, markerStore, now: () => new Date() }, { space, id })

    if (!ok) {
      return notFound(reply)
    }

    return RemoveResponseSchema.parse({ ok: true })
  })

  // Rename a project (slug and/or displayName). canon: docs/projects.md#addressing
  // Anti-enumeration: a foreign-space id 404s like an unknown one. Root slug IS
  // the space slug → 400 (rename the space); collision → 409, never auto-suffixed.
  app.patch(s('/projects/:id'), { config: authz('space:write', 'space') }, async (req, reply) => {
    if (!projects) {
      return notFound(reply)
    }
    const body = PatchProjectRequestSchema.safeParse(req.body)

    if (!body.success) {
      return reply
        .code(HTTP_STATUS.BAD_REQUEST)
        .send({ error: body.error.issues[0]?.message || 'bad request' })
    }
    const space = req.spaceId
    const id = (req.params as { id?: string }).id ?? ''

    // P5: a host that can't store the marker for this space 404s here rather than
    // 500-ing inside writeMarkerFor.
    if (markerStore && !markerStore.available(space)) {
      return notFound(reply)
    }
    const result = await renameProjectSlug(
      { projects, markerStore, now: () => new Date() },
      { space, id, slug: body.data.slug, displayName: body.data.displayName },
    )

    if (!result.ok) {
      if (result.code === 'not_found') {
        return notFound(reply)
      }
      if (result.code === 'collision') {
        return reply
          .code(HTTP_STATUS.CONFLICT)
          .send({ error: 'a project with that slug already exists in this space' })
      }
      if (result.code === 'root') {
        return reply
          .code(HTTP_STATUS.BAD_REQUEST)
          .send({ error: "the root project's handle is the space slug — rename the space instead" })
      }

      return reply.code(HTTP_STATUS.BAD_REQUEST).send({ error: 'bad slug' })
    }

    return ProjectRowSchema.parse(projectSummaryOf(result.record, spaces.slugOf(space) ?? ''))
  })

  // About-project memory axis, for a member to audit.
  // canon: docs/projects.md#memory-two-axes
  // Archived projects stay readable (no status gate — archive is only a list
  // filter). Anti-enumeration: an unknown id or one owned by ANOTHER space → the
  // SAME 404 (the id resolves in exactly one space).
  app.get(
    s('/projects/:id/memory'),
    { config: authz('space:read', 'space') },
    async (req, reply) => {
      if (!projects) {
        return notFound(reply)
      }
      const space = req.spaceId
      const id = (req.params as { id?: string }).id ?? ''
      const rec = await projects.getById(id)

      if (!rec || rec.space !== space) {
        return notFound(reply)
      }
      // `order=eager` = the STABLE (mute-invariant) order: a mute writes a revision
      // that would otherwise bump the category to the front of the default
      // newest-first order; eager keeps it dimmed IN PLACE, not reflowed.
      const query = ProjectMemoryQuerySchema.parse(req.query)
      const order = query.order === 'eager' ? 'eager' : 'modified'
      const cats = await listMemoryCategories(await spaceStoreFor(req), rec.id, {
        order,
        sort: query.sort,
        dir: query.dir,
      })
      return ProjectMemoryResponseSchema.parse({
        categories: await withAuthors(cats, req.principal.username, auth.describeAuthor),
      })
    },
  )

  // PROJECT agent-context preview: the eager context a session working here loads
  // under one project budget. Mirrors start_session's curateAgentContext (keep in
  // sync — the human must see exactly what the agent loads).
  // canon: docs/projects.md#init-context-curation-165-a-idinit-context-curationa
  // Anti-enumeration 404 like its memory twin.
  app.get(
    s('/projects/:id/agent-context'),
    { config: authz('space:read', 'space') },
    async (req, reply) => {
      if (!projects) {
        return notFound(reply)
      }
      const space = req.spaceId
      const id = (req.params as { id?: string }).id ?? ''
      const rec = await projects.getById(id)

      if (!rec || rec.space !== space) {
        return notFound(reply)
      }
      const query = AgentContextQuerySchema.parse(req.query)
      const store = await spaceStoreFor(req)
      const resolveDeps = { store: storeAccess, spaces, contextSets, scopePins, contextOrder }
      const [projectTagPins, projectLoose, index, projectSets, projectOrder] = await Promise.all([
        weighAlwaysLoad(store, { pathPrefix: rec.path }),
        weighScopePins(resolveDeps, req.principal, { kind: CONTEXT_KIND.project, id: rec.id }),
        projectIndexSummary(store, rec.path),
        weighScopeContextSets(resolveDeps, req.principal, {
          kind: CONTEXT_KIND.project,
          id: rec.id,
        }),
        weighScopeOrder(resolveDeps, { kind: CONTEXT_KIND.project, id: rec.id }),
      ])
      const projectPins = [...projectTagPins, ...projectLoose]
      // Personal background: its store may be another space; none-mode (no personal
      // domain) embeds nothing.
      const [personalSlug, abilityPersonalSpace] = await Promise.all([
        peekPersonalSpace({ auth, spaces }, req.principal),
        abilities ? abilities.personalSpaceFor(req.principal) : Promise.resolve(null),
      ])
      const personalStore = personalSlug ? await spaces.store(personalSlug) : null
      // A personal space and its Space root are the same library, so a project living
      // in the caller's own space must not answer with both links: the Space one is
      // not a placement the effective chain ever visits.
      const roleLocations = [
        ...(abilityPersonalSpace
          ? [{ scope: ROLE_SCOPE.personal, space: abilityPersonalSpace } as const]
          : []),
        ...(rec.space === abilityPersonalSpace
          ? []
          : [{ scope: ROLE_SCOPE.space, space: rec.space } as const]),
        { scope: ROLE_SCOPE.project, space: rec.space, projectId: rec.id } as const,
      ]
      const decodedRole = query.role ? decodeAbilityLocator(query.role) : null
      const encodedRole =
        decodedRole?.source === 'owned' && decodedRole.kind === 'role' ? decodedRole : null
      const selectedRoleLocation = encodedRole
        ? roleLocations.find(
            (location) =>
              location.scope === encodedRole.location.scope &&
              location.space === encodedRole.location.spaceId &&
              (location.scope !== ROLE_SCOPE.project ||
                location.projectId ===
                  (encodedRole.location.scope === ROLE_SCOPE.project
                    ? encodedRole.location.projectId
                    : undefined)),
          )
        : undefined
      const selectedRoleLocator = selectedRoleLocation ? encodedRole : null
      const [personalTagPins, personalLoose, personalMemory, personalSets, personalOrder] =
        personalStore
          ? await Promise.all([
              weighAlwaysLoad(personalStore),
              weighScopePins(resolveDeps, req.principal, {
                kind: CONTEXT_KIND.personal,
                id: personalSlug as string,
              }),
              listMemoryCategories(personalStore, '', { order: 'eager' }),
              weighScopeContextSets(resolveDeps, req.principal, {
                kind: CONTEXT_KIND.personal,
                id: personalSlug as string,
              }),
              weighScopeOrder(resolveDeps, {
                kind: CONTEXT_KIND.personal,
                id: personalSlug as string,
              }),
            ])
          : [[], [], [], [], []]
      const [roleListing, selectedRole] = await Promise.all([
        roles
          ? Promise.all(
              roleLocations.map((location) =>
                roles.listOwnedAbilitiesAt(location, req.principal, ABILITY_KIND.role),
              ),
            ).then((listings) => ({
              abilities: listings.flatMap((listing) => listing.abilities),
              truncated: listings.some((listing) => listing.truncated),
            }))
          : Promise.resolve({ abilities: [], truncated: false }),
        selectedRoleLocation && selectedRoleLocator && roles
          ? roles.addressedRoleStatus(
              { personalSpace: abilityPersonalSpace, project: rec },
              req.principal,
              selectedRoleLocator,
            )
          : Promise.resolve(null),
      ])
      // Weighed ONLY when the agent would load it here — see the personal door.
      const roleContext = selectedRole?.active
        ? await weighRoleContext(resolveDeps, req.principal, selectedRole.role)
        : undefined
      const curated = await curateProjectScope(
        projectPins,
        projectSets,
        [...personalTagPins, ...personalLoose],
        personalSets,
        personalMemory,
        PROJECT_TOKEN_BUDGET,
        projectOrder,
        personalOrder,
        roleContext,
      )
      const roleView =
        selectedRole?.active && selectedRoleLocator
          ? roleContextViewOf(
              selectedRole,
              selectedRoleLocator,
              (roleSpace) => spaces.slugOf(roleSpace) ?? roleSpace,
              projectSummaryOf(rec, spaces.slugOf(rec.space) ?? rec.space).handle,
              curated.role
                ? { ...curated.role, sets: curated.role.sets.map(contextSetViewOf) }
                : undefined,
            )
          : undefined
      return ProjectAgentContextResponseSchema.parse({
        // A role this project cannot activate has no business being offered here: the
        // picker must list what effective resolution would answer with, not every
        // package that happens to sit in a readable location. A Space base narrowed
        // away from this project resolves to nothing in it — and this call is the ONLY
        // thing that says so on this door, so it is the only thing that can be wrong.
        roles: roleListing.abilities.flatMap(({ ability }) => {
          const role = contextRoleSummaryOf(ability, rec.id)
          return role ? [role] : []
        }),
        ...(roleListing.truncated ? { rolesTruncated: true } : {}),
        ...(roleView ? { role: roleView } : {}),
        pins: curated.pins,
        sets: curated.sets.map(contextSetViewOf),
        projectLoadedTokens: curated.projectLoadedTokens,
        personal: {
          pins: curated.personal.pins,
          sets: curated.personal.sets.map(contextSetViewOf),
          memory: await withAuthors(
            curated.personal.memory,
            req.principal.username,
            auth.describeAuthor,
          ),
          loadedTokens: curated.personal.loadedTokens,
        },
        loadedTokens: curated.loadedTokens,
        budgetTokens: PROJECT_TOKEN_BUDGET,
        index,
      })
    },
  )
}
