import type { FastifyInstance } from 'fastify'

import {
  CreateFolderPageRequestSchema,
  CreateFolderPageResponseSchema,
  CreateFolderRequestSchema,
  MoveFolderRequestSchema,
  MoveResponseSchema,
  OkResponseSchema,
  RemoveResponseSchema,
} from '@notarium/contract'
import { HTTP_STATUS } from '@notarium/contract/http'
import { deriveNoteTitle, StoreError } from '@notarium/core'

import { safeRelAddress, safeRelPath } from '../../../../libs/relPath'
import { prepareFieldWrite } from '../../../../services/fields'
import {
  acquireMarkPrefixLock,
  ensureFolderIdentity,
  finalizeFolderMove,
  folderExists,
  folderPageNoteOf,
  lastSegment,
  materializeFolderPage,
} from '../../../../services/projects'
import { type ApiRouteCtx, authz, missing, notFound, s } from '../_shared'
import { moveFolderToDomain } from '../wire'

export const foldersRoutes = async (app: FastifyInstance, ctx: ApiRouteCtx) => {
  const { spaceStoreFor, projects, folders, markerStore, spaces, principalId, fieldSchemaStore } =
    ctx

  // Folder move/rename; a marked folder's `.notariummeta` sibling rides the fs.rename, so
  // identity travels with the dir for free.
  // canon: docs/projects.md#project-identity-the-marker-file-pattern-51-lifted-notefolder
  app.post(s('/move-folder'), { config: authz('space:write', 'space') }, async (req, reply) => {
    const body = MoveFolderRequestSchema.safeParse(req.body)

    if (!body.success) {
      return reply
        .code(HTTP_STATUS.BAD_REQUEST)
        .send({ error: body.error.issues[0]?.message || 'bad request' })
    }
    const path = safeRelAddress(body.data.path)
    const destination = safeRelAddress(body.data.destinationPath)

    if (path === null || !path || destination === null) {
      return reply.code(HTTP_STATUS.BAD_REQUEST).send({ error: 'bad folder path' })
    }
    const store = await spaceStoreFor(req)
    const history = {
      prepare: async () => {
        const registered = projects
          ? (await projects.listForSpace(req.spaceId)).some((project) => project.path === path)
          : false

        if (!registered && !(await folderExists(store, path))) {
          const err = new StoreError('# Move Failed: folder not found')
          err.isToolError = true
          throw err
        }
        if (projects && folders) {
          await ensureFolderIdentity(
            { projects, folders, markerStore, now: () => new Date() },
            { space: req.spaceId, folderPath: path },
          )
        }
      },
      ...(projects && folders
        ? {
            finalize: () =>
              finalizeFolderMove(
                {
                  projects,
                  folders,
                  markerStore,
                  now: () => new Date(),
                  onError: (stage, err) =>
                    req.log.error({ err }, `[folders] move finalize ${stage} failed`),
                },
                { space: req.spaceId, oldPath: path, newPath: destination },
              ),
          }
        : {}),
    }
    await store.move(moveFolderToDomain(path, destination), history)

    return MoveResponseSchema.parse({ ok: true })
  })

  // Create a plain (unmarked) folder — a durable on-disk dir, never auto-pruned. Name clash 409s.
  app.post(s('/folders'), { config: authz('space:write', 'space') }, async (req, reply) => {
    const body = CreateFolderRequestSchema.safeParse(req.body)

    if (!body.success) {
      return reply
        .code(HTTP_STATUS.BAD_REQUEST)
        .send({ error: body.error.issues[0]?.message || 'bad request' })
    }
    const path = safeRelPath(body.data.path)

    if (path === null || !path) {
      return reply.code(HTTP_STATUS.BAD_REQUEST).send({ error: 'bad folder path' })
    }
    const store = await spaceStoreFor(req)

    if (!store.makeDir || !store.listDirs) {
      return notFound(reply)
    }
    if (await folderExists(store, path)) {
      return reply
        .code(HTTP_STATUS.CONFLICT)
        .send({ error: 'a folder with that name already exists' })
    }
    const collision = new Error('folder create lost an existence race')

    try {
      await store.makeDir(path, {
        // The fast check above keeps the common 409 cheap; this one is the
        // linearization check after waiting behind a move/create of the path.
        prepare: async () => {
          if (await folderExists(store, path)) {
            throw collision
          }
        },
      })
    } catch (err) {
      if (err === collision || (err as { isToolError?: boolean }).isToolError) {
        return reply
          .code(HTTP_STATUS.CONFLICT)
          .send({ error: 'a folder with that name already exists' })
      }
      throw err
    }

    return OkResponseSchema.parse({ ok: true })
  })

  // Delete a whole folder subtree (fenced note tombstones + dirs, then derived registries).
  // Idempotent: a missing folder deletes nothing and still answers ok.
  app.delete(s('/folders'), { config: authz('space:write', 'space') }, async (req, reply) => {
    const path = safeRelAddress((req.query as { path?: string }).path ?? '')

    if (path === null || !path) {
      return reply.code(HTTP_STATUS.BAD_REQUEST).send({ error: 'bad folder path' })
    }
    const store = await spaceStoreFor(req)
    const space = req.spaceId

    if (!store.removeDir) {
      return notFound(reply)
    }

    let releaseProjectLifecycle: (() => Promise<void>) | undefined

    try {
      await store.removeDir(path, {
        principal: principalId(req),
        prepare: async () => {
          // Core owns the physical prefix fence. Reserve the matching project/folder
          // lifecycle prefix only after entering it, preserving the established
          // core → host ordering used by page-create and folder-move prepares.
          if (projects || folders) {
            releaseProjectLifecycle = await acquireMarkPrefixLock(`${space}\0${path}`)
          }
        },
        finalize: async () => {
          // Clean only while the core still owns the folder prefix. Otherwise a
          // concurrent B→path move/page-create could land fresh rows that this old
          // delete would mistake for its victims. The host lifecycle prefix is held
          // too, so a mark that published its marker before this delete must publish
          // its row before this snapshot; no active registry ghost can land after it.
          if (projects) {
            await (async () => {
              const under = (await projects.listForSpace(space)).filter(
                (r) => r.path === path || r.path.startsWith(`${path}/`),
              )

              for (const r of under) {
                // The physical subtree (including its markers) is already gone and
                // this callback owns the encompassing lifecycle prefix. Re-entering
                // the exact mark lock through unmarkProject would self-deadlock.
                if (markerStore) {
                  await markerStore
                    .remove(space, r.path)
                    .catch((err) =>
                      req.log.error({ err }, '[folders] remove marker under deleted folder failed'),
                    )
                }
                await projects
                  .delete(r.id)
                  .catch((err) =>
                    req.log.error({ err }, '[folders] unmark under deleted folder failed'),
                  )
              }
            })().catch((err) =>
              req.log.error({ err }, '[folders] project cleanup under deleted folder failed'),
            )
          }
          if (folders) {
            await (async () => {
              const under = (await folders.listForSpace(space)).filter(
                (r) => r.path === path || r.path.startsWith(`${path}/`),
              )

              for (const r of under) {
                await folders
                  .delete(r.id)
                  .catch((err) =>
                    req.log.error({ err }, '[folders] delete under deleted folder failed'),
                  )
              }
            })().catch((err) =>
              req.log.error({ err }, '[folders] identity cleanup under deleted folder failed'),
            )
          }
        },
      })
    } finally {
      await releaseProjectLifecycle?.()
    }

    return RemoveResponseSchema.parse({ ok: true })
  })

  // Create a folder's PAGE: mint the folder's lazy identity then write its `index.md` body note.
  // Minting is lazy, never on a plain browse — but this is not its only trigger, and a marker is
  // not evidence of a page: a move, a favorite and a project mark each mint one too, and they share
  // the same file (canon: docs/folder-page.md#model). The page is an ordinary note; only its
  // reserved basename hides it from the folder's children.
  app.post(s('/folders/page'), { config: authz('space:write', 'space') }, async (req, reply) => {
    const body = CreateFolderPageRequestSchema.safeParse(req.body)

    if (!body.success) {
      return reply
        .code(HTTP_STATUS.BAD_REQUEST)
        .send({ error: body.error.issues[0]?.message || 'bad request' })
    }
    // No registry (meta-DB-less none-mode host) → no folder identity, no pages (honest degradation, P5).
    if (!projects || !folders) {
      return notFound(reply)
    }
    // '' = the space root (a legal folder); otherwise a normalised relative path.
    const folderPath = body.data.folderPath === '' ? '' : safeRelAddress(body.data.folderPath)

    if (folderPath === null) {
      return reply.code(HTTP_STATUS.BAD_REQUEST).send({ error: 'bad folder path' })
    }
    const store = await spaceStoreFor(req)
    const space = req.spaceId

    // State refusals stay AHEAD of the request-shape guard, as they always have:
    // the shared operation re-checks both authoritatively (that is the race
    // backstop), but the answer a caller gets for a missing folder or an existing
    // page must not change because the write moved behind one interface.
    if (!(await folderExists(store, folderPath))) {
      return notFound(reply)
    }
    if (await folderPageNoteOf(store, folderPath)) {
      return reply.code(HTTP_STATUS.CONFLICT).send({ error: 'this folder already has a page' })
    }
    const name = lastSegment(folderPath) || spaces.slugOf(space) || 'index'
    // Body-first title guard (same as note create): a REST caller must not mint a folder marker +
    // empty `index.md`. Old `{ folderPath }`-only callers still get the default `# <folder>`.
    const hasAuthoredTitleInput = body.data.content !== undefined || body.data.title !== undefined

    if (hasAuthoredTitleInput && !deriveNoteTitle(body.data.content ?? '', body.data.title)) {
      return missing(reply, 'title')
    }
    const hasFields = Object.getOwnPropertyNames(body.data.fields ?? {}).length > 0
    const fieldsUnquoted = hasFields
      ? await prepareFieldWrite(fieldSchemaStore, space, body.data.fields!)
      : undefined
    // The page lifecycle itself — folder existence, identity minting, collision and
    // the active-project auto-pin — is shared with the agent's semantic create.
    const materialized = await materializeFolderPage(
      {
        store,
        projects,
        folders,
        markerStore,
        now: () => new Date(),
        attribution: { principal: principalId(req) },
        onPostPrimaryError: (err) =>
          req.log.error({ err }, '[folders] folder page auto-pin failed after page create'),
      },
      {
        space,
        folderPath,
        note: {
          title: body.data.title ?? (body.data.content === undefined ? name : ''),
          content: body.data.content ?? `# ${body.data.title ?? name}\n`,
          noteType: body.data.noteType,
          tags: body.data.tags,
          fields: body.data.fields,
          ...(fieldsUnquoted ? { fieldsUnquoted } : {}),
          slug: body.data.slug,
          createdAt: body.data.createdAt ? new Date(body.data.createdAt).toISOString() : undefined,
        },
      },
    )

    if (!materialized.ok) {
      return materialized.reason === 'no-such-folder'
        ? notFound(reply)
        : reply.code(HTTP_STATUS.CONFLICT).send({ error: 'this folder already has a page' })
    }

    return reply.code(HTTP_STATUS.CREATED).send(
      CreateFolderPageResponseSchema.parse({
        folderId: materialized.folderId,
        pageNoteId: materialized.noteId,
        path: folderPath,
      }),
    )
  })
}
