// Plain folder-identity ops: give a folder a durable id without making it a project.
// Both ops serialize through the shared mark lock so they can't race a mark/rename
// of the same folder.
// canon: docs/projects.md#projects-folders-registry

import { freshNoteId, nextPathAliases } from '@notarium/core'

import type {
  FolderIdentityPersistence,
  FolderRecord,
  ProjectRecord,
  ProjectsPersistence,
} from '../metaDb'
import { parseMarker, serializeMarker, type SpaceMarkerFacet } from './marker'
import type { MarkerStore } from './markerStore'
import { withMarkLock } from './markLock'
import { writeMarkerFor } from './markProject'

/** Ensure a folder has a stable identity and return its id — the page-create
 *  trigger that lazily mints a folder id. Idempotent + serialized per (space, path).
 */
export const ensureFolderIdentity = (
  deps: RecordFolderRenameDeps,
  input: { space: string; folderPath: string },
): Promise<string> => {
  const { space, folderPath } = input
  return withMarkLock(`${space}\0${folderPath}`, async () => {
    const project = (await deps.projects.listForSpace(space)).find((r) => r.path === folderPath)

    if (project) {
      return project.id
    }
    const existing = await deps.folders.byPath(space, folderPath)

    if (existing) {
      return existing.id
    }
    // No row yet — consult the on-disk marker. Never clobber an identity we don't
    // own: the row can be legitimately absent while the marker persists.
    // canon: docs/projects.md#reconcile-the-row-lifecycle-fork-b-lazy-i3-implemented-cadence-boot-only-2026-06-18
    const nowIso = deps.now().toISOString()
    let reuseId: string | undefined
    let reusePathAliases: string[] | undefined
    let spaceFacet: SpaceMarkerFacet | undefined

    if (deps.markerStore) {
      const marker = parseMarker((await deps.markerStore.read(space, folderPath)) ?? '')
      // A co-located SPACE facet (a space root) survives any marker WE write.
      spaceFacet = marker?.space
      if (marker?.id && marker.type !== 'folder' && !(await deps.projects.getById(marker.id))) {
        // FREE project id (row missing — clone / lost row): return it WITHOUT rewriting
        // the marker — a folder marker would destroy the project's durable slug/handle/
        // aliases unrecoverably. An OWNED id (live project elsewhere) is a copy → fall
        // through to mint a fresh id.
        return marker.id
      }
      if (
        marker?.id &&
        marker.type === 'folder' &&
        !(await deps.folders.getById(marker.id)) &&
        !(await deps.projects.getById(marker.id))
      ) {
        reuseId = marker.id
        reusePathAliases = marker.pathAliases
      }
    }
    const record: FolderRecord = {
      id: reuseId ?? freshNoteId(),
      space,
      path: folderPath,
      pathAliases: reusePathAliases ?? [],
      lastSeen: nowIso,
      createdAt: nowIso,
    }

    if (deps.markerStore) {
      await writeFolderMarkerFor(deps.markerStore, space, folderPath, record, spaceFacet)
    }
    await deps.folders.upsert(record)
    return record.id
  })
}

const writeFolderMarkerFor = (
  markerStore: MarkerStore,
  space: string,
  folderPath: string,
  record: FolderRecord,
  // A space facet — only ever set at a space root; preserved so our folder marker
  // never strips the space identity.
  spaceFacet?: SpaceMarkerFacet,
): Promise<void> =>
  markerStore.write(
    space,
    folderPath,
    serializeMarker({
      id: record.id,
      type: 'folder',
      pathAliases: record.pathAliases.length ? record.pathAliases : undefined,
      ...(spaceFacet ? { space: spaceFacet } : {}),
    }),
  )

export type RecordFolderRenameDeps = {
  projects: ProjectsPersistence
  folders: FolderIdentityPersistence
  /** Absent (the e2e fake) ⇒ registry-only, no marker file. */
  markerStore?: MarkerStore
  now: () => Date
}

export type FinalizeFolderMoveDeps = {
  projects?: ProjectsPersistence
  folders?: FolderIdentityPersistence
  /** Absent (the e2e fake) ⇒ registry-only, no marker file. */
  markerStore?: MarkerStore
  now: () => Date
  onError?: (stage: 'renamePrefix' | 'recordFolderRename', error: unknown) => void
}

