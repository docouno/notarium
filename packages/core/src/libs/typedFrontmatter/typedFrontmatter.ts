// The typed write channels the note has no metadata field of its own for: a
// frontmatter key is their only home, so the index column is the only place a
// filter can read them back from. One answer to "is the key written, with what
// value, and when is it cleared" — the file bytes and the optimistic snapshot are
// two readers of it, never two implementations.
// canon: docs/note-model.md#note-ontology

import { type FrontmatterEntry, frontmatterScalarEntry } from '../markdown'
import { DEFAULT_NOTE_TYPE, normalizeNoteType } from '../noteType'

/** One channel's verdict about the key it owns: the entry to merge into the block,
 *  or `null` to take the key out of the note entirely. A channel that says nothing
 *  (three-state `undefined`) produces no emission at all and leaves the file's key
 *  as it stands. */
export type TypedFrontmatterEmission = {
  key: string
  entry: FrontmatterEntry | null
}

export type TypedFrontmatterChannels = {
  noteType?: string
  viewType?: string
  summary?: string
  muted?: boolean
}

/** The implicit type is never spelled in a file, so resetting a note to it CLEARS
 *  the key rather than writing it back. */
export const noteTypeFrontmatter = (noteType?: string): TypedFrontmatterEmission | undefined =>
  noteType === undefined
    ? undefined
    : (() => {
        const normalized = normalizeNoteType(noteType)

        return {
          key: 'type',
          entry:
            normalized !== DEFAULT_NOTE_TYPE ? frontmatterScalarEntry('type', normalized) : null,
        }
      })()

export const viewTypeFrontmatter = (viewType?: string): TypedFrontmatterEmission | undefined =>
  viewType === undefined
    ? undefined
    : {
        key: 'view',
        entry: viewType.trim() ? frontmatterScalarEntry('view', viewType.trim()) : null,
      }

/** An empty digest is an explicit clear, not an empty value. */
export const summaryFrontmatter = (summary?: string): TypedFrontmatterEmission | undefined =>
  summary === undefined
    ? undefined
    : {
        key: 'summary',
        entry: summary ? frontmatterScalarEntry('summary', summary) : null,
      }

/** Emitted through the scalar emitter, which is why the corpus carries the opt-out
 *  as the quoted `muted: "true"` and the read side normalises both spellings.
 *  `false` is an explicit un-mute and clears the key. */
export const mutedFrontmatter = (muted?: boolean): TypedFrontmatterEmission | undefined =>
  muted === undefined
    ? undefined
    : {
        key: 'muted',
        entry: muted ? frontmatterScalarEntry('muted', 'true') : null,
      }

/** All three channels in the order the serializer merges them into the block —
 *  below the authored keys, so they win over an incoming key of the same name. A
 *  mirror of the write reproduces that order to project what the file will say. */
export const indexedTypedFrontmatter = (
  channels: TypedFrontmatterChannels,
): TypedFrontmatterEmission[] =>
  [
    noteTypeFrontmatter(channels.noteType),
    viewTypeFrontmatter(channels.viewType),
    summaryFrontmatter(channels.summary),
    mutedFrontmatter(channels.muted),
  ].filter((emission): emission is TypedFrontmatterEmission => emission !== undefined)
