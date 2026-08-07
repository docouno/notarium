// Slug helpers for the project registry.
// canon: docs/projects.md#addressing

import { asciiSlug } from '@notarium/core'

import type { ProjectsPersistence } from '../metaDb'

export const lastSegment = (folderPath: string): string => {
  const parts = folderPath.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? ''
}

/** Mint a space-unique slug. The `-2`/`-3` suffix guards `UNIQUE(space, slug)` — two
 *  folders can transliterate to one base slug; `selfId` makes a re-confirm idempotent. */
export const mintSlug = async (
  projects: ProjectsPersistence,
  space: string,
  base: string,
  selfId: string,
): Promise<string> => {
  // `asciiSlug`, not `slugify`: a project handle is a URL/agent-facing segment in the
  // same alphabet as a space handle, so a script we cannot romanise degrades to the
  // generic base rather than putting its own letters into the handle (#296).
  const root = asciiSlug(base) || 'project'

  for (let n = 1; ; n++) {
    const candidate = n === 1 ? root : `${root}-${n}`
    const existing = await projects.getByHandle(space, candidate)

    if (!existing || existing.id === selfId) {
      return candidate
    }
  }
}
