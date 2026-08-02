// Domain constants for the class-visibility policy — a pure zod-free sink.

/** A discovery SURFACE the visibility matrix answers for.
 *  canon: docs/note-model.md#note-classes */
export const SURFACE = {
  feed: 'feed',
  tree: 'tree',
  userSearch: 'userSearch',
  graph: 'graph',
  agentRecall: 'agentRecall',
} as const

/** The read-facing policy columns — the surfaces the visibility invariant gates. */
export type Surface = (typeof SURFACE)[keyof typeof SURFACE]