/** Apply host-owned registry/path-history updates for a physical folder move.
 *  Pass this operation as the store move's `finalize` callback so the source
 *  and destination prefix claims remain held until derived state catches up.
 *  Each update is best-effort, but path-history runs only after its dependent
 *  re-prefix succeeds. The on-disk marker remains authoritative and boot
 *  reconcile can heal a transient registry failure.
 */
export const finalizeFolderMove = async (
  deps: FinalizeFolderMoveDeps,
  input: { space: string; oldPath: string; newPath: string },
): Promise<void> => {
  if (!deps.projects) {
    return
  }

  try {
    await deps.projects.renamePrefix(input.space, input.oldPath, input.newPath)
  } catch (error) {
    try {
      deps.onError?.('renamePrefix', error)
    } catch {
      // Reporting is also best-effort: the physical move already landed.
    }
    // Path-history depends on the registry row already being at newPath. If
    // re-prefix failed, continuing could mint a second plain-folder identity
    // over the moved marker while the original row remains at oldPath.

    return
  }

  if (!deps.folders) {
    return
  }

  try {
    await recordFolderRename(
      {
        projects: deps.projects,
        folders: deps.folders,
        markerStore: deps.markerStore,
        now: deps.now,
      },
      input,
    )
  } catch (error) {
    try {
      deps.onError?.('recordFolderRename', error)
    } catch {
      // Reporting is also best-effort: boot reconcile repairs derived state.
    }
  }
}

/** Record a folder's rename/move into its PATH-history. The shared move
 *  finalizer calls this after projects.renamePrefix, while the store still
 *  holds the source/destination fence, so rows already sit at newPath.
 *  Best-effort — the move already landed and boot reconcile heals a blip.
 */
export const recordFolderRename = (
  deps: RecordFolderRenameDeps,
  input: { space: string; oldPath: string; newPath: string },
): Promise<void> => {
  const { space, oldPath, newPath } = input

  // Empty path = a root move (a space rename, handled elsewhere); an unchanged path
  // is a no-op.
  if (!oldPath || !newPath || oldPath === newPath) {
    return Promise.resolve()
  }

  return withMarkLock(`${space}\0${newPath}`, async () => {
    const nowIso = deps.now().toISOString()
    const project = (await deps.projects.listForSpace(space)).find((r) => r.path === newPath)

    if (project) {
      const record: ProjectRecord = {
        ...project,
        pathAliases: nextPathAliases(project.pathAliases, oldPath, newPath),
        lastSeen: nowIso,
      }

      if (deps.markerStore) {
        await writeMarkerFor(deps.markerStore, space, newPath, record)
      }
      await deps.projects.upsert(record)
      return
    }
    // Else a plain folder: reuse the registry id, else adopt a FREE marker id (it
    // travels with the folder, so it sits at newPath after the move). Minting a fresh
    // id would orphan that identity and lose its path-history.
    const existing = await deps.folders.byPath(space, newPath)
    let reuseId: string | undefined
    let reusePathAliases: string[] | undefined

    if (!existing && deps.markerStore) {
      const marker = parseMarker((await deps.markerStore.read(space, newPath)) ?? '')

      // A PROJECT marker (lost row) is boot-reconcile's job — leave it untouched
      // (a folder marker here would clobber the project's durable fields). Only a
      // FREE folder marker is adopted.
      if (
        marker?.id &&
        marker.type === 'folder' &&
        !(await deps.folders.getById(marker.id)) &&
        !(await deps.projects.getById(marker.id))
      ) {
        reuseId = marker.id
        reusePathAliases = marker.pathAliases
      } else if (marker?.id && marker.type !== 'folder') {
        return
      }
    }
    const record: FolderRecord = {
      id: existing?.id ?? reuseId ?? freshNoteId(),
      space,
      path: newPath,
      pathAliases: nextPathAliases(existing?.pathAliases ?? reusePathAliases, oldPath, newPath),
      lastSeen: nowIso,
      createdAt: existing?.createdAt ?? nowIso,
    }

    if (deps.markerStore) {
      await writeFolderMarkerFor(deps.markerStore, space, newPath, record)
    }
    await deps.folders.upsert(record)
  })
}
