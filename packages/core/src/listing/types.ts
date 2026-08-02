// The list-layer's domain shapes: the folder skeleton, note/tree windows
// and facet payloads the pure list functions return. Domain twins of the wire
// schemas — neutral keys, the mapper is identity.
// canon: docs/core.md#list-layer

import type { NoteMeta } from '../knowledgeStore'
import type { TagFacetNode } from '../libs/tags'

/** One folder of the tree skeleton (domain twin of the wire's TreeFolder —
 *  the keys are neutral, the mapper is identity). `id` is present once a folder is
 *  identified (moved, project, materialised folder-page, or favorited) so the
 *  client can link stable `/folder/<id>` URLs; `aliases` ride only when it has past
 *  paths, for `/files/<oldpath>` redirects and `[[oldpath/note]]` resolution. */
export type TreeFolder = {
  path: string
  name: string
  count: number
  direct: number
  id?: string
  aliases?: string[]
  /** This folder's PAGE note id — a visible `index.md` is its body. The page
   *  itself is hidden from the folder's children (it's the cover, not a child), so
   *  the tree/breadcrumb can show it as a page and the folder surface can render its
   *  body without a second round-trip. Absent => virtual folder page until Save. */
  pageNoteId?: string
}

export type TreeSummary = {
  folders: TreeFolder[]
  stats: { total: number; root: number; week: number }
}

export type BucketCounts = {
  buckets: Array<{ key: string; count: number }>
  total: number
}

/** The tag facet tree: `TagFacetNode` (folded `tag` path + display
 *  `label` + subtree `count` + `direct` exact-tag count) lives in libs/tags
 *  beside its shared builder; the endpoint wraps the node list with a `total`
 *  (distinct nodes before the top-N cut, so the UI can show "+N more"). */
export type TagFacet = { tags: TagFacetNode[]; total: number }

/** Domain shape of one /api/notes window — wire's NotesResponse modulo the id
 *  divergence (NoteMeta.id is optional until the identity layer stamps it;
 *  the wire schema enforces presence at the boundary). */
export type NotesWindow = { notes: NoteMeta[]; total: number }

/** Domain shape of one /api/tree/children step (same id caveat). */
export type TreeChildrenWindow = { folders: TreeFolder[]; notes: NoteMeta[]; total: number }
