export const ACTIVITY_EVENT_KIND = {
  created: 'created',
  edited: 'edited',
  restored: 'restored',
  deleted: 'deleted',
} as const

export type ActivityEventKind = (typeof ACTIVITY_EVENT_KIND)[keyof typeof ACTIVITY_EVENT_KIND]
