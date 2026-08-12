export const AUTHOR_KIND = {
  agent: 'agent',
  user: 'user',
  system: 'system',
  external: 'external',
} as const

export const NOTE_CLASS = {
  userDoc: 'user-doc',
  attachment: 'attachment',
  derived: 'derived',
  agentMemory: 'agent-memory',
  profile: 'profile',
  skill: 'skill',
} as const

export const REVISION_KIND = {
  write: 'write',
  external: 'external',
  restore: 'restore',
  merge: 'merge',
  delete: 'delete',
} as const

/** Why a journal entry is served as a GAP rather than a state — the wire twin of
 *  the core constant. One value today; the field exists so a future reason is an
 *  additive change rather than a new shape. canon: docs/note-history.md#model */
export const REVISION_UNAVAILABLE_REASON = { identityConflict: 'identity-conflict' } as const

export const PROJECT_STATUS = {
  active: 'active',
  archived: 'archived',
} as const

export const ROLE_SCOPE = {
  catalog: 'catalog',
  personal: 'personal',
  space: 'space',
  project: 'project',
} as const

export type NoteClass = (typeof NOTE_CLASS)[keyof typeof NOTE_CLASS]
export type AuthorKind = (typeof AUTHOR_KIND)[keyof typeof AUTHOR_KIND]
export type RevisionKind = (typeof REVISION_KIND)[keyof typeof REVISION_KIND]
export type RevisionUnavailableReason =
  (typeof REVISION_UNAVAILABLE_REASON)[keyof typeof REVISION_UNAVAILABLE_REASON]
export type ProjectStatus = (typeof PROJECT_STATUS)[keyof typeof PROJECT_STATUS]
export type RoleScope = (typeof ROLE_SCOPE)[keyof typeof ROLE_SCOPE]
