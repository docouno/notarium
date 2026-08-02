/** One node of the tag facet: a folded `tag` path, the author's `label`
 *  casing for display, the whole-subtree `count` and the `direct` (exactly this
 *  tag) count. Structurally the contract's TagFacet — kept here so the builder is
 *  host-agnostic (core libs ↛ contract) and shared by the server facet and the
 *  client graph. */
export type TagFacetNode = { tag: string; label: string; count: number; direct: number }
