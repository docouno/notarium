// The chunker seam (P13): how a note's text is split into the units that get
// embedded. A capability of the engine, swappable behind this type — the store
// speaks ONLY this surface, never a concrete splitter. `version` folds into the
// embedding index key (`content_hash × embedder_id × chunker_version`, P13): a
// chunker that splits differently produces different units, so its vectors are
// NOT comparable to the old ones — a changed `version` means rebuild the vector
// partition, never silently reuse.
//
// The default is the heading-first chunker (split by headings, breadcrumb prefixes,
// overlap; 'heading-v1') — a strict superset of the original whole-note chunker (one
// chunk per note), which is kept behind this same seam as the no-heading degenerate
// case and for tests. A different splitter bumps `version` and rebuilds the partition.

/** What the chunker is handed: the note's title and normalized body (read()'s
 *  view — frontmatter split off, title heading stripped). The chunker decides
 *  how (and whether) to fold the title into each chunk's text. */
export type ChunkInput = {
  title: string
  body: string
}

/** One embeddable unit. `index` is its position within the note (0-based),
 *  carried into the vec row as the aux `chunk_index` so a hit can point back at
 *  which part of the note matched (Stage 3 snippets). `text` is exactly what is
 *  fed to the embedder. */
export type Chunk = {
  index: number
  text: string
}

export type Chunker = {
  /** Stable identity of the splitting strategy, part of the embedding key (P13).
   *  Change the algorithm → bump this → the vector partition rebuilds. */
  readonly version: string
  /** Split a note into embeddable chunks, in order. Always returns at least one
   *  chunk for a non-empty note; an empty note yields no chunks (nothing to
   *  embed). Pure and deterministic — the same input must always yield the same
   *  chunks, since `content_hash` is computed from the chunker's OUTPUT (these
   *  chunks): a non-deterministic split would churn the hash and force needless
   *  re-embeds. */
  chunk(input: ChunkInput): Chunk[]
}
