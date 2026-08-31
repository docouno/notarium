import { ErrorResponseSchema, OkResponseSchema } from './schemas/rest/_shared'
import {
  AbilitySaveRequestSchema,
  AbilitySaveResponseSchema,
  AgentAbilityDetailResponseSchema,
  CreateAbilityVersionRequestSchema,
  CreateAbilityVersionResponseSchema,
  SetAbilityHomeRequestSchema,
  SetAbilityHomeResponseSchema,
  SetAgentAbilityAvailabilityRequestSchema,
  SetAgentAbilityAvailabilityResponseSchema,
  SetAgentAbilityEnabledRequestSchema,
  SetAgentAbilityEnabledResponseSchema,
} from './schemas/rest/agent/abilities'
import { AgentAuditQuerySchema, AgentAuditResponseSchema } from './schemas/rest/agent/audit'
import {
  ContextOrderRequestSchema,
  ContextPinRequestSchema,
  ContextSetCreateRequestSchema,
  ContextSetItemRequestSchema,
  ContextSetItemsAddRequestSchema,
  ContextSetItemsAddResponseSchema,
  ContextSetItemsQuerySchema,
  ContextSetItemsResponseSchema,
  ContextSetOrderRequestSchema,
  ContextSetPatchRequestSchema,
  ContextSetResponseSchema,
  ContextSetsResponseSchema,
  MeAgentContextResponseSchema,
  ProjectAgentContextResponseSchema,
} from './schemas/rest/agent/context'
import {
  MeMemoryQuerySchema,
  MeMemoryResponseSchema,
  ProjectMemoryQuerySchema,
  ProjectMemoryResponseSchema,
} from './schemas/rest/agent/memory'
import { AgentPackageLibraryQuerySchema } from './schemas/rest/agent/packageLibrary'
import { ProfilePutRequestSchema, ProfileResponseSchema } from './schemas/rest/agent/profile'
import {
  AddAgentRoleRequestSchema,
  AddAgentRoleResponseSchema,
  CreateAgentRoleRequestSchema,
  CreateAgentRoleResponseSchema,
  MeAgentRolesResponseSchema,
} from './schemas/rest/agent/roles'
import {
  AgentCallDetailResponseSchema,
  AgentSessionDeleteAcceptedSchema,
  AgentSessionDeleteActiveConflictSchema,
  AgentSessionDeleteQuerySchema,
  AgentSessionEventsQuerySchema,
  AgentSessionEventsResponseSchema,
  AgentSessionsQuerySchema,
  AgentSessionsResponseSchema,
  AgentTelemetryConfigPatchSchema,
  AgentTelemetryConfigSchema,
  AgentTraceExportEventSchema,
  AgentTraceExportMetadataSchema,
  AgentTraceExportSummarySchema,
} from './schemas/rest/agent/sessions'
import {
  AddAgentSkillRequestSchema,
  AddAgentSkillResponseSchema,
  CreateAgentSkillRequestSchema,
  CreateAgentSkillResponseSchema,
  MeAgentSkillsResponseSchema,
} from './schemas/rest/agent/skills'
import {
  AcceptInviteRequestSchema,
  AuthSessionResponseSchema,
  InviteInfoRequestSchema,
  InviteInfoResponseSchema,
  LoginRequestSchema,
  MeSchema,
  PasswordChangeRequestSchema,
  SetupRequestSchema,
} from './schemas/rest/auth'
import {
  CredentialCreateRequestSchema,
  CredentialDeleteResponseSchema,
  CredentialPatchRequestSchema,
  CredentialReferenceConflictResponseSchema,
  CredentialResponseSchema,
  CredentialsResponseSchema,
} from './schemas/rest/credentials'
import {
  FavoriteMutationResponseSchema,
  FavoritePutRequestSchema,
  FavoritesResponseSchema,
} from './schemas/rest/favorites'
import {
  FieldSchemaConflictResponseSchema,
  FieldSchemaResponseSchema,
  FieldSchemaUpdateSchema,
} from './schemas/rest/fields'
import {
  CreateFolderPageRequestSchema,
  CreateFolderPageResponseSchema,
  CreateFolderRequestSchema,
  FolderResponseSchema,
  MoveFolderRequestSchema,
} from './schemas/rest/folders'
import { GraphResponseSchema } from './schemas/rest/graph'
import {
  NoteRevisionDetailResponseSchema,
  NoteRevisionsQuerySchema,
  NoteRevisionsResponseSchema,
  RestoreRequestSchema,
  RestoreResponseSchema,
} from './schemas/rest/history'
import { ConfigSchema, HostAboutResponseSchema } from './schemas/rest/host'
import {
  ConflictResponseSchema,
  CreateNoteRequestSchema,
  MoveRequestSchema,
  MoveResponseSchema,
  MuteNoteRequestSchema,
  MuteNoteResponseSchema,
  NoteDetailResponseSchema,
  NoteExistsResponseSchema,
  PinNoteRequestSchema,
  PinNoteResponseSchema,
  RemoveResponseSchema,
  SaveResponseSchema,
  SetNoteFieldsRequestSchema,
  SetNoteFieldsResponseSchema,
  UpdateNoteRequestSchema,
} from './schemas/rest/note'
import {
  BucketsQuerySchema,
  BucketsResponseSchema,
  FieldsQuerySchema,
  FieldsResponseSchema,
  NotesQuerySchema,
  NotesResponseSchema,
  PreviewsRequestSchema,
  PreviewsResponseSchema,
  TagsQuerySchema,
  TagsResponseSchema,
} from './schemas/rest/notes'
import {
  ConnectionPatchRequestSchema,
  PatCreateRequestSchema,
  PatCreateResponseSchema,
  PatPatchRequestSchema,
  PatsResponseSchema,
} from './schemas/rest/pats'
import {
  MarkProjectRequestSchema,
  PatchProjectRequestSchema,
  ProjectRowSchema,
  ProjectsResponseSchema,
} from './schemas/rest/projects'
import {
  ProviderAttachmentAcceptRequestSchema,
  ProviderAttachmentAcceptResponseSchema,
  ProviderAttachmentConflictResponseSchema,
  ProviderAttachmentDetachResponseSchema,
  ProviderAttachmentDetailResponseSchema,
  ProviderAttachmentOfferRequestSchema,
  ProviderAttachmentOfferResponseSchema,
  ProviderAttachmentsResponseSchema,
  ProviderRetargetConflictResponseSchema,
  ProviderRetargetRequestSchema,
  ProviderRetargetResponseSchema,
} from './schemas/rest/providerAttachments'
import {
  ProviderEffectiveEntrySchema,
  ProviderEffectiveResponseSchema,
  ProviderInventoryQuerySchema,
  ProviderResourceCreateRequestSchema,
  ProviderResourceDeleteResponseSchema,
  ProviderResourcePatchRequestSchema,
  ProviderResourceResponseSchema,
  ProviderResourcesResponseSchema,
  ProviderResourceStatusesRequestSchema,
  ProviderResourceStatusesResponseSchema,
  ProviderValidateRequestSchema,
  ProviderValidateResponseSchema,
} from './schemas/rest/providers'
import { SearchResponseSchema } from './schemas/rest/search'
import { PurgeSpaceRequestSchema, SpaceSchema, SpacesResponseSchema } from './schemas/rest/spaces'
import { StatusResponseSchema, StoreEventSchema } from './schemas/rest/sync'
import {
  RestoreSpacesRequestSchema,
  RestoreSpacesResponseSchema,
  TrashPurgeRequestSchema,
  TrashPurgeResponseSchema,
  TrashQuerySchema,
  TrashResponseSchema,
  TrashRestoreManyRequestSchema,
  TrashRestoreManyResponseSchema,
  TrashRestoreRequestSchema,
} from './schemas/rest/trash'
import {
  TreeChildrenQuerySchema,
  TreeChildrenResponseSchema,
  TreeResponseSchema,
} from './schemas/rest/tree'
import {
  InviteLinkResponseSchema,
  MemberPutRequestSchema,
  MembersResponseSchema,
  UserCreateRequestSchema,
  UserPatchRequestSchema,
  UserSchema,
  UsersResponseSchema,
} from './schemas/rest/users'
import {
  BoardMoveRequestSchema,
  BoardMoveResponseSchema,
  DraftViewQueryRequestSchema,
  DraftViewQueryResponseSchema,
  ViewManifestQuerySchema,
  ViewManifestResponseSchema,
  ViewWindowRequestSchema,
  ViewWindowResponseSchema,
} from './schemas/rest/views'

