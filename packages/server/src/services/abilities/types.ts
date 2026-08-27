import type {
  AbilityKind,
  AbilitySaveRequest,
  AbilitySaveResponse,
  AbilitySkillLocator,
  AddAgentRoleRequest,
  AddAgentSkillRequest,
  AgentAbilityAvailability,
  AgentAbilityAvailabilityState,
  AgentAbilityDetailResponse,
  AgentPackageLibraryQuery,
  AuthoredAttachment,
  CreateAgentRoleRequest,
  CreateAgentSkillRequest,
  MeAgentRolesResponse,
  MeAgentSkillsResponse,
  OwnedAbilityLocator,
  SystemAbilityLocator,
} from '@notarium/contract'
import type { AbilitySummary, RuntimeAbilitySummary } from '@notarium/contract/tools'
import type { NoteContent, WriteInput, WriteResult } from '@notarium/core'

import type { AuthService } from '../auth'
import type { Principal } from '../authz'
import type { AgentSessionsPersistence, ProjectsPersistence } from '../metaDb'
import type {
  AddressedPlacement,
  AddressedRoleStatus,
  BoundedAbilityList,
  EffectiveRoleContext,
  OwnedAbilitySnapshot,
  PublishedRoleInventoryEntry,
  PublishedSkillInventoryEntry,
  RoleLocation,
  RolesService,
  SkillHomeLocation,
  SkillPackage,
} from '../roles'
import type { SpaceManager, SpaceStore } from '../spaces'
import type { NoteAccess, StoreAccess } from '../storeAccess'

export type AbilityListSurface = 'human' | 'runtime' | 'authoring' | 'bundle'

export type AgentAbilityListQuery = {
  project?: string
  kind?: AbilityKind
  source?: 'system' | 'owned'
  q?: string
  cursor?: string
  limit: number
}

export type AgentAbilityPage = {
  abilities: AbilitySummary[]
  total: number
  nextCursor?: string
  truncated: boolean
}

export type AbilityBundle = {
  abilities: RuntimeAbilitySummary[]
  truncated: boolean
}

export type HumanAbilityPage =
  { kind: 'role'; page: MeAgentRolesResponse } | { kind: 'skill'; page: MeAgentSkillsResponse }

export type AbilityPersonalContext = {
  listing: BoundedAbilityList
  selected: AddressedRoleStatus | null
  locator: Extract<OwnedAbilityLocator, { kind: 'role' }> | null
}

export type AuthoringAbilityRead = AgentAbilityDetailResponse & {
  writable: boolean
  /** Owned authoring reads carry the note CAS token. System is read-only and has none. */
  versionToken?: string
}

export type AbilityCreateRequest =
  | { kind: 'role'; source: 'catalog'; body: AddAgentRoleRequest }
  | { kind: 'role'; source: 'custom'; body: CreateAgentRoleRequest }
  | { kind: 'skill'; source: 'catalog'; body: AddAgentSkillRequest }
  | { kind: 'skill'; source: 'custom'; body: CreateAgentSkillRequest }

export type PreparedAbilityCreate = AbilityCreateRequest & {
  principal: Principal
  personalSpace: string | null
  location: AddressedPlacement
  availability?: AgentAbilityAvailabilityState
}

export type PublishedAbility =
  | {
      kind: 'role'
      body: AddAgentRoleRequest | CreateAgentRoleRequest
      location: RoleLocation
      ability: PublishedRoleInventoryEntry
      locator: Extract<OwnedAbilityLocator, { kind: 'role' }>
      versionToken: string
      /** The durable operation already committed this exact package on an earlier call. */
      replayed?: true
    }
  | {
      kind: 'skill'
      body: AddAgentSkillRequest | CreateAgentSkillRequest
      location: SkillHomeLocation
      ability: PublishedSkillInventoryEntry
      locator: Extract<OwnedAbilityLocator, { kind: 'skill' }>
      versionToken: string
      /** The durable operation already committed this exact package on an earlier call. */
      replayed?: true
    }

export type DeferredAbilityAttachments = {
  kind: 'deferred'
  attachments: ReadonlyArray<{ locator: AbilitySkillLocator; label?: string }>
  resolve(): Promise<readonly AuthoredAttachment[]>
}

export type AbilityAttachmentIntent =
  NonNullable<AbilitySaveRequest['attachments']> | DeferredAbilityAttachments

export type AbilityEditRequest = {
  versionToken?: string
  description?: string
  instructions?: string
  attachments?: AbilityAttachmentIntent
  availability?: AgentAbilityAvailability
  enabled?: boolean
  home?: { home: 'space' }
}

export type AbilityEditResponse = {
  locator: OwnedAbilityLocator
  versionToken?: string
  steps: AbilitySaveResponse['steps']
}

export type RemovedAbility = { locator: OwnedAbilityLocator; name: string }

declare const AUTHORIZED_ABILITY_DOCUMENT: unique symbol

export type AbilityDocumentTarget = NoteAccess & {
  note: NoteContent
  readonly [AUTHORIZED_ABILITY_DOCUMENT]: true
}

export type AbilityDocumentCandidate = NoteAccess & { note: NoteContent }

export type AbilityDocumentWrite = {
  target: AbilityDocumentTarget
  input: WriteInput
  description?: string
  locator?:
    | Extract<OwnedAbilityLocator, { kind: 'role' }>
    | (OwnedAbilitySnapshot & { locator: Extract<OwnedAbilityLocator, { kind: 'role' }> })
  attachments?: AbilityAttachmentIntent
  /** The compound Save owns only these authored fields, so it may prove an exact
   * semantic no-op. The generic note door can carry additional metadata and leaves
   * this false. */
  semanticNoop?: boolean
  /** Revalidate and retain the exact NoteStore → package scope through one document
   * task. An applied write nests this under the store claim; a no-op enters it itself. */
  withTargetMutation?<T>(task: (current: OwnedAbilitySnapshot) => Promise<T>): Promise<T>
}

