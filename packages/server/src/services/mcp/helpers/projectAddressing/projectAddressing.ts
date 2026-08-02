// Project addressing: the shared note→project / project→handle chokepoints.
// canon: docs/projects.md#addressing
import { NOTE_CLASS } from '@notarium/contract'
import { type ProjectSummary } from '@notarium/contract/tools'
import { memoryDirOf, type NoteClass } from '@notarium/core'

import { type ProjectRecord } from '../../../metaDb'
import { projectHandleOf } from '../../../projects'

// ── project addressing helpers ─────────────────────────────────────────

/** Project row → wire handle `space/slug`. `spaceSlug` must be the space's CURRENT slug;
 *  `p.space` is the opaque id, never the wire. */
export const handleOf = (p: ProjectRecord, spaceSlug: string): string =>
  projectHandleOf(p, spaceSlug)

/** Project row → the contract's ProjectSummary (boundary mapper). */
export const projectSummaryOf = (p: ProjectRecord, spaceSlug: string): ProjectSummary => ({
  id: p.id,
  handle: handleOf(p, spaceSlug),
  displayName: p.displayName,
  space: spaceSlug,
  status: p.status,
})

/** The project owning a note: nearest-ancestor by longest matching `path`
 *  (path '' = root project owns the whole space). */
export const projectHandleForNote = (
  spaceSlug: string,
  filePath: string,
  projectsInSpace: readonly ProjectRecord[],
): string | undefined => {
  // Agent-mount notes (`.notarium/memory/<id>/…`) resolve by embedded id, not folder residence —
  // a root project (path '') would otherwise wrongly claim them.
  // canon: docs/note-model.md#agent-memory
  if (filePath.startsWith('.notarium/')) {
    return undefined
  }
  const dir = filePath.includes('/') ? filePath.slice(0, filePath.lastIndexOf('/')) : ''
  let best: ProjectRecord | undefined

  for (const p of projectsInSpace) {
    const isAncestor = p.path === '' || dir === p.path || dir.startsWith(`${p.path}/`)

    if (!isAncestor) {
      continue
    }
    if (!best || p.path.length > best.path.length) {
      best = p
    }
  }

  return best ? handleOf(best, spaceSlug) : undefined
}

/** The project handle a read hit carries — the single labelling chokepoint.
 *  Two derivations by class: agent-memory by its embedded mount id, everything else by
 *  nearest-ancestor folder residence. Archived projects stay labelled (no status filter
 *  here) — still addressable, so the handle round-trips even though get_my_projects hides them.
 */
export const projectLabelForNote = (
  spaceSlug: string,
  filePath: string | null | undefined,
  cls: NoteClass | undefined,
  projectsInSpace: readonly ProjectRecord[],
): string | undefined => {
  if (filePath == null) {
    return undefined
  }
  if (cls === NOTE_CLASS.agentMemory) {
    const subdir = memoryDirOf(filePath)

    if (!subdir) {
      return undefined
    } // mount root = about-user memory, no project
    const rec = projectsInSpace.find((p) => p.id === subdir)
    return rec ? handleOf(rec, spaceSlug) : undefined
  }

  return projectHandleForNote(spaceSlug, filePath, projectsInSpace)
}

/** A note's agent-facing path: space-relative `filePath` with the `.md` extension stripped.
 *  For dedup-by-location and folder-language with a human — note references are always by note-id. */
export const notePath = (filePath: string | null | undefined): string | undefined => {
  if (!filePath) {
    return undefined
  }

  return filePath.replace(/\.md$/i, '')
}
