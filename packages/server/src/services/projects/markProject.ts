// Mark-as-project: the write-through core-op behind the REST projects endpoint.
// The marker file is the source of truth for id+slug; the registry row is a derived
// cache and the per-space uniqueness arbiter.
// canon: docs/projects.md#lifecycle · docs/projects.md#the-notariummeta-marker-schema-parser-pin

import { PROJECT_STATUS } from '@notarium/contract'
import { asciiSlug, freshNoteId, nextAliases } from '@notarium/core'

import type { FolderIdentityPersistence, ProjectRecord, ProjectsPersistence } from '../metaDb'
import { parseMarker, serializeMarker } from './marker'
import type { MarkerStore } from './markerStore'
import { withMarkLock } from './markLock'
import { lastSegment, mintSlug } from './slug'

export type MarkFolderDeps = {
  projects: ProjectsPersistence
  folders?: FolderIdentityPersistence
  /** Absent (the e2e fake) ⇒ registry-only, no marker file. */
  markerStore?: MarkerStore
  now: () => Date
}

export type MarkFolderInput = {
  space: string
  /** safeRelPath-normalised folder path; `''` = the space root. */
  folderPath: string
  displayName?: string
}

/** Project row plus the lifecycle fact decided inside the mark lock. Only a
 * freshly inserted active row is a transition; idempotent/healing marks are not. */
export type MarkFolderResult = ProjectRecord & { createdActive: boolean }

/** Mark a folder (or the space root) as a project; returns the registry record. Idempotent.
 *  canon: docs/projects.md#reconcile-the-row-lifecycle-fork-b-lazy-i3-implemented-cadence-boot-only-2026-06-18 */
export const markFolderAsProject = (
  deps: MarkFolderDeps,
  input: MarkFolderInput,
): Promise<MarkFolderResult> =>
  withMarkLock(`${input.space}\0${input.folderPath}`, () => markFolderInner(deps, input))

const markFolderInner = async (
  deps: MarkFolderDeps,
  input: MarkFolderInput,
): Promise<MarkFolderResult> => {
  const { projects, folders, markerStore } = deps
  const { space, folderPath } = input
  const nowIso = deps.now().toISOString()

  // 1. The row already at THIS (space, path) IS the project here — the idempotency
  //    anchor is the PATH, not the marker-id: a divergent/hand-edited marker can't fork it.
  const rowAtPath = (await projects.listForSpace(space)).find((r) => r.path === folderPath)

  if (rowAtPath) {
    const displayName = input.displayName?.trim() || rowAtPath.displayName
    const record: ProjectRecord = { ...rowAtPath, displayName, lastSeen: nowIso }

    if (markerStore) {
      await writeMarkerFor(markerStore, space, folderPath, record)
    }
    await projects.upsert(record)
    return { ...record, createdActive: false }
  }

  // 2. No project row here yet — the marker may carry a reusable id+slug.
  const marker = markerStore ? parseMarker((await markerStore.read(space, folderPath)) ?? '') : null
  // Reuse the marker's id only when FREE (orphaned marker → rebuild the lost row).
  // An id owned by another path = a copy → mint fresh (never steal; Fork B).
  const owner = marker?.id ? await projects.getById(marker.id) : null
  const markerReuseId = marker?.id && !owner ? marker.id : undefined
  // A plain folder-identity already at this path: ADOPT its id so the mark flips that
  // row in place (ON CONFLICT(id)→'project'); minting a second row would collide on
  // the shared UNIQUE(space,path) → 500.
  const folderRow =
    !markerReuseId && folders && folderPath ? await folders.byPath(space, folderPath) : null
  const reuseId = markerReuseId ?? folderRow?.id
  const id = reuseId ?? freshNoteId()
  const displayName = input.displayName?.trim() || lastSegment(folderPath) || space
  const preferred = reuseId ? marker?.slug || displayName : displayName
  const slug = await mintSlug(projects, space, preferred, id)
  const record: ProjectRecord = {
    id,
    space,
    path: folderPath,
    slug,
    // Orphan-marker rebuild restores past slugs — old handles survive (Fork A);
    // a fresh mint starts with none.
    aliases: markerReuseId ? (marker?.aliases ?? []) : [],
    pathAliases: markerReuseId ? (marker?.pathAliases ?? []) : (folderRow?.pathAliases ?? []),
    displayName,
    status: PROJECT_STATUS.active,
    lastSeen: nowIso,
    createdAt: nowIso,
  }

  if (markerStore) {
    await writeMarkerFor(markerStore, space, folderPath, record)
  }
  try {
    await projects.upsert(record)
  } catch (err) {
    // Lost a cross-process race for this (space, path): the winner's row stands.
    // Return it (idempotent) instead of leaking a raw UNIQUE-constraint 500.
    const winner = (await projects.listForSpace(space)).find((r) => r.path === folderPath)

    if (winner) {
      return { ...winner, createdActive: false }
    }
    throw err
  }

  return { ...record, createdActive: true }
}

