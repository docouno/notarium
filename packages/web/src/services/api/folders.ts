import type {
  CreateFolderPageResponse,
  FolderResponse,
  MoveResponse,
  OkResponse,
  RemoveResponse,
} from '@notarium/contract'
import { req, sp } from './client'
import type { FolderPageCreateInput } from './types'

export const foldersApi = {
  /** Move/rename a folder — space-scoped (#16 split: a folder has no identity
   *  beyond its place in a space's tree). */
  moveFolder: (space: string, path: string, destinationPath: string) =>
    req<MoveResponse>(`${sp(space)}/move-folder`, {
      method: 'POST',
      body: JSON.stringify({ path, destinationPath }),
    }),

  // ── folders (#97) ─────────────────────────────────────────────────────────
  /** Create an empty folder ("New folder") — a durable, unmarked dir. Slashes
   *  nest; a name clash 409s. */
  folderCreate: (space: string, path: string) =>
    req<OkResponse>(`${sp(space)}/folders`, { method: 'POST', body: JSON.stringify({ path }) }),
  /** Delete a folder and everything under it (its notes — journaled — any
   *  projects, then the dir subtree). One request, not N note deletes. */
  folderDelete: (space: string, path: string) =>
    req<RemoveResponse>(`${sp(space)}/folders?path=${encodeURIComponent(path)}`, {
      method: 'DELETE',
    }),
  /** Resolve a folder by its durable id (#212) — space-free, the registry knows the
   *  space. Carries the current space slug + path (so a `/folder/<id>` permalink lands
   *  on the live path, surviving moves like a note id) and the page note id if one exists. */
  folderGet: (id: string, signal?: AbortSignal) =>
    req<FolderResponse>(`/api/folder/${encodeURIComponent(id)}`, { signal }),
  /** Create a folder's page (#212): mint the folder's lazy identity + write its
   *  `index.md` body note. Optional note fields let a virtual folder page
   *  materialise on first Save without an empty intermediate revision. */
  folderPageCreate: (space: string, folderPath: string, input: FolderPageCreateInput = {}) =>
    req<CreateFolderPageResponse>(`${sp(space)}/folders/page`, {
      method: 'POST',
      body: JSON.stringify({
        folderPath,
        content: input.content,
        noteType: input.noteType,
        tags: input.tags,
        fields: input.fields,
        slug: input.slug,
        createdAt: input.createdAt,
      }),
    }),
}
