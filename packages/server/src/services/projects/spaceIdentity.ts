// Space identity: resolve-or-mint a space's stable opaque id + renameable slug,
// with an alias rename-history and cross-host adoption from the root marker facet.
// canon: docs/spaces.md#model · docs/spaces.md#server

import { asciiSlug, freshNoteId, nextAliases } from '@notarium/core'

import type { SpaceRecord, SpacesPersistence } from '../metaDb'
import { parseMarker, serializeMarker, type SpaceMarkerFacet } from './marker'
import type { MarkerStore } from './markerStore'

export type SpaceIdentityDeps = {
  spaces: SpacesPersistence
  markerStore?: MarkerStore
  now: () => Date
}

/** Resolve-or-mint a space's identity; idempotent — boot/create call sites re-run it.
 */
export const provisionSpaceIdentity = async (
  deps: SpaceIdentityDeps,
  input: { slug: string; displayName: string; notesDir?: string; markerFacet?: SpaceMarkerFacet },
): Promise<SpaceRecord> => {
  const existing = await deps.spaces.getBySlug(input.slug)

  if (existing) {
    const rec: SpaceRecord = { ...existing, displayName: input.displayName }
    await deps.spaces.upsert(rec)
    return rec
  }
  let id = freshNoteId()
  let aliases: string[] = []
  const facet = input.markerFacet

  if (facet) {
    const holder = await deps.spaces.getById(facet.id)

    if (holder) {
      console.warn(
        `[spaces] provision ${input.slug}: marker id ${facet.id} already held by ${holder.slug} — minting fresh`,
      )
    } else {
      id = facet.id
      aliases = facet.aliases ?? []
      if (facet.slug && facet.slug !== input.slug && !aliases.includes(facet.slug)) {
        aliases = [...aliases, facet.slug]
      }
    }
  }
  const rec: SpaceRecord = {
    id,
    slug: input.slug,
    displayName: input.displayName,
    notesDir: input.notesDir ?? input.slug,
    aliases,
    createdAt: deps.now().toISOString(),
    archivedAt: null,
    archivedBy: null,
  }
  await deps.spaces.upsert(rec)
  return rec
}

export type RenameSpaceResult =
  | { code: 'ok'; record: SpaceRecord }
  | { code: 'not_found' }
  | { code: 'invalid' }
  | { code: 'collision' }

/** Rename a space's slug and/or displayName.
 */
export const recordSpaceRename = async (
  deps: SpaceIdentityDeps,
  input: { id: string; slug?: string; displayName?: string },
): Promise<RenameSpaceResult> => {
  const rec = await deps.spaces.getById(input.id)

  if (!rec) {
    return { code: 'not_found' }
  }
  let slug = rec.slug
  let aliases = rec.aliases

  if (input.slug !== undefined) {
    const next = asciiSlug(input.slug)

    if (!next) {
      return { code: 'invalid' }
    }
    if (next !== rec.slug) {
      const holder = await deps.spaces.getBySlug(next)

      if (holder && holder.id !== rec.id) {
        return { code: 'collision' }
      }
      aliases = nextAliases(rec.aliases, rec.slug, next)
      slug = next
    }
  }
  const displayName = input.displayName?.trim() || rec.displayName
  const updated: SpaceRecord = { ...rec, slug, displayName, aliases }
  await deps.spaces.upsert(updated)
  await healSpaceMarker(deps, updated)
  return { code: 'ok', record: updated }
}

/** Write-through the `space` facet into the root `.notariummeta`, merging so the
 *  folder's own project/folder facets are preserved. Best-effort (P5): a marker blip
 *  is reconciled at the next boot scan.
 */
export const healSpaceMarker = async (deps: SpaceIdentityDeps, rec: SpaceRecord): Promise<void> => {
  const ms = deps.markerStore

  if (!ms || !ms.available(rec.id)) {
    return
  }
  try {
    const existing = parseMarker((await ms.read(rec.id, '')) ?? '') ?? {}
    const facet = {
      id: rec.id,
      slug: rec.slug,
      ...(rec.aliases.length ? { aliases: rec.aliases } : {}),
    }
    // Skip the write when the on-disk facet already matches — the boot heal runs
    // every cycle and must not churn the marker file.
    const cur = existing.space

    if (
      cur &&
      cur.id === facet.id &&
      cur.slug === facet.slug &&
      sameStrings(cur.aliases ?? [], rec.aliases)
    ) {
      return
    }
    await ms.write(rec.id, '', serializeMarker({ ...existing, space: facet }))
  } catch (err) {
    console.error(`[spaces] heal marker ${rec.slug} ->`, (err as Error).message)
  }
}

const sameStrings = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i])
