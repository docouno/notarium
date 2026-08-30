import type { FastifyInstance } from 'fastify'

import {
  CreateFolderPageRequestSchema,
  CreateFolderPageResponseSchema,
  CreateFolderRequestSchema,
  MoveFolderRequestSchema,
  MoveResponseSchema,
  NOTE_CLASS,
  OkResponseSchema,
  PROJECT_STATUS,
  RemoveResponseSchema,
} from '@notarium/contract'
import { HTTP_STATUS } from '@notarium/contract/http'
import {
  deriveNoteTitle,
  FOLDER_PAGE_BASENAME,
  folderPageFilePath,
  isPathUnder,
  type KnowledgeStore,
  normTags,
  STORE_ERROR_REASON,
  StoreError,
} from '@notarium/core'

import { safeRelAddress, safeRelPath } from '../../../../libs/relPath'
import { prepareFieldWrite } from '../../../../services/fields'
import {
  acquireMarkPrefixLock,
  ensureFolderIdentity,
  finalizeFolderMove,
  lastSegment,
} from '../../../../services/projects'
import { ALWAYS_LOAD_TAG, setNotePinned } from '../../../../services/spaces'
import { type ApiRouteCtx, authz, missing, notFound, s } from '../_shared'
import { moveFolderToDomain } from '../wire'

const folderExistsIn = async (store: KnowledgeStore, path: string): Promise<boolean> => {
  if (path === '') {
    return true
  }
  const [notes, dirs] = await Promise.all([
    store.list(),
    store.listDirs ? store.listDirs() : Promise.resolve<string[]>([]),
  ])

  return dirs.includes(path) || notes.some((note) => isPathUnder(note.filePath, path))
}

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

        if (!registered && !(await folderExistsIn(store, path))) {
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
    if (await folderExistsIn(store, path)) {
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
          if (await folderExistsIn(store, path)) {
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
  // Minting a page is the ONE identity trigger besides move — a marker lands only where a page
  // exists, never on a plain browse. The page is an ordinary note; only its reserved basename
  // hides it from the folder's children.
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
    // Folder must exist (note-backed or explicit empty dir); root ('') always does. No minting a ghost.
    const folderExists = await folderExistsIn(store, folderPath)

    if (!folderExists) {
      return notFound(reply)
    }
    const pageFile = folderPageFilePath(folderPath)
    const notes = await store.list()
    const already = notes.find((n) => n.filePath === pageFile)

    if (already) {
      return reply.code(HTTP_STATUS.CONFLICT).send({ error: 'this folder already has a page' })
    }
    const name = lastSegment(folderPath) || spaces.slugOf(space) || 'index'
    // Body-first title guard (same as note create): a REST caller must not mint a folder marker +
    // empty `index.md`. Old `{ folderPath }`-only callers still get the default `# <folder>`.
    const hasAuthoredTitleInput = body.data.content !== undefined || body.data.title !== undefined

    if (hasAuthoredTitleInput && !deriveNoteTitle(body.data.content ?? '', body.data.title)) {
      return missing(reply, 'title')
    }
    // The create's own refusal is the race backstop behind the existence pre-check above.
    // `targetClass:'user-doc'` is hard-wired: a page is shared knowledge, never memory.
    // canon: docs/note-model.md#note-classes
    const title = body.data.title ?? (body.data.content === undefined ? name : '')
    const content = body.data.content ?? `# ${body.data.title ?? name}\n`
    const activeAtSnapshot = (await projects.listForSpace(space)).some(
      (project) => project.path === folderPath && project.status === PROJECT_STATUS.active,
    )
    const authoredTags = normTags(body.data.tags) ?? []
    const tags = activeAtSnapshot
      ? [
          ...authoredTags.filter((tag, index) =>
            tag === ALWAYS_LOAD_TAG ? authoredTags.indexOf(tag) === index : true,
          ),
          ...(authoredTags.includes(ALWAYS_LOAD_TAG) ? [] : [ALWAYS_LOAD_TAG]),
        ]
      : body.data.tags
    const hasFields = Object.getOwnPropertyNames(body.data.fields ?? {}).length > 0
    const fieldsUnquoted = hasFields
      ? await prepareFieldWrite(fieldSchemaStore, space, body.data.fields!)
      : undefined
    let folderId = ''
    let r
    const folderMissing = new Error('folder disappeared before page creation')

    try {
      r = await store.write(
        {
          title,
          content,
          directory: folderPath || undefined,
          noteType: body.data.noteType,
          tags,
          fields: body.data.fields,
          ...(fieldsUnquoted ? { fieldsUnquoted } : {}),
          slug: body.data.slug,
          createdAt: body.data.createdAt ? new Date(body.data.createdAt).toISOString() : undefined,
          fileName: FOLDER_PAGE_BASENAME,
          targetClass: NOTE_CLASS.userDoc,
          principal: principalId(req),
        },
        {
          // Identity/marker creation is part of the page's path mutation: a
          // concurrent folder delete/move cannot clean a freshly-created row
          // after this request has established it. Keep it before the file
          // write so a registry failure cannot leave a successfully-written
          // page behind a failed response (the route's prior semantics).
          prepare: async () => {
            if (!(await folderExistsIn(store, folderPath))) {
              throw folderMissing
            }
            folderId = await ensureFolderIdentity(
              { projects, folders, markerStore, now: () => new Date() },
              { space, folderPath },
            )
          },
        },
      )
    } catch (err) {
      if (err === folderMissing) {
        return notFound(reply)
      }
      // Race backstop: two concurrent creates both snapshot an empty folder; the loser's write throws
      // note_already_exists — surface the SAME 409 as the pre-check, not the mapper's generic 400.
      if ((err as { reason?: string }).reason === STORE_ERROR_REASON.noteAlreadyExists) {
        return reply.code(HTTP_STATUS.CONFLICT).send({ error: 'this folder already has a page' })
      }
      throw err
    }

    if (!activeAtSnapshot && r.id) {
      const activeAfterCreate = (await projects.listForSpace(space)).some(
        (project) => project.path === folderPath && project.status === PROJECT_STATUS.active,
      )

      if (activeAfterCreate) {
        await setNotePinned(store, r.id, true, principalId(req)).catch((err) =>
          req.log.error(
            { err, noteId: r.id },
            '[folders] project overview auto-pin failed after page create',
          ),
        )
      }
    }

    return reply.code(HTTP_STATUS.CREATED).send(
      CreateFolderPageResponseSchema.parse({
        folderId,
        pageNoteId: r.id ?? '',
        path: folderPath,
      }),
    )
  })
}
