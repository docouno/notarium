export { SpaceManager } from './spaceManager'
export { spaceNotFound } from './errors'
export { resolveSpaceRecord } from './spaceResolver'
export type { DiscoveredSpace, SpaceDef, SpaceManagerOptions, SpaceStore } from './types'
export {
  ensurePersonalSpace,
  ensurePersonalSpaceFor,
  peekPersonalSpace,
  type PersonalSpaceDeps,
} from './personalSpace'
export {
  ALWAYS_LOAD_TAG,
  listMemoryCategories,
  readProfileNote,
  writeProfileNote,
} from './personalContent'
export {
  type CuratableMemory,
  curatePersonalScope,
  curateProjectScope,
  loadedContextNotes,
  type CuratedPin,
  type CuratedSet,
  type CuratedRoleScope,
  type RoleScopeInput,
  PERSONAL_TOKEN_BUDGET,
  personalProfilePin,
  PROJECT_TOKEN_BUDGET,
  projectIndexSummary,
  resolveContextSets,
  resolveScopePins,
  type ScopeOrder,
  SCOPE_ITEM_CAP,
  setNoteMuted,
  setNotePinned,
  weighAlwaysLoad,
  type WeighedPin,
  type WeighedSet,
  type WeighedSetItem,
} from './agentContext'
