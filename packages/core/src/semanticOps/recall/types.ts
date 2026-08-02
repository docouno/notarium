// Domain types for the recall semantic op.

import type { KnowledgeStore, NoteClass } from '../../knowledgeStore'

/** Narrow a target's recall to ONE project: keep only user-docs under
 *  `pathPrefix` (the project's subtree — '' = the whole space, a root project) and
 *  agent-memory whose mount-subdir is `memorySubdir` (the project's
 *  `.notarium/memory/<id>/`). Closes the I1 oversight where a project hint recalled
 *  a SIBLING project's memory; about-USER memory (mount root) is excluded too — a
 *  project hint is a PURE project scope (the user's own memory comes from a
 *  hint-LESS recall / start_session, decided 2026-06-18). */
export type RecallNarrow = {
  /** Folder prefix the project's user-docs live under ('' = whole space). */
  pathPrefix: string
  /** The project id = its agent-mount memory subdir (`.notarium/memory/<id>/`). */
  memorySubdir: string
}

/** One space to recall over, as the gateway resolves it. `isPersonal` marks the
 *  caller's personal domain so its sources carry no `project` (R1). The store is
 *  already authorised (the gateway checked space:read) and read-model-wrapped
 *  (so search/graph honour the visibility invariant). */
export type RecallTarget = {
  slug: string
  isPersonal: boolean
  store: KnowledgeStore
  /** Project-scope narrowing. Absent = the whole space (a hint-less
   *  recall's full fan-out). */
  narrow?: RecallNarrow
  /** Resolve a source note → its project handle for the three-state output and the
   *  context label. Injected by the gateway (it owns the registry); the op
   *  stays registry-agnostic. Absent = no project labels (the pure-op unit tests). */
  projectOf?: (filePath: string, cls: NoteClass | undefined) => string | undefined
}

export type RecallOpInput = {
  query: string
  /** Token cap on the assembled bundle. */
  budgetTokens: number
  /** Graph hops around the seeds (0 = seeds only, no graph fetch). */
  depth: number
  /** Per-source token cap ("width"): the most any single note may
   *  contribute. Omitted → a safe default (half the budget, floored) so one large
   *  note never starves its neighbours. Always applied. */
  maxPerSource?: number
}

/** A note that fed the assembled context (pre-sanitise — the gateway defangs
 *  `title` on the way out). `space` absent = the personal domain; `project` is the
 *  three-state project handle the target's `projectOf` resolved (absent = not under
 *  a marked project / no resolver), round-tripping straight back into a tool input. */
export type RecallSourceItem = {
  noteId: string
  title: string
  space?: string
  project?: string
  /** The note's RAW space-relative storage path — the gateway strips `.md`
   *  and emits it as the source's `path`. Absent when the engine couldn't place it. */
  filePath?: string
  class?: NoteClass
}

export type RecallResult = {
  context: string
  sources: RecallSourceItem[]
  /** True when the budget capped the bundle (not when a note simply vanished
   *  between the snapshot and the read). */
  truncated: boolean
}

/** A candidate note pulled into the recall set, with the signals the ranker
 *  reads. hop 0 = an FTS seed (keeps its score); hop ≥1 = a graph neighbour
 *  (score 0). `sameCommunity` lifts a neighbour sharing a seed's graph
 *  community; it is always false for a seed (the boost is a neighbour signal). */
export type RecallCandidate = {
  noteId: string
  hop: number
  score: number
  sameCommunity: boolean
}
