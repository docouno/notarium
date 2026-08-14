export const NOTE_SORT = {
  created: 'created',
  modified: 'modified',
  title: 'title',
} as const

export const SORT_DIR = {
  asc: 'asc',
  desc: 'desc',
} as const

export const DATE_FIELD = {
  created: 'created',
  modified: 'modified',
} as const

export const BUCKET_GRAN = {
  day: 'day',
  week: 'week',
  month: 'month',
} as const

export type NoteSort = (typeof NOTE_SORT)[keyof typeof NOTE_SORT]
export type SortDir = (typeof SORT_DIR)[keyof typeof SORT_DIR]
export type DateField = (typeof DATE_FIELD)[keyof typeof DATE_FIELD]
export type BucketGran = (typeof BUCKET_GRAN)[keyof typeof BUCKET_GRAN]

export const DEPTH = { subtree: 'subtree', direct: 'direct' } as const

export type Depth = (typeof DEPTH)[keyof typeof DEPTH]

/** What a create asks for when a note already occupies its destination. The
 *  domain knows a third policy — `overwrite` — that is deliberately NOT on the
 *  wire: clobbering another note's bytes stays a host-internal capability
 *  (idempotent re-import), unreachable from any client.
 *  canon: docs/note-model.md#create-collisions */
export const IF_EXISTS = {
  fail: 'fail',
  uniquify: 'uniquify',
} as const

export type IfExists = (typeof IF_EXISTS)[keyof typeof IF_EXISTS]
