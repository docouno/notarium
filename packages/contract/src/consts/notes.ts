export const NOTE_SORT = {
  created: 'created',
  modified: 'modified',
  title: 'title',
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
export type DateField = (typeof DATE_FIELD)[keyof typeof DATE_FIELD]
export type BucketGran = (typeof BUCKET_GRAN)[keyof typeof BUCKET_GRAN]

export const DEPTH = { subtree: 'subtree', direct: 'direct' } as const

export type Depth = (typeof DEPTH)[keyof typeof DEPTH]
