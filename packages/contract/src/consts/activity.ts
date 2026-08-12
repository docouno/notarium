export const ACTIVITY_EVENT_KIND = {
  created: 'created',
  edited: 'edited',
  restored: 'restored',
  deleted: 'deleted',
  /** A journal GAP (#327): real activity whose kind cannot be classified without
   *  reading a payload the row withholds. Never attributed to an author. */
  unavailable: 'unavailable',
} as const

export type ActivityEventKind = (typeof ACTIVITY_EVENT_KIND)[keyof typeof ACTIVITY_EVENT_KIND]
