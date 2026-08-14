// Every ceiling the import service enforces, in one place. An untrusted archive
// is adversarial input: each limit below is a boundary a hostile ZIP would
// otherwise cross to exhaust disk, RAM or the plan representation.
// canon: docs/import.md#resource-limits-on-a-markdown-tree-302

/** Decompressed-size cap per ZIP member — zip-bomb guard (a small archive can't
 *  inflate to fill the disk). Well above a real 600 MB export's ~1–2 GB member. */
export const MEMBER_BYTE_CAP = 6 * 1024 * 1024 * 1024

/** Total bytes the classification pass may inflate into temp while answering
 *  "is this archive a recognised foreign export?".
 *
 *  The per-member cap above bounds ONE probe; this bounds all of them together,
 *  and that is a different threat. A tree ceiling stops a plan from growing, but
 *  the foreign question outlives every one of them — it is still being asked after
 *  a tree ceiling has fired — so without an aggregate of its own an archive of a
 *  thousand JSON members is a thousand per-member caps' worth of disk. */
export const MAX_PROBE_EXPANDED_BYTES = 6 * 1024 * 1024 * 1024

/** Cap for the single-object memory shape, which must be read whole (a JSON
 *  object's sub-arrays can't be streamed element-wise). MCP graphs are tiny. */
export const MEMORY_OBJECT_CAP = 256 * 1024 * 1024

/** A dropped text/markdown file is one note, read whole and bounded by this cap.
 *  canon: docs/import.md#drag-and-drop-of-text-files-223 */
export const TEXT_FILE_CAP = 64 * 1024 * 1024

/** Central-directory entries a Markdown-tree archive may declare — directories
 *  and container noise included. The count itself is the attack surface: 100k
 *  headers cost nothing to author and a plan entry each to hold. */
export const MAX_ARCHIVE_ENTRIES = 100_000

/** Total uncompressed bytes a Markdown-tree archive may expand to, counting
 *  EVERY regular member. Ignored attachments are part of the archive's cost even
 *  though none of their bytes are kept. */
export const MAX_MARKDOWN_TREE_EXPANDED_BYTES = 6 * 1024 * 1024 * 1024

/** Hard cap on the plan/archive representation itself — the one structure that
 *  grows with the entry COUNT rather than with the bytes we stream past. */
export const MAX_MARKDOWN_TREE_METADATA_BYTES = 32 * 1024 * 1024

/** Suspicious compression: a member claiming to inflate more than this is a zip
 *  bomb by any honest measure. The same ceiling guards the backup contour
 *  (`libs/dataBackup`), deliberately one number for one threat. */
export const MAX_COMPRESSION_RATIO = 10_000

/** Charged for every central-directory entry on top of its encoded name, and
 *  again for a planned entry's serialized shape: JSON delimiters, the map key
 *  and the bookkeeping a real representation costs beyond its payload. */
export const PLAN_ENTRY_OVERHEAD_BYTES = 256

/** Reserved per planned entry for what identity settlement adds AFTER preflight:
 *  `targetId`, `expectedDestinationId` and `ownership`, with their keys and
 *  delimiters. Preflight bounds the plan it can see, but the sidecar that is
 *  actually written is the settled one — and nothing weighs that one again on the
 *  way to disk. Held as an EARLY forecast by a test that measures ordinary
 *  settlement growth; the exact serialized sidecar is measured again after
 *  settlement and is the authoritative ceiling.
 *
 *  Sized from the growth itself rather than from a round number: settlement writes
 *  TWO ids per entry, so an entry grows by `74 + 2 × idLength` bytes. The ids are
 *  not ours to predict — `targetId` is taken from whoever already holds the
 *  destination, and `isValidNoteId` puts no ceiling on length — so the reserve
 *  covers ids of up to ~75 characters (a UUID, a hash, a foreign vault's own
 *  identifier). The previous 128 covered 27, which measured against Notarium's own
 *  12-character ids and silently under-reserved for every longer one. An existing
 *  id has no formal length ceiling, which is why this reserve cannot be the final
 *  proof. */
export const PLAN_SETTLED_ENTRY_BYTES = 224

/** Shared cap on every DETAIL collection in an import summary (`files`,
 *  `errors`, ignored samples, `created`). Totals are counted separately and stay
 *  exact — the cap bounds what a 10 000-note import can put on the wire and in
 *  the DOM, not what it reports. */
export const IMPORT_DETAIL_CAP = 200

/** Notes between progress heartbeats — keeps a long import alive against the
 *  endpoint idle-timeout and gives cancel a bounded reaction window. */
export const IMPORT_PROGRESS_EVERY = 200

/** Import job phases, in the order a durable run reports them. `planning` covers
 *  the whole zero-write classification/preflight pass; only `writing` is allowed
 *  to touch the store. */
export const IMPORT_PHASE = {
  planning: 'planning',
  writing: 'writing',
  done: 'done',
} as const

export type ImportPhase = (typeof IMPORT_PHASE)[keyof typeof IMPORT_PHASE]

/** How a ZIP was classified before the first write. The decision is made once,
 *  over the whole central directory, and never revised mid-run. */
export const ARCHIVE_KIND = {
  foreign: 'foreign',
  markdownTree: 'markdown-tree',
} as const

export type ArchiveKind = (typeof ARCHIVE_KIND)[keyof typeof ARCHIVE_KIND]
