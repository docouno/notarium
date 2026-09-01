// The class-visibility invariant: a note's class carries a MATRIX of policies, enforced at ONE
// read-model chokepoint (never an obviable per-query WHERE). This module answers what the
// read-model asks of a class: is class C visible on surface S, which classes does scope X admit,
// and — where a structural role turns on it — whether a note is its folder's page.
// canon: docs/note-model.md#note-classes · docs/core.md#read-model

import { NOTE_CLASS, READ_SCOPE } from '../knowledgeStore'
import type { NoteClass, ReadScope } from '../knowledgeStore'
import { isFolderPageNote } from '../libs/path'
import type { Surface } from './consts'
import { CLASS_POLICY, DEFAULT_NOTE_CLASS, NOTE_CLASSES } from './policy'

/** Is class `cls` visible on surface `surface`? Undefined class → user-doc. */
export const isVisibleOn = (surface: Surface, cls: NoteClass | undefined): boolean =>
  CLASS_POLICY[cls ?? DEFAULT_NOTE_CLASS][surface]

/** The set of classes a discovery scope admits. `user` is the union of
 *  the user-document surfaces (feed/tree) — what the shared list() population
 *  carries; the per-surface columns (graph/userSearch) refine it further at
 *  graph()/search(). `agentRecall` is the recall set; `all` is everything. */
export const classesForScope = (scope: ReadScope): Set<NoteClass> => {
  if (scope === READ_SCOPE.all) {
    return new Set(NOTE_CLASSES)
  }
  if (scope === READ_SCOPE.agentRecall) {
    return new Set(NOTE_CLASSES.filter((c) => CLASS_POLICY[c].agentRecall))
  }
  if (scope === READ_SCOPE.trash) {
    return new Set([...NOTE_CLASSES.filter((c) => CLASS_POLICY[c].agentRecall), NOTE_CLASS.skill])
  }

  // `user`: visible on at least one user-document surface (feed or tree).
  return new Set(NOTE_CLASSES.filter((c) => CLASS_POLICY[c].feed || CLASS_POLICY[c].tree))
}

/** Does scope `scope` admit class `cls`? Undefined class → user-doc. */
export const isInScope = (scope: ReadScope, cls: NoteClass | undefined): boolean =>
  classesForScope(scope).has(cls ?? DEFAULT_NOTE_CLASS)

/** Is THIS note a folder's page? The reserved basename alone cannot answer it, which is
 *  why the question lives beside the class matrix rather than beside the path helper.
 *  Hidden service classes have dot-namespaced mounts of their own, so a memory category
 *  that slugs to `index` lands on `.notarium/memory/…/index.md`: the reserved name, in a
 *  place that is no folder and whose path the address grammar refuses outright. A page is
 *  a VISIBLE user-doc. Every surface that ANNOUNCES the role about a note it did not just
 *  write asks it here — the MCP slot and marker, the REST context carrier, the tree's
 *  `pageNoteId`, the reader's own labels. A bare basename comparison survives in exactly
 *  three shapes, none of them a claim about somebody else's note: EXCLUDING a cover from a
 *  listing or a counter (a false positive costs nothing it did not already cost), PINNING
 *  the reserved file name on write (deliberately class-blind — a file keeps its name
 *  whoever owns it), and the create echo, which describes a write whose class that same
 *  call hard-wired.
 *  canon: docs/folder-page.md#model */
export const isFolderPageOf = (
  filePath: string | null | undefined,
  cls: NoteClass | undefined,
): boolean =>
  Boolean(filePath) &&
  isFolderPageNote(filePath as string) &&
  (cls ?? DEFAULT_NOTE_CLASS) === NOTE_CLASS.userDoc
