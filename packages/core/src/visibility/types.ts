/** The full per-class policy set. The read columns
 *  (feed/tree/userSearch/graph/agentRecall) drive visibility; index/versioned/
 *  replicate/providerEgress are policy axes consumers read directly. */
export type ClassPolicy = {
  /** In the derived FTS/vector index? (agent-memory is indexed — agentRecall
   *  needs it — yet hidden from user surfaces: index ≠ visible.) */
  index: boolean
  /** Participates in the user wikilink graph? */
  graph: boolean
  /** Shown in the user Feed? */
  feed: boolean
  /** Shown in the user file tree? */
  tree: boolean
  /** In user full-text search? */
  userSearch: boolean
  /** Reachable by the agent via `recall`? */
  agentRecall: boolean
  /** Journaled? */
  versioned: boolean
  /** Synced between stores/devices? */
  replicate: boolean
  /** May the note content cross the model-provider egress boundary? */
  providerEgress: boolean
}
