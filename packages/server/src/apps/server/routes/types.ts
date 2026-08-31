import type { ReaderRegistry } from '@notarium/core'
import type { ArtifactStore } from '../../../libs/artifactStore'
import type { BuildInfo } from '../../../libs/buildInfo'
import type { HostInfo } from '../../../libs/hostInfo'
import type { ImportStagingStore } from '../../../libs/importStaging'
import type { AbilitiesService } from '../../../services/abilities'
import type { AuthService } from '../../../services/auth'
import type { FieldSchemaStore } from '../../../services/fields'
import type {
  AgentCallTracePersistence,
  AgentSessionAuditPersistence,
  AgentSessionsPersistence,
  ContextOrderPersistence,
  ContextSetsPersistence,
  FavoritesPersistence,
  FolderIdentityPersistence,
  JobsPersistence,
  ProjectsPersistence,
  RetrievalLogPersistence,
  ScopePinsPersistence,
  SpacesPersistence,
} from '../../../services/metaDb'
import type { BulkRestoreCoordinator, RestoreCoordinator } from '../../../services/noteRestore'
import type { MarkerStore } from '../../../services/projects'
import type { ProviderRegistry } from '../../../services/providerRegistry'
import type { RolesService } from '../../../services/roles'
import type { SpaceManager } from '../../../services/spaces'
import type { ViewSourceRegistry } from '../../../services/views/sourceRegistry'
import type { ViewProjectionAdapters } from '../../../services/views/viewProjection'

/** Dependency-injection options for the API routes; optional deps are honest
 *  capability degradation (P5) — a meta-DB-less / FS-less host omits them and the
 *  matching routes 404 or fall back. canon: docs/architecture.md#p5 */
export type ApiRoutesOptions = {
  spaces: SpaceManager
  auth: AuthService
  roles?: RolesService
  providerRegistry?: ProviderRegistry
  abilities?: AbilitiesService
  sessions?: AgentSessionsPersistence
  projects?: ProjectsPersistence
  folders?: FolderIdentityPersistence
  favorites?: FavoritesPersistence
  contextSets?: ContextSetsPersistence
  scopePins?: ScopePinsPersistence
  contextOrder?: ContextOrderPersistence
  retrievalLog?: RetrievalLogPersistence
  agentCalls?: AgentCallTracePersistence
  sessionAudit?: AgentSessionAuditPersistence
  markerStore?: MarkerStore
  fieldSchemaStore?: FieldSchemaStore
  /** Pure reader definitions; injectable for conformance and composed with built-ins in production. */
  viewReaders?: ReaderRegistry
  /** Tagged source executors; unknown kinds stay locally unsupported. */
  viewSources?: ViewSourceRegistry
  /** Reader-owned MCP/Feed projections. */
  viewProjectionAdapters?: ViewProjectionAdapters
  spacesPersistence?: SpacesPersistence
  about?: HostInfo
  /** This build's identity. Absent ⇒ the bundle's own inlined identity, which is
   *  what production always wants; injectable so a harness can serve the released
   *  shape (a real commit and source link) without being a released build.
   *  canon: docs/release.md#identity */
  build?: BuildInfo
  jobs?: JobsPersistence
  /** Paired with `jobs` — both present or neither. */
  artifacts?: ArtifactStore
  /** Paired with `jobs`. */
  staging?: ImportStagingStore
  /** Nudge the runner to claim immediately after enqueue; absent ⇒ next poll tick. */
  wakeJobs?: () => void
  /** Strict single-note restore; absent is honest 503 capability degradation. */
  restoreCoordinator?: RestoreCoordinator
  /** Resumable strict trash bulk; absent is honest 503 degradation. */
  bulkRestoreCoordinator?: BulkRestoreCoordinator
}
