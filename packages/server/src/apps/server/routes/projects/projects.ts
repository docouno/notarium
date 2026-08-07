import type { FastifyInstance } from 'fastify'

import {
  CONTEXT_KIND,
  MarkProjectRequestSchema,
  PatchProjectRequestSchema,
  PROJECT_STATUS,
  ProjectAgentContextResponseSchema,
  ProjectMemoryResponseSchema,
  ProjectRowSchema,
  ProjectsResponseSchema,
  RemoveResponseSchema,
} from '@notarium/contract'
import { HTTP_STATUS } from '@notarium/contract/http'

import { withAuthors } from '../../../../libs/authors'
import { safeRelAddress, safeRelPath } from '../../../../libs/relPath'
import {
  markFolderAsProject,
  projectSummaryOf,
  renameProjectSlug,
  unmarkProject,
} from '../../../../services/projects'
import {
  curateProjectScope,
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

export const projectsRoutes = async (app: FastifyInstance, ctx: ApiRouteCtx) => {
  const { projects, markerStore, folders, spaces, spaceStoreFor } = ctx
  const { storeAccess, contextSets, scopePins, contextOrder, auth } = ctx

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

      // `create` mkdir's the folder (must NOT exist yet); a plain mark addresses
      // an EXISTING folder (must exist).
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
    const record = await markFolderAsProject(
      { projects, folders, markerStore, now: () => new Date() },
      { space, folderPath: safe, displayName: body.data.displayName },
    )
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
      const order = (req.query as { order?: string }).order === 'eager' ? 'eager' : 'modified'
      const cats = await listMemoryCategories(await spaceStoreFor(req), rec.id, { order })
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
      const personalSlug = await peekPersonalSpace({ auth, spaces }, req.principal)
      const personalStore = personalSlug ? await spaces.store(personalSlug) : null
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
      const curated = curateProjectScope(
        projectPins,
        projectSets,
        [...personalTagPins, ...personalLoose],
        personalSets,
        personalMemory,
        PROJECT_TOKEN_BUDGET,
        projectOrder,
        personalOrder,
      )
      return ProjectAgentContextResponseSchema.parse({
        pins: curated.pins,
        sets: curated.sets,
        projectLoadedTokens: curated.projectLoadedTokens,
        personal: {
          pins: curated.personal.pins,
          sets: curated.personal.sets,
          memory: await withAuthors(
            curated.personal.memory,
            req.principal.username,
            auth.describeAuthor,
          ),
          loadedTokens: curated.personal.loadedTokens,
        },
        loadedTokens: curated.loadedTokens,
        totalTokens: curated.totalTokens,
        budgetTokens: PROJECT_TOKEN_BUDGET,
        index,
      })
    },
  )
}
