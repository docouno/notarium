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

export const ABILITY_KIND = {
  role: 'role',
  skill: 'skill',
} as const

export const ABILITY_SOURCE = {
  system: 'system',
  catalog: 'catalog',
  owned: 'owned',
} as const

export const ABILITY_ORIGIN = {
  custom: 'custom',
  catalog: 'catalog',
} as const

export const ABILITY_AVAILABILITY_MODE = {
  allProjects: 'all-projects',
  selectedProjects: 'selected-projects',
} as const

export const ABILITY_ATTACHMENT_HEALTH = {
  healthy: 'healthy',
  missing: 'missing',
  disabled: 'disabled',
  unavailable: 'unavailable',
  invalidLocator: 'invalid-locator',
  wrongKind: 'wrong-kind',
} as const

/** The longest search a package-library request can carry. Stated here rather than
 *  only inside the schema so the SURFACE that composes the request can hold to it: a
 *  query the client cannot ask must not reach the wire as a validation failure that
 *  empties the whole listing. */
export const AGENT_PACKAGE_LIBRARY_QUERY_MAX = 200

export type NoteClass = (typeof NOTE_CLASS)[keyof typeof NOTE_CLASS]
export type AuthorKind = (typeof AUTHOR_KIND)[keyof typeof AUTHOR_KIND]
export type RevisionKind = (typeof REVISION_KIND)[keyof typeof REVISION_KIND]
export type RevisionUnavailableReason =
  (typeof REVISION_UNAVAILABLE_REASON)[keyof typeof REVISION_UNAVAILABLE_REASON]
export type ProjectStatus = (typeof PROJECT_STATUS)[keyof typeof PROJECT_STATUS]
export type RoleScope = (typeof ROLE_SCOPE)[keyof typeof ROLE_SCOPE]
export type AbilityKind = (typeof ABILITY_KIND)[keyof typeof ABILITY_KIND]
export type AbilitySource = (typeof ABILITY_SOURCE)[keyof typeof ABILITY_SOURCE]
export type AbilityOrigin = (typeof ABILITY_ORIGIN)[keyof typeof ABILITY_ORIGIN]
export type AbilityAvailabilityMode =
  (typeof ABILITY_AVAILABILITY_MODE)[keyof typeof ABILITY_AVAILABILITY_MODE]
export type AbilityAttachmentHealth =
  (typeof ABILITY_ATTACHMENT_HEALTH)[keyof typeof ABILITY_ATTACHMENT_HEALTH]

/** The exact storage-address form a host mints for a package. `core` states the same
 *  two facts for the runtime that produces them; P8 keeps the pair as two copies rather
 *  than a runtime edge, and `test/enumDrift.test.ts` reconciles them. */
export const GENERATED_ID_LENGTH = 12
export const GENERATED_ID = /^[A-Za-z0-9_-]+$/
