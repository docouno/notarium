// Import: convert a Claude / ChatGPT / MCP-memory export into notes. The
// parsers here are PURE (string → ImportNote[]): no store, no IO, no engine — the
// mirror-image of export's host-edge transform, but richer. The host (server)
// composes them: parse (here) → store.write per note (the canonical write path).
// One conversation/entity → one note; idempotency is identity-aware
// (deterministic per-source filenames) rather than clobber-by-path.

import type { FrontmatterEntry } from '../libs/markdown'
import type { ImportFormat, ImportSource } from './consts'
/** One note an importer wants created — the normalised handoff to the write
 *  path. The host maps this onto a WriteInput: `title`/`tags`/`directory` ride
 *  the usual create channels; `createdAt`/`fileName`/`frontmatter` ride the
 *  host-internal write channels. Provenance is carried by `tags` (e.g. `claude`);
 *  the parser derives the deterministic `fileName` from the source id internally. */
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
  /** Explicit filename (sans `.md`) the note lands under — deterministic per
   *  source so a re-import overwrites the SAME file (idempotent) and same-titled
   *  items never collide. Overrides the default `slug(title)`. */
  fileName: string
  /** The tool family this note came from — drives the memory-destination routing
   *  (a `memory` note can go to the agent mount). */
  source: ImportSource
  /** The source file's OWN frontmatter, minus the keys lifted into the typed
   *  fields above and minus any `notarium-id` claim (#280). Carried as raw entries
   *  so a key we don't model — a nested map, a plugin's field — survives the write
   *  byte-for-byte: Notarium is file-first, and we are not the owner of the user's
   *  file. Only the `markdown` format fills this; an AI export has no frontmatter
   *  of its own. canon: docs/import.md#drag-and-drop-of-text-files-223 */
  frontmatter?: readonly FrontmatterEntry[]
}

/** What parsing one uploaded file yields: the detected format, the notes to
 *  create, and any non-fatal skips worth surfacing in the summary. */
export type ImportParseResult = {
  format: ImportFormat
  notes: ImportNote[]
  warnings: string[]
}
