export { SpaceManager } from './spaceManager'
export { spaceNotFound } from './errors'
export { setNoteFields, type SetNoteFieldsInput } from './noteFields'
export { resolveSpaceRecord } from './spaceResolver'
export type { DiscoveredSpace, SpaceDef, SpaceManagerOptions, SpaceStore } from './types'
export {
  ensurePersonalSpace,
  ensurePersonalSpaceFor,
  followPersonalSpaceRename,
  peekPersonalSpace,
  personalSlugBase,
  personalSlugFollows,
  type PersonalSpaceDeps,
  type PersonalSpaceOwner,
  type PersonalSpaceRenameDeps,
  type PersonalSpaceRenameOutcome,
} from './personalSpace'
export { renameSpace, type RenameSpaceDeps, type RenameSpaceOutcome } from './renameSpace'
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
  enqueueConditionalNotePin,
  loadedContextNotes,
  type CuratedPin,
  type CuratedSet,
  type CuratedRoleScope,
  type RoleScopeInput,
  type ScopeSetInput,
  type ScopeSetRefs,
  scopeLayerOrder,
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
