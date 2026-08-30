import type { BucketGran, NoteSort } from '@notarium/contract'
import type { SaveInput } from '../../libs/wire'

export type FolderPageCreateInput = Pick<
  SaveInput,
  'content' | 'noteType' | 'tags' | 'fields' | 'slug' | 'createdAt'
>

/** GET …/notes window params (#64) — mirrors the contract's NotesQuery.
 *  No params = the whole base (folder-scoped consumers genuinely want that);
 *  window consumers (Feed) always pass offset+limit. */
export type NotesQueryParams = {
  sort?: NoteSort
  offset?: number
  limit?: number
  folder?: string
  depth?: 'subtree' | 'direct'
  /** Folder filter set (#93/#109 inclusion): keep notes under any selected subtree
   *  — the Feed/Graph folder facet. Each rides as a repeated `folders` query key. */
  folders?: string[]
  /** Tag filter (#109): keep notes carrying any listed tag (OR, hierarchical).
   *  Each rides as a repeated `tags` query key. */
  tags?: string[]
  field?: string[]
  fieldDay?: string[]
  fieldAny?: string[]
  fieldBad?: string[]
  /** Full-text membership filter (#190): keep only notes matching this query —
   *  one more filter alongside folders/tags (the window/total/histogram all
   *  describe the q-narrowed population). Empty/absent = no text filter. */
  q?: string
  /** Date range filter (#201): local `YYYY-MM-DD` bounds, inclusive. `tz` is filled
   *  when a range is active so the server applies the user's calendar days. */
  from?: string
  to?: string
  tz?: number
  dateField?: 'created' | 'modified'
  /** Favorite note facet (#42): keep only notes pinned by the current principal. */
  favorite?: boolean
  /** Decorate each note with its warm cached preview (or null) — Feed only. */
  preview?: boolean
}

/** GET …/notes/buckets params — the date histogram of a notes query (#64).
 *  Same scope as the matching notes window; `tz` (client UTC offset, minutes
 *  east) is filled in here so callers never think about timezones. */
export type BucketsQueryParams = {
  sort?: 'created' | 'modified'
  group: BucketGran
  folder?: string
  depth?: 'subtree' | 'direct'
  /** Same folder filter set as the matching notes window (#93/#109 inclusion). */
  folders?: string[]
  /** Same tag filter as the matching notes window (#109). */
  tags?: string[]
  field?: string[]
  fieldDay?: string[]
  fieldAny?: string[]
  fieldBad?: string[]
  /** Same full-text membership filter as the matching notes window (#190). */
  q?: string
  /** Same date range filter as the matching notes window (#201). */
  from?: string
  to?: string
  dateField?: 'created' | 'modified'
  /** Same favorite note facet as the matching notes window (#42). */
  favorite?: boolean
}