/** Flat map of every operation, keyed by the api.js method name; the #18.2 fake
 *  backend and tests resolve schemas by that key.
 *  @see docs/contract.md#registry */
export const contract = {
  config: { response: ConfigSchema },
  about: { response: HostAboutResponseSchema },
  spaces: { response: SpacesResponseSchema },
  archivedSpaces: { response: SpacesResponseSchema },
  archiveSpace: { response: OkResponseSchema },
  restoreSpace: { response: SpaceSchema },
  restoreSpaces: { request: RestoreSpacesRequestSchema, response: RestoreSpacesResponseSchema },
  purgeSpace: { request: PurgeSpaceRequestSchema, response: OkResponseSchema },
  notes: { request: NotesQuerySchema, response: NotesResponseSchema },
  tree: { response: TreeResponseSchema },
  treeChildren: { request: TreeChildrenQuerySchema, response: TreeChildrenResponseSchema },
  buckets: { request: BucketsQuerySchema, response: BucketsResponseSchema },
  tags: { request: TagsQuerySchema, response: TagsResponseSchema },
  fields: { request: FieldsQuerySchema, response: FieldsResponseSchema },
  fieldSchema: { response: FieldSchemaResponseSchema },
  fieldSchemaPut: {
    request: FieldSchemaUpdateSchema,
    response: FieldSchemaResponseSchema,
    conflict: FieldSchemaConflictResponseSchema,
  },
  graph: { response: GraphResponseSchema },
  note: { response: NoteDetailResponseSchema },
  noteViews: { request: ViewManifestQuerySchema, response: ViewManifestResponseSchema },
  viewWindow: { request: ViewWindowRequestSchema, response: ViewWindowResponseSchema },
  draftViewQuery: {
    request: DraftViewQueryRequestSchema,
    response: DraftViewQueryResponseSchema,
  },
  boardMove: { request: BoardMoveRequestSchema, response: BoardMoveResponseSchema },
  previews: { request: PreviewsRequestSchema, response: PreviewsResponseSchema },
  search: { response: SearchResponseSchema },
  create: {
    request: CreateNoteRequestSchema,
    response: SaveResponseSchema,
    conflict: NoteExistsResponseSchema,
  },
  update: {
    request: UpdateNoteRequestSchema,
    response: SaveResponseSchema,
    conflict: ConflictResponseSchema,
  },
  setNoteFields: {
    request: SetNoteFieldsRequestSchema,
    response: SetNoteFieldsResponseSchema,
    conflict: ConflictResponseSchema,
  },
  revisions: { request: NoteRevisionsQuerySchema, response: NoteRevisionsResponseSchema },
  revision: { response: NoteRevisionDetailResponseSchema },
  restore: {
    request: RestoreRequestSchema,
    response: RestoreResponseSchema,
  },
  remove: { response: RemoveResponseSchema },
  trash: { request: TrashQuerySchema, response: TrashResponseSchema },
  trashRestore: { request: TrashRestoreRequestSchema, response: RestoreResponseSchema },
  trashRestoreMany: {
    request: TrashRestoreManyRequestSchema,
    response: TrashRestoreManyResponseSchema,
  },
  trashPurge: { request: TrashPurgeRequestSchema, response: TrashPurgeResponseSchema },
  move: { request: MoveRequestSchema, response: MoveResponseSchema },
  moveFolder: { request: MoveFolderRequestSchema, response: MoveResponseSchema },
  markProject: { request: MarkProjectRequestSchema, response: ProjectRowSchema },
  listProjects: { response: ProjectsResponseSchema },
  patchProject: { request: PatchProjectRequestSchema, response: ProjectRowSchema },
  unmarkProject: { response: RemoveResponseSchema },
  favorites: { response: FavoritesResponseSchema },
  favoritePut: { request: FavoritePutRequestSchema, response: FavoriteMutationResponseSchema },
  favoriteDelete: { response: FavoriteMutationResponseSchema },
  folderCreate: { request: CreateFolderRequestSchema, response: OkResponseSchema },
  folderDelete: { response: RemoveResponseSchema },
  folder: { response: FolderResponseSchema },
  folderPageCreate: {
    request: CreateFolderPageRequestSchema,
    response: CreateFolderPageResponseSchema,
  },
  status: { response: StatusResponseSchema },
  events: { event: StoreEventSchema },
  error: { response: ErrorResponseSchema },
  authSession: { response: AuthSessionResponseSchema },
  login: { request: LoginRequestSchema, response: MeSchema },
  setup: { request: SetupRequestSchema, response: MeSchema },
  logout: { response: OkResponseSchema },
  inviteInfo: { request: InviteInfoRequestSchema, response: InviteInfoResponseSchema },
  acceptInvite: { request: AcceptInviteRequestSchema, response: MeSchema },
  passwordChange: { request: PasswordChangeRequestSchema, response: OkResponseSchema },
  me: { response: MeSchema },
  pats: { response: PatsResponseSchema },
  patCreate: { request: PatCreateRequestSchema, response: PatCreateResponseSchema },
  patPatch: { request: PatPatchRequestSchema, response: OkResponseSchema },
  patRevoke: { response: OkResponseSchema },
  connectionPatch: { request: ConnectionPatchRequestSchema, response: OkResponseSchema },
  users: { response: UsersResponseSchema },
  userCreate: { request: UserCreateRequestSchema, response: InviteLinkResponseSchema },
  userInvite: { response: InviteLinkResponseSchema },
  userPatch: { request: UserPatchRequestSchema, response: UserSchema },
  members: { response: MembersResponseSchema },
  memberPut: { request: MemberPutRequestSchema, response: MembersResponseSchema },
  memberRemove: { response: MembersResponseSchema },
  meMemory: { request: MeMemoryQuerySchema, response: MeMemoryResponseSchema },
  projectMemory: { request: ProjectMemoryQuerySchema, response: ProjectMemoryResponseSchema },
  meAgentContext: { response: MeAgentContextResponseSchema },
  projectAgentContext: { response: ProjectAgentContextResponseSchema },
  agentAudit: { request: AgentAuditQuerySchema, response: AgentAuditResponseSchema },
  agentSessions: { request: AgentSessionsQuerySchema, response: AgentSessionsResponseSchema },
  agentSessionEvents: {
    request: AgentSessionEventsQuerySchema,
    response: AgentSessionEventsResponseSchema,
  },
  agentCallDetail: { response: AgentCallDetailResponseSchema },
  agentSessionDelete: {
    request: AgentSessionDeleteQuerySchema,
    response: AgentSessionDeleteAcceptedSchema,
    conflict: AgentSessionDeleteActiveConflictSchema,
  },
  agentTelemetryConfigGet: { response: AgentTelemetryConfigSchema },
  agentTelemetryConfigPatch: {
    request: AgentTelemetryConfigPatchSchema,
    response: AgentTelemetryConfigSchema,
  },
  agentSessionExport: {
    metadata: AgentTraceExportMetadataSchema,
    event: AgentTraceExportEventSchema,
    summary: AgentTraceExportSummarySchema,
  },
  agentRoles: { request: AgentPackageLibraryQuerySchema, response: MeAgentRolesResponseSchema },
  agentAbilityDetail: { response: AgentAbilityDetailResponseSchema },
  agentAbilityEnabled: {
    request: SetAgentAbilityEnabledRequestSchema,
    response: SetAgentAbilityEnabledResponseSchema,
  },
  agentAbilityAvailability: {
    request: SetAgentAbilityAvailabilityRequestSchema,
    response: SetAgentAbilityAvailabilityResponseSchema,
  },
  agentAbilityVersions: {
    request: CreateAbilityVersionRequestSchema,
    response: CreateAbilityVersionResponseSchema,
  },
  agentAbilityHome: {
    request: SetAbilityHomeRequestSchema,
    response: SetAbilityHomeResponseSchema,
  },
  agentAbilitySave: {
    request: AbilitySaveRequestSchema,
    response: AbilitySaveResponseSchema,
    conflict: ConflictResponseSchema,
  },
  agentRoleAdd: { request: AddAgentRoleRequestSchema, response: AddAgentRoleResponseSchema },
  agentRoleCreate: {
    request: CreateAgentRoleRequestSchema,
    response: CreateAgentRoleResponseSchema,
  },
  agentSkills: { request: AgentPackageLibraryQuerySchema, response: MeAgentSkillsResponseSchema },
  agentSkillCreate: {
    request: CreateAgentSkillRequestSchema,
    response: CreateAgentSkillResponseSchema,
  },
  agentSkillAdd: {
    request: AddAgentSkillRequestSchema,
    response: AddAgentSkillResponseSchema,
  },
  pinNote: { request: PinNoteRequestSchema, response: PinNoteResponseSchema },
  muteNote: { request: MuteNoteRequestSchema, response: MuteNoteResponseSchema },
  contextSets: { response: ContextSetsResponseSchema },
  contextSetCreate: { request: ContextSetCreateRequestSchema, response: ContextSetResponseSchema },
  contextSetPatch: { request: ContextSetPatchRequestSchema, response: ContextSetResponseSchema },
  contextSetDelete: { response: OkResponseSchema },
  contextSetItemAdd: { request: ContextSetItemRequestSchema, response: ContextSetResponseSchema },
  contextSetItemRemove: { response: ContextSetResponseSchema },
  contextSetItems: { request: ContextSetItemsQuerySchema, response: ContextSetItemsResponseSchema },
  contextSetItemsAdd: {
    request: ContextSetItemsAddRequestSchema,
    response: ContextSetItemsAddResponseSchema,
  },
  contextSetAttach: { response: OkResponseSchema },
  contextSetDetach: { response: OkResponseSchema },
  contextPinAttach: { request: ContextPinRequestSchema, response: OkResponseSchema },
  contextPinDetach: { response: OkResponseSchema },
  contextOrderPersonal: { request: ContextOrderRequestSchema, response: OkResponseSchema },
  contextOrderProject: { request: ContextOrderRequestSchema, response: OkResponseSchema },
  contextSetItemsOrder: {
    request: ContextSetOrderRequestSchema,
    response: ContextSetResponseSchema,
  },
  providerCredentials: {
    request: ProviderInventoryQuerySchema,
    response: CredentialsResponseSchema,
  },
  providerCredential: { response: CredentialResponseSchema },
  providerCredentialCreate: {
    request: CredentialCreateRequestSchema,
    response: CredentialResponseSchema,
  },
  providerCredentialPatch: {
    request: CredentialPatchRequestSchema,
    response: CredentialResponseSchema,
    conflict: CredentialReferenceConflictResponseSchema,
  },
  providerCredentialDelete: {
    response: CredentialDeleteResponseSchema,
    conflict: CredentialReferenceConflictResponseSchema,
  },
  providerResources: {
    request: ProviderInventoryQuerySchema,
    response: ProviderResourcesResponseSchema,
  },
  providerResource: { response: ProviderResourceResponseSchema },
  providerResourceCreate: {
    request: ProviderResourceCreateRequestSchema,
    response: ProviderResourceResponseSchema,
  },
  providerResourcePatch: {
    request: ProviderResourcePatchRequestSchema,
    response: ProviderResourceResponseSchema,
  },
  providerResourceDelete: { response: ProviderResourceDeleteResponseSchema },
  providerResourceStatuses: {
    request: ProviderResourceStatusesRequestSchema,
    response: ProviderResourceStatusesResponseSchema,
  },
  providerResourceValidate: {
    request: ProviderValidateRequestSchema,
    response: ProviderValidateResponseSchema,
  },
  providerEffective: {
    request: ProviderInventoryQuerySchema,
    response: ProviderEffectiveResponseSchema,
  },
  providerEffectiveDetail: { response: ProviderEffectiveEntrySchema },
  providerAttachments: {
    request: ProviderInventoryQuerySchema,
    response: ProviderAttachmentsResponseSchema,
  },
  providerAttachmentDetail: { response: ProviderAttachmentDetailResponseSchema },
  providerAttachmentOffer: {
    request: ProviderAttachmentOfferRequestSchema,
    response: ProviderAttachmentOfferResponseSchema,
    conflict: ProviderAttachmentConflictResponseSchema,
  },
  providerAttachmentAccept: {
    request: ProviderAttachmentAcceptRequestSchema,
    response: ProviderAttachmentAcceptResponseSchema,
    conflict: ProviderAttachmentConflictResponseSchema,
  },
  providerAttachmentDetach: { response: ProviderAttachmentDetachResponseSchema },
  providerCredentialRetarget: {
    request: ProviderRetargetRequestSchema,
    response: ProviderRetargetResponseSchema,
    conflict: ProviderRetargetConflictResponseSchema,
  },
  profile: { response: ProfileResponseSchema },
  profilePut: { request: ProfilePutRequestSchema, response: ProfileResponseSchema },
} as const
