/** Why a frontmatter block's bytes are not safely writable: the parser's entries no
 *  longer describe them (`geometry`), or the entry a writer targets defines a YAML anchor
 *  a neighbouring field aliases (`anchored`). */
export type FrontmatterGeometryReason = 'geometry' | 'anchored'

/** A writer may not touch these bytes. Terminal, not a race: re-reading the same source
 *  reaches the same answer, so a caller degrades instead of retrying. Typed apart from
 *  `FrontmatterLimitError` — that one says the block is too big to read, this one says the
 *  block reads fine and still may not be rewritten. */
export class FrontmatterGeometryError extends Error {
  constructor(readonly reason: FrontmatterGeometryReason) {
    super(`frontmatter is not safely writable: ${reason}`)
    this.name = 'FrontmatterGeometryError'
  }
}
