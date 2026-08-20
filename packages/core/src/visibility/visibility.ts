// The class-visibility invariant: a note's class carries a MATRIX of policies, enforced at ONE
// read-model chokepoint (never an obviable per-query WHERE). This module answers the two questions
// the read-model asks: is class C visible on surface S, and which classes does scope X admit.
// canon: docs/note-model.md#note-classes · docs/core.md#read-model

import { NOTE_CLASS, READ_SCOPE } from '../knowledgeStore'
import type { NoteClass, ReadScope } from '../knowledgeStore'
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
