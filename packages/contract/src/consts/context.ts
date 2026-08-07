export const CONTEXT_KIND = {
  personal: 'personal',
  project: 'project',
  role: 'role',
} as const

export const CONTEXT_ENTRY_KIND = {
  pin: 'pin',
  set: 'set',
} as const

export type ContextKind = (typeof CONTEXT_KIND)[keyof typeof CONTEXT_KIND]
export type ContextEntryKind = (typeof CONTEXT_ENTRY_KIND)[keyof typeof CONTEXT_ENTRY_KIND]
