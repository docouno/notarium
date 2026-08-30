import {
  CreateAbilityInputSchema,
  CreateAbilityOutputSchema,
  DeleteAbilityInputSchema,
  DeleteAbilityOutputSchema,
  EditAbilityInputSchema,
  EditAbilityOutputSchema,
  GetAbilityInputSchema,
  GetAbilityOutputSchema,
  ListAbilitiesInputSchema,
  ListAbilitiesOutputSchema,
} from './abilities'
import {
  GetMyProjectsInputSchema,
  GetMyProjectsOutputSchema,
  StartSessionInputSchema,
  StartSessionOutputSchema,
  WhoamiInputSchema,
  WhoamiOutputSchema,
} from './bootstrap'
import {
  ListNotesInputSchema,
  ListNotesOutputSchema,
  RecentActivityInputSchema,
  RecentActivityOutputSchema,
} from './discover'
import { WriteResultSchema } from './primitives'
import {
  GetNoteInputSchema,
  GetNoteOutputSchema,
  GetNotePublishedOutputSchema,
  RecallInputSchema,
  RecallOutputSchema,
  SearchInputSchema,
  SearchOutputSchema,
} from './read'
import {
  DeleteNoteInputSchema,
  DeleteNoteOutputSchema,
  FolderReorgOutputSchema,
  MoveFolderInputSchema,
  MoveNoteInputSchema,
  MoveNoteOutputSchema,
  RenameFolderInputSchema,
  RenameNoteInputSchema,
  RenameNoteOutputSchema,
  RenameProjectInputSchema,
  RenameProjectOutputSchema,
} from './reorg'
import {
  UseRoleInputSchema,
  UseRoleOutputSchema,
  UseSkillInputSchema,
  UseSkillOutputSchema,
} from './roles'
import {
  CreateNoteInputSchema,
  CreateNotesInputSchema,
  CreateNotesOutputSchema,
  EditNoteInputSchema,
  EditNotePublishedInputSchema,
  LinkInputSchema,
  LinkManyInputSchema,
  LinkManyOutputSchema,
  LinkOutputSchema,
  RememberAboutProjectInputSchema,
  RememberAboutUserInputSchema,
} from './write'

/** Every MCP tool keyed by its wire name; write intents share
 *  WriteResultSchema (`{ noteId, versionToken }`).
 *  canon: docs/contract.md#registry */
export const tools = {
  start_session: { input: StartSessionInputSchema, output: StartSessionOutputSchema },
  list_abilities: { input: ListAbilitiesInputSchema, output: ListAbilitiesOutputSchema },
  get_ability: { input: GetAbilityInputSchema, output: GetAbilityOutputSchema },
  create_ability: { input: CreateAbilityInputSchema, output: CreateAbilityOutputSchema },
  edit_ability: { input: EditAbilityInputSchema, output: EditAbilityOutputSchema },
  delete_ability: { input: DeleteAbilityInputSchema, output: DeleteAbilityOutputSchema },
  use_role: { input: UseRoleInputSchema, output: UseRoleOutputSchema },
  use_skill: { input: UseSkillInputSchema, output: UseSkillOutputSchema },
  whoami: { input: WhoamiInputSchema, output: WhoamiOutputSchema },
  get_my_projects: { input: GetMyProjectsInputSchema, output: GetMyProjectsOutputSchema },
  list_notes: { input: ListNotesInputSchema, output: ListNotesOutputSchema },
  recent_activity: { input: RecentActivityInputSchema, output: RecentActivityOutputSchema },
  search: { input: SearchInputSchema, output: SearchOutputSchema },
  get_note: {
    input: GetNoteInputSchema,
    output: GetNoteOutputSchema,
    publishedOutput: GetNotePublishedOutputSchema,
  },
  recall: { input: RecallInputSchema, output: RecallOutputSchema },
  remember_about_user: { input: RememberAboutUserInputSchema, output: WriteResultSchema },
  create_note: { input: CreateNoteInputSchema, output: WriteResultSchema },
  remember_about_project: { input: RememberAboutProjectInputSchema, output: WriteResultSchema },
  edit_note: {
    input: EditNoteInputSchema,
    publishedInput: EditNotePublishedInputSchema,
    output: WriteResultSchema,
  },
  // Note reorg — verb_entity, addressed by note-id.
  delete_note: { input: DeleteNoteInputSchema, output: DeleteNoteOutputSchema },
  move_note: { input: MoveNoteInputSchema, output: MoveNoteOutputSchema },
  rename_note: { input: RenameNoteInputSchema, output: RenameNoteOutputSchema },
  // Container reorg — folders by path, projects by handle.
  move_folder: { input: MoveFolderInputSchema, output: FolderReorgOutputSchema },
  rename_folder: { input: RenameFolderInputSchema, output: FolderReorgOutputSchema },
  rename_project: { input: RenameProjectInputSchema, output: RenameProjectOutputSchema },
  link: { input: LinkInputSchema, output: LinkOutputSchema },
  create_notes: { input: CreateNotesInputSchema, output: CreateNotesOutputSchema },
  link_many: { input: LinkManyInputSchema, output: LinkManyOutputSchema },
} as const

export type ToolName = keyof typeof tools

export const toolNames = Object.keys(tools) as ToolName[]

/** Each tool's authz action (tools/list scope filter + per-call can()).
 *  The Action vocabulary lives in @notarium/server; this package can't import
 *  it (dependency direction), so values are string literals the server
 *  type-guards. `satisfies Record<ToolName, string>` here only guarantees
 *  coverage (one action per tool), not that a value is a real Action.
 *  canon: docs/architecture.md#p14 */
export const toolActions = {
  start_session: 'space:read',
  list_abilities: 'space:read',
  get_ability: 'space:write',
  create_ability: 'space:write',
  edit_ability: 'space:write',
  delete_ability: 'space:write',
  use_role: 'space:read',
  use_skill: 'space:read',
  whoami: 'self:read',
  get_my_projects: 'spaces:list',
  list_notes: 'space:read',
  recent_activity: 'space:read',
  search: 'space:read',
  get_note: 'note:read',
  recall: 'space:read',
  remember_about_user: 'space:write',
  create_note: 'space:write',
  remember_about_project: 'space:write',
  edit_note: 'note:write',
  delete_note: 'note:delete',
  // move_note/rename_note — relocating/retitling a note is a write on the
  // note itself; note:write, the same gate edit_note/link use.
  move_note: 'note:write',
  rename_note: 'note:write',
  // Container reorg — folder move/rename and project rename mutate the
  // SPACE's structure, so space:write (same gate as the REST /move-folder and
  // PATCH /projects routes; a read-only PAT never sees them).
  move_folder: 'space:write',
  rename_folder: 'space:write',
  rename_project: 'space:write',
  link: 'note:write',
  create_notes: 'space:write',
  link_many: 'note:write',
} as const satisfies Record<ToolName, string>
