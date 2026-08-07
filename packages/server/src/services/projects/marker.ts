// The `.notariummeta` marker: a sibling dotfile at a folder root that anchors the
// folder's project identity in the folder itself; the derived `projects` table is a
// per-request cache of it, while the marker is read only on a scan, never per request.
// canon: docs/projects.md#project-identity-the-marker-file-pattern-51-lifted-notefolder
//
// Sole writer is markerStore: a dot-prefixed non-`.md` path is invisible to the note
// index and safeRelPath fail-closes note routes at dot segments — no /api/* write reaches it.

import { PROJECT_STATUS } from '@notarium/contract'
import { isCanonicalSafeRelativeAddress, isDurableScalar } from '@notarium/core'
import type { ProjectStatus } from '../metaDb'

export const MARKER_FILENAME = '.notariummeta'

/** Marker kind: an identified FOLDER (id + path-history, no handle) vs a PROJECT
 *  (handle + memory + agent semantics); absent in a file ⇒ 'project' (legacy default).
 *  canon: docs/projects.md#marker-fields */
export type MarkerType = 'folder' | 'project'

/** Space-identity facet, present ONLY on the marker at a space root; rides beside the
 *  root folder's own project identity in the same file. canon: docs/spaces.md#model
 *  Gotcha: honoured only at folderPath==='' — a stray `space` block in a nested marker
 *  is ignored, never promotes a subfolder to a space. */
export type SpaceMarkerFacet = {
  id: string
  slug: string
  aliases?: string[]
}

/** The marker's on-disk fields; only an identity (`id` or `space.id`) is mandatory,
 *  and unknown keys are tolerated so new fields are additive (old markers never migrate).
 */
export type MarkerFields = {
  id?: string
  type?: MarkerType
  slug?: string
  aliases?: string[]
  pathAliases?: string[]
  space?: SpaceMarkerFacet
  displayName?: string
  status?: ProjectStatus
}

/** freshNoteId shape. Stricter than the identity scheme's idClaim (non-emptiness only):
 *  a malformed id is fail-closed here, not trusted. */
const ID_RE = /^[A-Za-z0-9_-]{12}$/
/** Handle slug shape — matches SpaceSlug / what `asciiSlug`/`idToSlug` emit. */
const SLUG_RE = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/

/** Sanity gate for a folder path alias, NOT a slug check: the engine stores
 *  directories verbatim (raw, may be non-ASCII); the resolver slugifies on lookup.
 *  Rejects empty, over-long, absolute, and `.`/`..` traversal paths. */
const isPathAlias = (s: string): boolean => {
  if (!s || s.length > 1024 || !isCanonicalSafeRelativeAddress(s)) {
    return false
  }

  return true
}

const cleanSlugList = (raw: unknown): string[] | undefined => {
  if (!Array.isArray(raw)) {
    return undefined
  }
  const seen = new Set<string>()
  const out = raw.filter(
    (a): a is string =>
      typeof a === 'string' && SLUG_RE.test(a) && !seen.has(a) && (seen.add(a), true),
  )
  return out.length ? out : undefined
}

/** Validate the space facet; a malformed id or slug drops the whole block (fail-closed). */
const parseSpaceFacet = (raw: unknown): SpaceMarkerFacet | undefined => {
  if (!raw || typeof raw !== 'object') {
    return undefined
  }
  const s = raw as Record<string, unknown>

  if (typeof s.id !== 'string' || !ID_RE.test(s.id)) {
    return undefined
  }
  if (typeof s.slug !== 'string' || !SLUG_RE.test(s.slug)) {
    return undefined
  }
  const facet: SpaceMarkerFacet = { id: s.id, slug: s.slug }
  const aliases = cleanSlugList(s.aliases)

  if (aliases) {
    facet.aliases = aliases
  }

  return facet
}

/** Tolerant parse → fields, or null when the marker carries no valid identity.
 *  null ⇒ treat the folder as UNMARKED (fail-closed); the next write-through re-mints.
 *  canon: docs/projects.md#the-notariummeta-marker-schema-parser-pin */
export const parseMarker = (raw: string): MarkerFields | null => {
  let obj: unknown

  try {
    obj = JSON.parse(raw)
  } catch {
    return null
  }
  if (!obj || typeof obj !== 'object') {
    return null
  }
  const r = obj as Record<string, unknown>
  // Parsed first so a marker carrying ONLY a space facet (root project unmarked) stays valid.
  const space = parseSpaceFacet(r.space)
  const hasId = typeof r.id === 'string' && ID_RE.test(r.id)

  if (!hasId && !space) {
    return null
  }
  const fields: MarkerFields = {}

  if (hasId) {
    fields.id = r.id as string
  }
  if (space) {
    fields.space = space
  }
  if (r.type === 'folder') {
    fields.type = 'folder'
  }
  if (typeof r.slug === 'string' && SLUG_RE.test(r.slug)) {
    fields.slug = r.slug
  }
  if (Array.isArray(r.aliases)) {
    const seen = new Set<string>()
    const aliases = r.aliases.filter(
      (a): a is string =>
        typeof a === 'string' && SLUG_RE.test(a) && !seen.has(a) && (seen.add(a), true),
    )

    if (aliases.length) {
      fields.aliases = aliases
    }
  }
  if (Array.isArray(r.pathAliases)) {
    const seen = new Set<string>()
    const paths = r.pathAliases.filter(
      (a): a is string =>
        typeof a === 'string' && isPathAlias(a) && !seen.has(a) && (seen.add(a), true),
    )

    if (paths.length) {
      fields.pathAliases = paths
    }
  }
  if (typeof r.displayName === 'string' && isDurableScalar(r.displayName) && r.displayName.trim()) {
    fields.displayName = r.displayName.trim()
  }
  if (r.status === PROJECT_STATUS.active || r.status === PROJECT_STATUS.archived) {
    fields.status = r.status
  }

  return fields
}

/** Serialize fields to marker JSON for write-through. Indented + trailing newline so a
 *  committed marker diffs cleanly in git. */
export const serializeMarker = (fields: MarkerFields): string => {
  const ordered: Record<string, unknown> = {}

  if (fields.id) {
    ordered.id = fields.id
  }
  if (fields.type === 'folder') {
    ordered.type = 'folder'
  }
  if (fields.slug) {
    ordered.slug = fields.slug
  }
  if (fields.aliases?.length) {
    ordered.aliases = fields.aliases
  }
  if (fields.pathAliases?.length) {
    ordered.pathAliases = fields.pathAliases
  }
  if (fields.space) {
    ordered.space = fields.space.aliases?.length
      ? { id: fields.space.id, slug: fields.space.slug, aliases: fields.space.aliases }
      : { id: fields.space.id, slug: fields.space.slug }
  }
  if (fields.displayName) {
    ordered.displayName = fields.displayName
  }
  if (fields.status) {
    ordered.status = fields.status
  }

  return `${JSON.stringify(ordered, null, 2)}\n`
}

/** Space-relative path of a folder's marker file. `''` = the space root. */
export const markerRelPath = (folderPath: string): string =>
  folderPath ? `${folderPath}/${MARKER_FILENAME}` : MARKER_FILENAME
