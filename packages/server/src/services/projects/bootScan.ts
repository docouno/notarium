// Boot reconcile: converge the derived projects/folders registry to the on-disk
// `.notariummeta` markers (marker = truth, table = rebuildable cache; boot-only).
// canon: docs/projects.md#reconcile-the-row-lifecycle-fork-b-lazy-i3-implemented-cadence-boot-only-2026-06-18 · docs/architecture.md#p2

import { PROJECT_STATUS } from '@notarium/contract'
import { nextAliasesMulti, nextPathAliasesMulti } from '@notarium/core'

import type { FolderIdentityPersistence, ProjectsPersistence } from '../metaDb'
import { parseMarker } from './marker'
import type { MarkerStore } from './markerStore'
import { lastSegment, mintSlug } from './slug'

export type BootScanDeps = {
  projects: ProjectsPersistence
  /** Absent ⇒ the folder-identity layer is skipped (folder markers left
   *  unreconciled): honest degradation on a meta-DB-less host (P5). */
  folders?: FolderIdentityPersistence
  markerStore: MarkerStore
  now: () => Date
}

type ParsedHit = { folderPath: string; fields: NonNullable<ReturnType<typeof parseMarker>> }

/** Scan every space's tree for `.notariummeta` markers and reconcile the registry.
 *  A cross-space MOVE converges in ≤2 boots: the source space prunes the row, then
 *  the destination adopts the freed id (a copy stays row-less — never migrated). */
export const scanProjectsAtBoot = async (
  deps: BootScanDeps,
  spaces: readonly string[],
): Promise<void> => {
  const { projects, folders, markerStore } = deps
  const nowIso = deps.now().toISOString()

  for (const space of spaces) {
    // Per-space guard: one space's scan failure skips only THAT space (P5).
    try {
      if (!markerStore.available(space)) {
        continue
      }
      const { hits, complete } = await markerStore.scan(space)
      const projectRows = await projects.listForSpace(space)
      const folderRows = folders ? await folders.listForSpace(space) : []
      const projectOwnById = new Map(projectRows.map((r) => [r.id, r]))
      const folderOwnById = new Map(folderRows.map((r) => [r.id, r]))
      // parseOk goes false on an unparseable marker: its id/type is unknown, so the
      // hit set is no longer authoritative for PRUNE — a corrupt marker over a live
      // row would look like "marker gone" and delete it.
      let parseOk = true
      const projectsById = new Map<string, ParsedHit[]>()
      const foldersById = new Map<string, ParsedHit[]>()

      for (const hit of hits) {
        const fields = parseMarker(hit.raw)

        if (!fields) {
          parseOk = false
          continue
        }
        // Space-only marker (space facet present, no folder/project id): nothing to
        // reconcile, but it IS a valid parse — don't trip parseOk.
        if (!fields.id) {
          continue
        }
        const bucket = fields.type === 'folder' ? foldersById : projectsById
        const group = bucket.get(fields.id) ?? []
        group.push({ folderPath: hit.folderPath, fields })
        bucket.set(fields.id, group)
      }

      // ── project handle layer ──────────────────────────────
      for (const [id, group] of projectsById) {
        try {
          const existing = projectOwnById.get(id)

          // id owned by ANOTHER space = cross-space copy: never migrate the row
          // across the boundary — leave this space's copy row-less.
          if (!existing && (await projects.getById(id))) {
            continue
          }
          // Dedup tie-break: prefer the registry-known path (stable across boots), else first scanned.
          const chosen = group.find((g) => g.folderPath === existing?.path) ?? group[0]
          const { fields, folderPath } = chosen
          // mintSlug suffixes against rows already upserted THIS scan — the registry
          // stays the uniqueness arbiter within a single boot pass.
          const preferred =
            fields.slug || existing?.slug || fields.displayName || lastSegment(folderPath) || space
          const slug = await mintSlug(projects, space, preferred, id)
          const aliases = nextAliasesMulti(
            [...(fields.aliases ?? []), ...(existing?.aliases ?? [])],
            existing && existing.slug !== slug ? [existing.slug] : [],
            [slug],
          )
          const pathAliases = nextPathAliasesMulti(
            [...(fields.pathAliases ?? []), ...(existing?.pathAliases ?? [])],
            existing && existing.path !== folderPath ? [existing.path] : [],
            [folderPath],
          )
          await projects.upsert({
            id,
            space,
            path: folderPath,
            slug,
            aliases,
            pathAliases,
            displayName:
              fields.displayName || existing?.displayName || lastSegment(folderPath) || space,
            status: fields.status || existing?.status || PROJECT_STATUS.active,
            lastSeen: nowIso,
            createdAt: existing?.createdAt ?? nowIso,
          })
        } catch (err) {
          console.error(`[projects] boot upsert ${space} (${id}) ->`, (err as Error).message)
        }
      }

      // ── plain folder-identity layer ────────────────────────────────
      if (folders) {
        for (const [id, group] of foldersById) {
          try {
            const existing = folderOwnById.get(id)

            if (!existing && (await folders.getById(id))) {
              continue
            } // cross-space copy
            const chosen = group.find((g) => g.folderPath === existing?.path) ?? group[0]
            const { fields, folderPath } = chosen
            const pathAliases = nextPathAliasesMulti(
              [...(fields.pathAliases ?? []), ...(existing?.pathAliases ?? [])],
              existing && existing.path !== folderPath ? [existing.path] : [],
              [folderPath],
            )
            await folders.upsert({
              id,
              space,
              path: folderPath,
              pathAliases,
              lastSeen: nowIso,
              createdAt: existing?.createdAt ?? nowIso,
            })
          } catch (err) {
            console.error(`[folders] boot upsert ${space} (${id}) ->`, (err as Error).message)
          }
        }
      }

      // Prune rows whose marker is gone (external delete) — ONLY on a scan that was
      // both COMPLETE and fully PARSEABLE: a partial/corrupt scan is a lower bound,
      // pruning on it would nuke live rows.
      if (complete && parseOk) {
        const liveProjectIds = new Set(projectsById.keys())

        for (const row of projectRows) {
          if (liveProjectIds.has(row.id)) {
            continue
          }
          try {
            await projects.delete(row.id)
          } catch (err) {
            console.error(`[projects] boot prune ${space} (${row.id}) ->`, (err as Error).message)
          }
        }
        const liveFolderIds = new Set(foldersById.keys())

        if (folders) {
          for (const row of folderRows) {
            if (liveFolderIds.has(row.id)) {
              continue
            }
            try {
              await folders.delete(row.id)
            } catch (err) {
              console.error(`[folders] boot prune ${space} (${row.id}) ->`, (err as Error).message)
            }
          }
        }
      }
    } catch (err) {
      console.error(`[projects] boot scan ${space} ->`, (err as Error).message)
    }
  }
}
