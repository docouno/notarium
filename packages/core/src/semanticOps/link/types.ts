// Domain types for the link semantic op.

export type LinkInput = {
  /** The note-id to link FROM — the wikilink is materialized in its body. */
  fromId: string
  /** The display title of the note to link TO. The transport resolves the `to`
   *  ref to this; we materialize `[[<toTitle>]]` because the graph resolves a
   *  wikilink by slugged title (not note-id). */
  toTitle: string
  /** The relation type (e.g. "depends_on") — preserved in the body line. */
  relation: string
  /** Journal attribution — the gateway stamps the agent's principal. */
  principal?: string
}

/** One edge to materialize from a note's body — a (relation, target-title) pair.
 *  The target is a TITLE (the graph resolves a wikilink by slugged title), which
 *  may not name an existing note yet (a forward-reference resolves once it does). */
export type LinkSpec = { toTitle: string; relation: string }

/** Several edges from ONE note (batch): read the source once, splice every
 *  link in, write once. The big round-trip win for graph-building — N edges from a
 *  note cost one write, not N. */
export type LinkManyInput = {
  fromId: string
  links: LinkSpec[]
  principal?: string
}
