import type { FastifyInstance, FastifyRequest } from 'fastify'

import {
  FAVORITE_ENTITY_KIND,
  FavoriteEntityKindSchema,
  FavoriteMutationResponseSchema,
  FavoritePutRequestSchema,
  FavoritesResponseSchema,
  PROJECT_STATUS,
} from '@notarium/contract'
import { HTTP_STATUS } from '@notarium/contract/http'
import { treeSummary } from '@notarium/core'

import { safeRelAddress } from '../../../../libs/relPath'
import { can } from '../../../../services/authz'
import { ensureFolderIdentity, projectSummaryOf } from '../../../../services/projects'
import type { SpaceStore } from '../../../../services/spaces'
import { type ApiRouteCtx, authz, notFound, s, treeDirsFor } from '../_shared'
import { noteToWire } from '../wire'

/** Follow a phase-one provisional id through the read-model, then enforce the
 *  user-list visibility gate on its authoritative successor. Read-before-list is
 *  load-bearing: the sweep may have removed P from list while retaining P→D. */
export const canonicalVisibleFavoriteNoteId = async (
  store: Pick<SpaceStore, 'list' | 'read'>,
  requestedId: string,
): Promise<string | null> => {
  const live = await store.read(requestedId).catch(() => null)

  if (!live || live.deleted) {
    return null
  }
  const canonicalId = live.id ?? requestedId
  return (await store.list()).some((note) => note.id === canonicalId) ? canonicalId : null
}

