// The projects service: the `.notariummeta` marker subsystem that turns a
// folder into an addressable project. The meta-DB `projects` facet is the
// derived cache; this layer owns the on-disk marker (the truth that travels) and
// the mark-as-project / boot-scan flows over it. See docs/projects.md.

export {
  MARKER_FILENAME,
  markerRelPath,
  parseMarker,
  serializeMarker,
  type MarkerFields,
  type MarkerType,
  type SpaceMarkerFacet,
} from './marker'
export {
  healSpaceMarker,
  provisionSpaceIdentity,
  recordSpaceRename,
  type RenameSpaceResult,
  type SpaceIdentityDeps,
} from './spaceIdentity'
export {
  createMarkerStore,
  discoverSpaceFolders,
  localFsAnchoredFiles,
  type MarkerAnchoredFilesFactory,
  type MarkerAnchoredFileView,
  type MarkerHit,
  type MarkerScan,
  type MarkerStore,
  type MarkerStoreOptions,
  readRootMarker,
  type SpaceFolderHit,
} from './markerStore'
export {
  ensureFolderIdentity,
  finalizeFolderMove,
  recordFolderRename,
  type FinalizeFolderMoveDeps,
  type RecordFolderRenameDeps,
} from './folderIdentity'
export { acquireMarkPrefixLock, withMarkLock } from './markLock'
export {
  markFolderAsProject,
  renameProjectSlug,
  unmarkProject,
  type MarkFolderDeps,
  type MarkFolderInput,
  type MarkFolderResult,
  type RenameProjectResult,
} from './markProject'
export { projectHandleOf, projectSummaryOf } from './projection'
export { lastSegment, mintSlug } from './slug'
export { scanProjectsAtBoot, type BootScanDeps } from './bootScan'
