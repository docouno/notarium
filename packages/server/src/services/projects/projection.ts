// Pure row→wire projections of a project registry row (no I/O).
// canon: docs/projects.md#addressing

import type { ProjectRow } from '@notarium/contract'

import type { ProjectRecord } from '../metaDb'

/** A project's stable handle. Caller passes the space's CURRENT slug — the opaque
 *  space id never rides the wire; the handle stays human-readable and still resolves.
 *  canon: docs/projects.md#the-address-primitive-projecthandle */
export const projectHandleOf = (
  p: Pick<ProjectRecord, 'slug' | 'path'>,
  spaceSlug: string,
): string => (p.path === '' ? spaceSlug : `${spaceSlug}/${p.slug}`)

/** REST/agent projection of a registry row.
 *  canon: docs/projects.md#rest-parity-p4-the-13-surfaces */
export const projectSummaryOf = (r: ProjectRecord, spaceSlug: string): ProjectRow => ({
  id: r.id,
  handle: projectHandleOf(r, spaceSlug),
  slug: r.slug,
  path: r.path,
  displayName: r.displayName,
  space: spaceSlug,
  status: r.status,
  ...(r.aliases.length ? { aliases: r.aliases } : {}),
})
