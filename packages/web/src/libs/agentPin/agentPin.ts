import type { ProjectRow } from '@notarium/contract'

// Helpers for the «Pin to agent context» action (#165): a pin is membership in the
// `always-load` tag, and WHERE a pinned note surfaces follows from WHERE it lives —
// the personal domain feeds the profile, a marked project feeds that project's
// bundle. A note in a working space with no ancestor project pins NOWHERE, so the
// action is hidden there — no dead actions.

export const ALWAYS_LOAD_TAG = 'always-load'

/** A note's folder (space-relative), from its filePath — '' = the space root. */
export const noteFolderOf = (filePath?: string): string => {
  if (!filePath) {
    return ''
  }
  const i = filePath.lastIndexOf('/')
  return i >= 0 ? filePath.slice(0, i) : ''
}

/** Is this note already pinned (carries the `always-load` tag)? Reads the note's
 *  frontmatter (the reader has it; the tree does not, so it offers pin only). */
export const isPinned = (frontmatter?: Record<string, unknown>): boolean => {
  const tags = frontmatter?.tags
  return Array.isArray(tags) && tags.includes(ALWAYS_LOAD_TAG)
}

/** Root project (path '') is an ancestor of everything; otherwise an exact match
 *  or a path-prefix (boundary-safe, so `docs` never matches `docs-archive`). */
const folderUnder = (folder: string, projectPath: string): boolean => {
  if (projectPath === '') {
    return true
  }

  return folder === projectPath || folder.startsWith(`${projectPath}/`)
}

/** Can a note here be pinned into agent context? It needs a target the scan
 *  reaches: the personal domain (→ profile) or a marked project that is an ancestor
 *  of its folder (→ that project's bundle). `projects` is the note's space's
 *  projects (the active space in the reader/tree). Otherwise → hidden. */
export const canPinNote = (opts: {
  noteSpace?: string
  noteFolder: string
  personalSlug: string | null
  projects: ProjectRow[] | null
}): boolean => {
  const { noteSpace, noteFolder, personalSlug, projects } = opts

  if (!noteSpace) {
    return false
  }
  if (personalSlug && noteSpace === personalSlug) {
    return true
  }

  return (projects ?? []).some((p) => folderUnder(noteFolder, p.path))
}
