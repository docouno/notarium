// Cross-resource helpers + the shared per-request context threaded through every
// /api/* route family.
import type { FastifyReply, FastifyRequest } from 'fastify'

import { PROJECT_STATUS } from '@notarium/contract'
import { HTTP_STATUS } from '@notarium/contract/http'

import { type Action, type AuthzConfig } from '../../../../services/authz'
import type { ProjectRecord } from '../../../../services/metaDb'
import type { SpaceStore } from '../../../../services/spaces'
import { createStoreAccess, type StoreAccess } from '../../../../services/storeAccess'
import type { ApiRoutesOptions } from '../types'

export const missing = (reply: FastifyReply, what: string) =>
  reply.code(HTTP_STATUS.BAD_REQUEST).send({ error: `missing ${what}` })

export const notFound = (reply: FastifyReply, what = 'not found') =>
  reply.code(HTTP_STATUS.NOT_FOUND).send({ error: what })

/** Containing folder of a storage filePath ('' = the space root). */
export const folderOf = (fp: string) => {
  const i = fp.lastIndexOf('/')
  return i < 0 ? '' : fp.slice(0, i)
}

/** Parse a single-range HTTP `Range` header. `null` = serve the whole file (200):
 *  no range, an unknown unit / multi-range set (RFC 7233 §3.1: ignore a Range you
 *  don't understand → 200, not 416), or an If-Range mismatch (validator changed, so a
 *  resumed slice would be corrupt). `'invalid'` = well-formed but UNSATISFIABLE bytes
 *  range → 416. Single range only. */
export const parseRangeHeader = (
  range: string | undefined,
  size: number,
  ifRange: string | undefined,
  etag: string,
): { start: number; end: number } | null | 'invalid' => {
  if (!range) {
    return null
  }
  if (ifRange && ifRange !== etag) {
    return null
  }
  const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim())

  if (!m) {
    return null
  }
  const [, startRaw, endRaw] = m
  let start: number
  let end: number

  if (startRaw === '') {
    // Suffix range: the last N bytes (`bytes=-500`).
    if (endRaw === '') {
      return 'invalid'
    }
    const n = Number(endRaw)

    if (n <= 0) {
      return 'invalid'
    }
    start = Math.max(0, size - n)
    end = size - 1
  } else {
    start = Number(startRaw)
    end = endRaw === '' ? size - 1 : Number(endRaw)
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return 'invalid'
  }
  if (start > end || start >= size) {
    return 'invalid'
  }
  if (end >= size) {
    end = size - 1
  }

  return { start, end }
}

export const authz = (
  action: Action,
  resource: 'space' | 'space-replay' | 'note' | 'note-replay' | 'host',
): { authz: AuthzConfig } => ({
  authz: { action, resource },
})

export const s = (path: string) => `/api/s/:space${path}`

/** One per-id failure in a batch response. */
export const batchFailure = (id: string, err: unknown, fallback = 'request failed') => {
  const e = err as { message?: unknown; reason?: string }
  return {
    id,
    error: typeof e.message === 'string' && e.message.trim() ? e.message : fallback,
    ...(typeof e.reason === 'string' ? { reason: e.reason } : {}),
  }
}

// Union of the engine's on-disk dirs with the active-project registry: the registry
// surfaces an empty marked project the engine won't list as a dir (redundant, but
// harmless, once the on-disk marker keeps the dir).
// canon: docs/drag-and-drop.md#2-the-tree-shows-folders-and-files-obsidian-style
export const treeDirsFor = async (
  store: SpaceStore,
  projectRows: readonly ProjectRecord[],
): Promise<string[]> => {
  const fromEngine = (await store.listDirs?.()) ?? []
  const fromRegistry = projectRows
    .filter((r) => r.status === PROJECT_STATUS.active && r.path)
    .map((r) => r.path)
  return [...new Set([...fromEngine, ...fromRegistry])]
}

/** Per-request shared context every route family closes over: `ApiRoutesOptions`
 *  plus shared closures, built once by `buildApiRouteCtx`. */
export type ApiRouteCtx = ApiRoutesOptions & {
  storeAccess: StoreAccess
  spaceStore: StoreAccess['spaceStore']
  noteStore: StoreAccess['noteStore']
  spaceStoreFor: (req: FastifyRequest) => Promise<SpaceStore>
  principalId: (req: FastifyRequest) => string
  favoriteOwner: (req: FastifyRequest) => string
  folderIdentitiesFor: (
    space: string,
    projectRows: readonly ProjectRecord[],
  ) => Promise<Array<{ id: string; path: string; pathAliases: string[] }>>
}

/** Build the shared context once for all route families. */
export const buildApiRouteCtx = (opts: ApiRoutesOptions): ApiRouteCtx => {
  const { spaces, folders } = opts

  // slug→store and id→(store, space, can()) resolve in ONE place so REST and the
  // MCP gateway enforce note-resource authz on the same path.
  const storeAccess = createStoreAccess(spaces)
  const { spaceStore, noteStore } = storeAccess

  /** Space id → live store. The authz preHandler already mapped slug→`req.spaceId`
   *  (404 on unknown); this is the lookup, not the access check. */
  const spaceStoreFor = (req: FastifyRequest) => spaceStore(req.spaceId)

  // Journal attribution string: 'user:<name>' (session), 'pat:<name>:<id>' (bearer),
  // 'ui' in AUTH_MODE=none.
  const principalId = (req: FastifyRequest) => req.principal.id
  const favoriteOwner = (req: FastifyRequest) =>
    req.principal.username ? `user:${req.principal.username}` : req.principal.id

  // Identified-folder rows (id + path-history) the tree carries for durable
  // `/folder/<id>` links and old-path/alias resolution — both projects and plain
  // folder identities. Takes already-fetched project rows (shared with treeDirsFor)
  // so /tree reads the projects registry once per request.
  // canon: docs/core.md#identity
  const folderIdentitiesFor = async (
    space: string,
    projectRows: readonly ProjectRecord[],
  ): Promise<Array<{ id: string; path: string; pathAliases: string[] }>> => {
    const out: Array<{ id: string; path: string; pathAliases: string[] }> = []

    if (folders) {
      for (const f of await folders.listForSpace(space)) {
        out.push({ id: f.id, path: f.path, pathAliases: f.pathAliases })
      }
    }
    for (const p of projectRows) {
      out.push({ id: p.id, path: p.path, pathAliases: p.pathAliases })
    }

    return out
  }

  return {
    ...opts,
    storeAccess,
    spaceStore,
    noteStore,
    spaceStoreFor,
    principalId,
    favoriteOwner,
    folderIdentitiesFor,
  }
}