/** Unmark a project by id (a human act; no agent container-delete, C1).
 *  Anti-enumeration: an unknown id, or an id in a DIFFERENT space than addressed,
 *  answers false (the route 404s). Serialized per (space, path) — the lock key MUST
 *  match markFolderAsProject/renameProjectSlug (NUL separator), else an unmark racing
 *  a rename resurrects the row (the rename's upsert lands after the delete). */
export const unmarkProject = async (
  deps: MarkFolderDeps,
  input: { space: string; id: string },
): Promise<boolean> => {
  const { projects, markerStore } = deps
  const row = await projects.getById(input.id)

  if (!row || row.space !== input.space) {
    return false
  }

  return withMarkLock(`${row.space}\0${row.path}`, async () => {
    if (markerStore) {
      // The SPACE-ROOT marker also carries the space-identity facet; an unmark of
      // the root PROJECT must NOT strip it (the marker.ts invariant). Preserve it.
      const spaceFacet =
        row.path === ''
          ? parseMarker((await markerStore.read(row.space, row.path)) ?? '')?.space
          : undefined

      if (spaceFacet) {
        await markerStore.write(row.space, row.path, serializeMarker({ space: spaceFacet }))
      } else {
        await markerStore.remove(row.space, row.path)
      }
    }
    await projects.delete(row.id)
    return true
  })
}

/** Typed rename outcome (not a throw), so the REST layer maps each case to its own
 *  status (404/400/409/200) without parsing messages. */
export type RenameProjectResult =
  | { ok: true; record: ProjectRecord }
  | { ok: false; code: 'not_found' | 'root' | 'collision' | 'invalid' }

/** Rename a project's slug and/or displayName (a human/REST act; the agent tool is
 *  separate). A changed slug retires the old one into alias history so `space/<old-slug>`
 *  keeps resolving; an explicit rename is REJECTED on collision (409), never silently
 *  suffixed like the mint path. Anti-enumeration: an id in another/unknown space → not_found.
 *  Serialized per (space, path) and re-reads the row inside the lock.
 *  canon: docs/projects.md#addressing */
export const renameProjectSlug = (
  deps: MarkFolderDeps,
  input: { space: string; id: string; slug?: string; displayName?: string },
): Promise<RenameProjectResult> => {
  const { projects, markerStore } = deps
  return (async () => {
    const found = await projects.getById(input.id)

    if (!found || found.space !== input.space) {
      return { ok: false as const, code: 'not_found' as const }
    }

    return withMarkLock(`${found.space}\0${found.path}`, async (): Promise<RenameProjectResult> => {
      // Re-read inside the lock: a concurrent re-mark/move could have changed the
      // row (or an unmark removed it) between the unlocked getById and here.
      const current = await projects.getById(input.id)

      if (!current || current.space !== input.space) {
        return { ok: false, code: 'not_found' }
      }

      let slug = current.slug
      let aliases = current.aliases

      if (input.slug !== undefined) {
        // A root project's handle is just `<space>`; renaming its slug changes nothing
        // addressable — the space rename owns that name.
        if (current.path === '') {
          return { ok: false, code: 'root' }
        }
        const next = asciiSlug(input.slug)

        if (!next) {
          return { ok: false, code: 'invalid' }
        }
        if (next !== current.slug) {
          const holder = await projects.getByHandle(current.space, next)

          if (holder && holder.id !== current.id) {
            return { ok: false, code: 'collision' }
          }
          slug = next
          aliases = nextAliases(current.aliases, current.slug, next)
        }
      }
      const displayName = input.displayName?.trim() || current.displayName
      const record: ProjectRecord = {
        ...current,
        slug,
        aliases,
        displayName,
        lastSeen: deps.now().toISOString(),
      }

      // Marker (source of truth) first, then the derived cache — same order as
      // mark-as-project, so a crash between them leaves the truth ahead and a boot
      // reconcile heals the cache.
      if (markerStore) {
        await writeMarkerFor(markerStore, current.space, current.path, record)
      }
      await projects.upsert(record)
      return { ok: true, record }
    })
  })()
}

export const writeMarkerFor = async (
  markerStore: MarkerStore,
  space: string,
  folderPath: string,
  record: ProjectRecord,
): Promise<void> => {
  // The SPACE-ROOT marker carries BOTH the root project identity AND the space-identity
  // facet; a project-side write must not clobber the space facet (marker.ts invariant),
  // else a re-clone window loses the space identity until a boot heal restores it.
  const spaceFacet =
    folderPath === ''
      ? parseMarker((await markerStore.read(space, folderPath)) ?? '')?.space
      : undefined
  await markerStore.write(
    space,
    folderPath,
    serializeMarker({
      id: record.id,
      type: 'project',
      slug: record.slug,
      aliases: record.aliases.length ? record.aliases : undefined,
      pathAliases: record.pathAliases.length ? record.pathAliases : undefined,
      displayName: record.displayName,
      status: record.status,
      ...(spaceFacet ? { space: spaceFacet } : {}),
    }),
  )
}
