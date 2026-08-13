export type {
  FileClaim,
  FileObservation,
  FilePackagePublicationRequest,
  FileProofTransition,
  FilePublicationRequest,
  FilePublicationResult,
  FileStat,
  FileStore,
  FileStrictMutationReceipt,
  FileStrictPublication,
  FileStrictPublicationResult,
  FileStrictStageHeader,
  FileStrictStageRequest,
  FileStrictStageResult,
  FileStrictStageState,
} from './types'
export { createLocalFsFiles } from './localFs'
// The provider, not the primitive: composition asks whether this deployment can
// do it, and the raw call is reachable only by module path. Leaving both on the
// barrel makes the shorter name the obvious import — and calling it
// unconditionally is the defect this module exists to prevent.
export { renameNoReplaceIfAvailable } from './renameNoReplace'