export const favoritesRoutes = async (app: FastifyInstance, ctx: ApiRouteCtx) => {
  const { favorites, favoriteOwner, spaceStoreFor, projects, folders, spaces, markerStore } = ctx
  const { folderIdentitiesFor } = ctx

  const favoriteItemsFor = async (
    req: FastifyRequest,
    records: Awaited<ReturnType<NonNullable<typeof favorites>['list']>>,
  ) => {
    const store = await spaceStoreFor(req)
    const space = req.spaceId
    const notes = await store.list()
    const notesById = new Map(notes.filter((n) => n.id).map((n) => [n.id as string, n]))
    const projectRows = projects ? await projects.listForSpace(space) : []
    const projectsById = new Map(
      projectRows.filter((p) => p.status === PROJECT_STATUS.active).map((p) => [p.id, p]),
    )
    const folderRows = folders ? await folders.listForSpace(space) : []
    const foldersById = new Map(folderRows.map((f) => [f.id, f]))
    const tree = treeSummary(
      notes,
      await treeDirsFor(store, projectRows),
      Date.now(),
      await folderIdentitiesFor(space, projectRows),
    )
    const treeByPath = new Map(tree.folders.map((f) => [f.path, f]))
    const spaceSlug = spaces.slugOf(space) ?? ''
    const items: unknown[] = []

    for (const fav of records) {
      if (fav.kind === FAVORITE_ENTITY_KIND.note) {
        const note = notesById.get(fav.entityId)

        if (note) {
          items.push({
            kind: FAVORITE_ENTITY_KIND.note,
            id: fav.entityId,
            favoritedAt: fav.createdAt,
            note: noteToWire(note),
          })
        }
        continue
      }
      if (fav.kind === FAVORITE_ENTITY_KIND.project) {
        const project = projectsById.get(fav.entityId)

        if (project) {
          items.push({
            kind: FAVORITE_ENTITY_KIND.project,
            id: fav.entityId,
            favoritedAt: fav.createdAt,
            project: projectSummaryOf(project, spaceSlug),
          })
        }
        continue
      }
      const folder = foldersById.get(fav.entityId)
      const treeFolder = folder ? treeByPath.get(folder.path) : undefined

      if (folder && treeFolder) {
        items.push({
          kind: FAVORITE_ENTITY_KIND.folder,
          id: fav.entityId,
          favoritedAt: fav.createdAt,
          folder: { ...treeFolder, id: fav.entityId },
        })
        continue
      }
      // Folder favorited then marked as a project: they share one identity row, so the
      // id stops resolving as a folder — surface it as a project so it stays visible.
      // canon: docs/projects.md#project-identity-the-marker-file-pattern-51-lifted-notefolder
      const promoted = projectsById.get(fav.entityId)

      if (promoted) {
        items.push({
          kind: FAVORITE_ENTITY_KIND.project,
          id: fav.entityId,
          favoritedAt: fav.createdAt,
          project: projectSummaryOf(promoted, spaceSlug),
        })
      }
    }
    // Dedup by entity id: a folder→project flip can leave both a 'folder' and a
    // 'project' row for the same id, both resolving to one item — keep the first.
    const seen = new Set<string>()
    return items.filter((it) => {
      const id = (it as { id: string }).id

      if (seen.has(id)) {
        return false
      }
      seen.add(id)
      return true
    })
  }

  app.get(s('/favorites'), { config: authz('space:read', 'space') }, async (req) => {
    if (!favorites) {
      return FavoritesResponseSchema.parse({ items: [], total: 0 })
    }
    const records = await favorites.list(favoriteOwner(req), req.spaceId)
    const items = await favoriteItemsFor(req, records)
    return FavoritesResponseSchema.parse({ items, total: items.length })
  })

  app.put(s('/favorites'), { config: authz('space:read', 'space') }, async (req, reply) => {
    if (!favorites) {
      return notFound(reply, 'favorites unavailable')
    }
    const body = FavoritePutRequestSchema.safeParse(req.body)

    if (!body.success) {
      return reply
        .code(HTTP_STATUS.BAD_REQUEST)
        .send({ error: body.error.issues[0]?.message || 'bad request' })
    }
    const store = await spaceStoreFor(req)
    const space = req.spaceId
    let entityId = body.data.id ?? ''
    let kind = body.data.kind

    if (kind === FAVORITE_ENTITY_KIND.note) {
      // Read first: a phase-one UI may submit provisional P just after the sweep
      // re-keyed the live inventory to D. CachedStore follows P→D; list no longer
      // contains P, so validating the raw id against list first would transiently 404.
      const canonicalId = await canonicalVisibleFavoriteNoteId(store, entityId)

      if (!canonicalId) {
        return notFound(reply)
      }
      entityId = canonicalId
    } else if (kind === FAVORITE_ENTITY_KIND.project) {
      if (!projects) {
        return notFound(reply)
      }
      const project = entityId ? await projects.getById(entityId) : null

      if (!project || project.space !== space || project.status !== PROJECT_STATUS.active) {
        return notFound(reply)
      }
    } else {
      if (!folders || !projects) {
        return notFound(reply)
      }
      const safe = body.data.path != null ? safeRelAddress(body.data.path) : undefined

      if (safe === null || (!entityId && !safe)) {
        return reply.code(HTTP_STATUS.BAD_REQUEST).send({ error: 'bad folder path' })
      }
      const row = entityId ? await folders.getById(entityId) : null

      if (entityId && !row && !safe) {
        return notFound(reply)
      }
      if (row && row.space !== space && !safe) {
        return notFound(reply)
      }
      if (row && row.space === space) {
        entityId = row.id
      } else {
        const path = safe ?? ''

        if (!path) {
          return reply.code(HTTP_STATUS.BAD_REQUEST).send({ error: 'bad folder path' })
        }
        const exists = (await treeDirsFor(store, await projects.listForSpace(space))).includes(path)

        if (!exists) {
          return notFound(reply)
        }
        // Minting a NEW folder identity writes SHARED state (.notariummeta marker + folders
        // row visible via /tree), so it needs space:write — a reader may favorite existing
        // entities but must not mint shared identity as a side effect (P14).
        if (!can(req.principal, 'space:write', { space })) {
          return reply
            .code(HTTP_STATUS.FORBIDDEN)
            .send({ error: 'favoriting a new folder requires write access' })
        }
        entityId = await ensureFolderIdentity(
          { projects, folders, markerStore, now: () => new Date() },
          { space, folderPath: path },
        )
      }
      kind = FAVORITE_ENTITY_KIND.folder
    }
    const record = {
      owner: favoriteOwner(req),
      space,
      kind,
      entityId,
      createdAt: new Date().toISOString(),
      rank: null,
    }
    // `add` canonicalizes the id and clears the entity's prior rows of other kinds
    // inside its own transaction — a settlement may have committed since the
    // pre-resolve above, and only the transaction knows which id the clear must
    // target. Echo what was STORED, or the client starts its next request from an
    // id the row no longer carries (#327).
    const stored = await favorites.add(record)
    const [item] = await favoriteItemsFor(req, [stored])
    return FavoriteMutationResponseSchema.parse({ ok: true, ...(item ? { item } : {}) })
  })

  app.delete(
    s('/favorites/:kind/:id'),
    { config: authz('space:read', 'space') },
    async (req, reply) => {
      if (!favorites) {
        return notFound(reply, 'favorites unavailable')
      }
      const params = req.params as { kind?: string; id?: string }
      const kind = FavoriteEntityKindSchema.safeParse(params.kind)

      if (!kind.success || !params.id) {
        return reply.code(HTTP_STATUS.BAD_REQUEST).send({ error: 'bad favorite target' })
      }
      let entityId = params.id

      if (kind.data === FAVORITE_ENTITY_KIND.note) {
        const store = await spaceStoreFor(req)
        const live = await store.read(entityId).catch(() => null)

        if (live && !live.deleted) {
          entityId = live.id ?? entityId
        }
      }
      // Remove by ENTITY id (kind-agnostic): a favorited folder later marked as a project is
      // stored kind='folder' but deleted as 'project' — its id is stable across the flip.
      await favorites.removeByEntity(favoriteOwner(req), req.spaceId, entityId)
      return FavoriteMutationResponseSchema.parse({ ok: true })
    },
  )
}
