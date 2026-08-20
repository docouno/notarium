// Import: convert a Claude / ChatGPT / MCP-memory export into notes. The
// parsers here are PURE (string → ImportRecordOutcome[]): no store, no IO, no engine — the
// mirror-image of export's host-edge transform, but richer. The host (server)
// composes them: parse (here) → store.write per note (the canonical write path).
// One source record → one note/failure/skip; source-addressable identity is
// separate from its deterministic path representation.

import type { FrontmatterEntry } from '../libs/markdown'
import type { ImportFormat, ImportSource } from './consts'
/** One note an importer wants created — the normalised handoff to the write
 *  path. The host maps this onto a WriteInput: `title`/`tags`/`directory` ride
 *  the usual create channels; `createdAt`/`fileName`/`frontmatter` ride the
 *  host-internal write channels. Provenance is carried by `tags` (e.g. `claude`)
 *  and, for source-addressable formats, the reserved source locator. */
export type ImportNote = {
  title: string
  /** The note body as markdown — NO leading `# title` heading (the write path
   *  adds the storage-format heading) and NO frontmatter (what the source file
   *  carried rides `frontmatter` below, parsed, not smuggled in the text). */
  body: string
  /** Space-relative target folder (e.g. `conversations/claude`). */
  directory: string
  tags?: string[]
  /** Free-form frontmatter `type` (e.g. `conversation`, `person`). */
  noteType?: string
  /** Original creation instant (ISO-8601 UTC) — threaded so the engine dates the
   *  note by when the conversation HAPPENED, not when it was imported.
   *  `modified` is deliberately NOT threaded: it stays the file's real mtime
   *  (= import time, then real edit times) so it never goes stale or flips. */
  createdAt?: string
  /** Explicit canonical filename (sans `.md`). Source-aware re-import resolves
   *  by locator; this remains its deterministic portable first placement. */
  fileName: string
  /** The tool family this note came from — drives the memory-destination routing
   *  (a `memory` note can go to the agent mount). */
  source: ImportSource
  /** Canonical source identity for source-addressable foreign records. Absent
   * for Markdown and memory formats, which retain their own identity models. */
  sourceLocator?: string
  /** Relative predecessor placement from the pre-source-locator importer. The
   * host joins its own root/class exactly once and uses it only as a refusal
   * fence; it is never a fallback destination. */
  legacyDirectory?: string
  legacyFileName?: string
  /** The source file's OWN frontmatter, minus the keys lifted into the typed
   *  fields above and minus any `notarium-id` claim (#280). Carried as raw entries
   *  so a key we don't model — a nested map, a plugin's field — survives the write
   *  byte-for-byte: Notarium is file-first, and we are not the owner of the user's
   *  file. Only the `markdown` format fills this; an AI export has no frontmatter
   *  of its own. canon: docs/import.md#drag-and-drop-of-text-files-223 */
  frontmatter?: readonly FrontmatterEntry[]
  /** The identity the source file CLAIMED (`notarium-id:`), when it is a valid
   *  durable scalar. It is a KEY, never a claim: a tree import maps it to the
   *  fresh identity the copy receives, so exact `[[notarium-id:…]]` links between
   *  two imported notes keep pointing at each other. It never reaches the write
   *  path — importing is a copy, and an identity is not the author's to donate.
   *  canon: docs/import.md#importing-a-markdown-tree-302 */
  sourceId?: string
  /** Set when the file carried a `notarium-id` we could NOT read as an identity
   *  (empty, a list, a nested map). The note still imports, with a fresh identity
   *  and no link mapping — but the skip is visible rather than silent. */
  sourceIdentityWarning?: string
}

export type ImportRecordFailure = { title: string; error: string }

export type ImportRecordOutcome =
  | { kind: 'note'; note: ImportNote }
  | { kind: 'failure'; failure: ImportRecordFailure }
  | { kind: 'skip'; reason: string }

/** What parsing one uploaded file yields: the detected format, the notes to
 *  create, and any non-fatal skips worth surfacing in the summary. */
export type ImportParseResult = {
  format: ImportFormat
  notes: ImportNote[]
  failures: ImportRecordFailure[]
  warnings: string[]
}
