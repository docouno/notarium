import { z } from 'zod'
import { AGENT_SESSION_STATE } from '../../consts/tools'
import { enumValues } from '../../libs/enumValues'
import { IsoTimestampSchema, RevisionKindSchema } from '../primitives'
import { PatScopeSchema } from '../rest/pats'
import { AgentSessionIdSchema, locationFields } from './_fields'
import {
  CapabilitiesSchema,
  FolderEntrySchema,
  ProjectHandleSchema,
  ProjectSummarySchema,
  RESPONSE_FORMAT,
  ResponseFormatSchema,
} from './primitives'

export const WhoamiInputSchema = z.object({})

/** Tool `whoami`: the principal, its action ceiling (`read | write`), reachable
 *  projects and engine capabilities. canon: docs/mcp-gateway.md#tools */
export const WhoamiOutputSchema = z.object({
  principal: z.string(),
  scope: PatScopeSchema,
  projects: z.array(ProjectSummarySchema),
  capabilities: CapabilitiesSchema,
})

export const GetMyProjectsInputSchema = z.object({})

/** Tool `get_my_projects`: the project workspaces you can access (personal-domain
 *  projects appear by handle too). canon: docs/note-model.md#note-ontology */
export const GetMyProjectsOutputSchema = z.object({
  projects: z.array(ProjectSummarySchema),
})

export const StartSessionInputSchema = z.object({
  /** Hint (a project handle); without it the bundle is user-level only (profile
   *  + projects). */
  project: ProjectHandleSchema.optional(),
  /** Free-form task hint; no v1 effect. */
  task: z.string().optional(),
  /** Address an existing session by id, or open/resume/fork by a non-unique name.
   * Exactly one key avoids silently accepting a stale id/name pair. */
  session: z
    .object({
      id: AgentSessionIdSchema.optional(),
      name: z.string().trim().min(1).max(160).optional(),
    })
    .refine((value) => Number(value.id !== undefined) + Number(value.name !== undefined) === 1, {
      message: 'provide exactly one of id or name',
    })
    .optional(),
  /** Whether to advance lastSeen[token, project]. Default true; `false` = peek the
   *  delta without moving the bookmark (keeps the tool idempotent). */
  acknowledge: z.boolean().default(true),
  responseFormat: ResponseFormatSchema.default(RESPONSE_FORMAT.concise),
})

/** The user-level always-load bundle: a derived index of the user's agent-memory
 *  (one entry per category) plus the curated always-load user-docs.
 *  canon: docs/note-model.md#agent-memory */
export const SessionProfileSchema = z.object({
  memory: z.array(z.object({ noteId: z.string(), category: z.string(), summary: z.string() })),
  alwaysLoad: z.array(z.object({ noteId: z.string(), title: z.string() })),
})

/** One change since the principal last looked. `locationFields` is the per-entry
 *  disambiguator so a `project`-hinted agent tells its own changes from a sibling
 *  project's in a shared space (the delta is the space revision stream, not
 *  path-indexed). */
export const DeltaEntrySchema = z.object({
  noteId: z.string(),
  title: z.string(),
  kind: RevisionKindSchema,
  principal: z.string().nullable(),
  ...locationFields,
  modifiedAt: IsoTimestampSchema,
})

/** The per-token, per-project delta. `total` is the full change count;
 *  `changes` is the budgeted window with `truncated` when it didn't all fit. */
export const DeltaSchema = z.object({
  changes: z.array(DeltaEntrySchema),
  total: z.number(),
  truncated: z.boolean().optional(),
})

/** One self-describe entry (name + summary) — always sent as insurance for weak
 *  models that skipped the server `instructions`. */
export const ToolHelpSchema = z.object({ name: z.string(), summary: z.string() })

export const AgentSessionSchema = z.object({
  id: AgentSessionIdSchema,
  name: z.string(),
  named: z.boolean(),
  state: z.enum(enumValues(AGENT_SESSION_STATE)),
  parentId: AgentSessionIdSchema.optional(),
  hint: z.string(),
})

export const RecentAgentSessionSchema = z.object({
  id: AgentSessionIdSchema,
  name: z.string(),
  lastActiveAt: IsoTimestampSchema,
  active: z.boolean(),
  calls: z.number().int().nonnegative(),
})

/** Tool `start_session`: server-side composition of the 4–5 discovery calls; the
 *  `project` sub-bundle rides only when a project hint was given.
 *  canon: docs/mcp-gateway.md#tools */
export const StartSessionOutputSchema = z.object({
  /** Absent on a host without the sessions capability, or when a non-unique name
   * needs an explicit id choice from recentSessions. */
  session: AgentSessionSchema.optional(),
  recentSessions: z.array(RecentAgentSessionSchema).optional(),
  profile: SessionProfileSchema,
  projects: z.array(ProjectSummarySchema),
  project: z
    .object({
      /** A COMPACT orientation summary (note count + top-level folders), NOT the full
       *  note list — enumerate with `list_notes`. */
      index: z.object({
        noteCount: z.number().int(),
        folders: z.array(FolderEntrySchema),
      }),
      /** The curated always-load notes of THIS project (user-docs tagged
       *  `always-load`) — the per-project axis vs the personal `profile.alwaysLoad`. */
      alwaysLoad: z.array(z.object({ noteId: z.string(), title: z.string() })),
      delta: DeltaSchema,
      /** The vocabulary already in use here (so an agent reuses terms, not coins
       *  synonyms): `categories` from agent-memory, `tags` from frontmatter. */
      knownValues: z
        .object({
          categories: z.array(z.string()),
          tags: z.array(z.string()),
        })
        .optional(),
    })
    .optional(),
  toolsHelp: z.array(ToolHelpSchema),
  truncated: z.boolean().optional(),
})

export type WhoamiInput = z.infer<typeof WhoamiInputSchema>

export type WhoamiOutput = z.infer<typeof WhoamiOutputSchema>

export type GetMyProjectsInput = z.infer<typeof GetMyProjectsInputSchema>

export type GetMyProjectsOutput = z.infer<typeof GetMyProjectsOutputSchema>

export type StartSessionInput = z.infer<typeof StartSessionInputSchema>

export type SessionProfile = z.infer<typeof SessionProfileSchema>

export type DeltaEntry = z.infer<typeof DeltaEntrySchema>

export type Delta = z.infer<typeof DeltaSchema>

export type ToolHelp = z.infer<typeof ToolHelpSchema>

export type AgentSession = z.infer<typeof AgentSessionSchema>

export type RecentAgentSession = z.infer<typeof RecentAgentSessionSchema>

export type StartSessionOutput = z.infer<typeof StartSessionOutputSchema>