export type AuthoredWriteResult = WriteResult & {
  id: string
  versionToken: string
  outcome: 'applied' | 'skipped'
}

export type AbilityCreateOperation = {
  idempotencyKey?: string
  scopeKey?: string
  /** Whether this caller may author the explicit Owned override that human REST supports. */
  systemNamePolicy?: 'allow' | 'reject'
  /** Canonical request material available before mutable dependency resolution. */
  requestFingerprint?: string
  /** Pre-policy fingerprint used only to replay conservative legacy evidence. */
  legacyRequestFingerprint?: string
}

type PreparedCustomAbilityCreate = Extract<PreparedAbilityCreate, { source: 'custom' }>

export type CustomAbilityCreator = {
  createDurably(input: {
    prepared: PreparedCustomAbilityCreate
    attribution: Pick<WriteInput, 'principal' | 'agent'>
    preparePackage: () => Promise<{ prepared: PreparedCustomAbilityCreate; pkg: SkillPackage }>
    operation?: AbilityCreateOperation
  }): Promise<PublishedAbility>
}

export type AbilitiesService = {
  personalSpaceFor(principal: Principal): Promise<string | null>
  list: {
    (
      surface: 'human',
      context: { kind: AbilityKind },
      principal: Principal,
      query: AgentPackageLibraryQuery,
    ): Promise<HumanAbilityPage>
    (
      surface: 'runtime' | 'authoring',
      context: EffectiveRoleContext,
      principal: Principal,
      query: AgentAbilityListQuery,
    ): Promise<AgentAbilityPage>
    (
      surface: 'bundle',
      context: EffectiveRoleContext,
      principal: Principal,
      query: AgentAbilityListQuery,
    ): Promise<AbilityBundle>
  }
  personalContext(
    principal: Principal,
    personalSpace: string,
    roleRef?: string,
  ): Promise<AbilityPersonalContext>
  get: {
    (
      surface: 'human',
      principal: Principal,
      locator: Parameters<RolesService['describeAbility']>[2],
    ): Promise<AgentAbilityDetailResponse | null>
    (
      surface: 'authoring',
      principal: Principal,
      locator: Parameters<RolesService['describeAbility']>[2],
    ): Promise<AuthoringAbilityRead | null>
  }
  prepareCreate(principal: Principal, request: AbilityCreateRequest): Promise<PreparedAbilityCreate>
  create(
    prepared: PreparedAbilityCreate,
    attribution?: Pick<WriteInput, 'principal' | 'agent'>,
    operation?: AbilityCreateOperation,
    complete?: (prepared: PreparedCustomAbilityCreate) => Promise<PreparedCustomAbilityCreate>,
  ): Promise<PublishedAbility>
  createVersion(
    principal: Principal,
    locator: Extract<OwnedAbilityLocator, { kind: 'role' }>,
    projectId: string,
  ): Promise<{
    locator: Extract<OwnedAbilityLocator, { kind: 'role' }>
    noteId: string
    versionToken: string
  }>
  authorizeDocument(
    principal: Principal,
    candidate: AbilityDocumentCandidate,
  ): AbilityDocumentTarget | null
  writeDocument(principal: Principal, write: AbilityDocumentWrite): Promise<AuthoredWriteResult>
  save(
    principal: Principal,
    locator: OwnedAbilityLocator,
    request: AbilitySaveRequest,
  ): Promise<AbilitySaveResponse>
  edit(
    principal: Principal,
    locator: OwnedAbilityLocator,
    request: AbilityEditRequest,
  ): Promise<AbilityEditResponse>
  setHome(
    principal: Principal,
    locator: Extract<OwnedAbilityLocator, { kind: 'role' }>,
  ): Promise<{
    locator: Extract<OwnedAbilityLocator, { kind: 'role' }>
    availability: AgentAbilityAvailabilityState
    noteId: string
  }>
  setAvailability(
    principal: Principal,
    locator: OwnedAbilityLocator,
    availability: AgentAbilityAvailabilityState,
  ): Promise<void>
  setEnabled(
    principal: Principal,
    locator: OwnedAbilityLocator | SystemAbilityLocator,
    enabled: boolean,
  ): Promise<void>
  removeDocument(
    principal: Principal,
    target: AbilityDocumentTarget,
    attribution: { principal: string },
  ): Promise<boolean>
  remove(
    principal: Principal,
    locator: OwnedAbilityLocator,
    attribution: { principal: string; agent?: WriteInput['agent'] },
  ): Promise<RemovedAbility>
}

export type CreateAbilitiesOptions = {
  roles: RolesService
  spaces: SpaceManager
  auth: AuthService
  projects?: ProjectsPersistence
  sessions?: AgentSessionsPersistence
  store: StoreAccess
  customCreator?: CustomAbilityCreator
}

export type AbilityInventoryDeps = Pick<
  CreateAbilitiesOptions,
  'roles' | 'spaces' | 'auth' | 'projects' | 'sessions'
>

export type AbilityDiscoveryDeps = Pick<CreateAbilitiesOptions, 'roles' | 'spaces' | 'projects'>

export type AbilitySaveDeps = Pick<
  CreateAbilitiesOptions,
  'roles' | 'spaces' | 'auth' | 'projects' | 'store'
>

export type AbilityStore = SpaceStore
