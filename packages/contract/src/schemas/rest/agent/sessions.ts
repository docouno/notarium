import { z } from 'zod'
import {
  AGENT_CALL_EFFECT,
  AGENT_CALL_OUTCOME,
  AGENT_CALL_TRANSPORT,
  AGENT_SESSION_ATTACH,
  AGENT_TRACE_PROJECTION_VERSION,
  AGENT_TRACE_SCHEMA,
} from '../../../consts/audit'
import { enumValues } from '../../../libs/enumValues'
import { RevisionKindSchema, RevisionUnavailableReasonSchema } from '../../primitives'
import { toolNames } from '../../tools/registry'
import { AgentAuditAggregatesSchema, AgentRetrievalEventSchema } from './audit'

export const AgentSessionAttachSchema = z.enum(enumValues(AGENT_SESSION_ATTACH))

export const AgentSessionSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  named: z.boolean().nullable(),
  parentId: z.string().nullable(),
  createdAt: z.string(),
  lastSeenAt: z.string(),
  /** Exact lifecycle call count while retained; null for an archived audit snapshot. */
  calls: z.number().int().nullable(),
  reads: z.number().int(),
  writes: z.number().int(),
  retained: z.boolean(),
  active: z.boolean(),
  complete: z.boolean(),
})

export const AgentSessionOutsideSchema = z.object({
  reads: z.number().int(),
  writes: z.number().int(),
  lastSeenAt: z.string().nullable(),
})

const CursorSchema = z.string().min(1).max(512)
const databaseTextSchema = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => !value.includes('\0'), { message: 'must not contain NUL' })

export const AgentSessionsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  cursor: CursorSchema.optional(),
  filter: z.enum(['reads', 'writes']).optional(),
  /** Skip whole-history retrieval diagnostics when the caller only needs counts/page rows. */
  aggregates: z.enum(['0']).optional(),
})

export const AgentSessionsResponseSchema = z.object({
  sessions: z.array(AgentSessionSummarySchema),
  total: z.number().int(),
  active: z.number().int(),
  outside: AgentSessionOutsideSchema.nullable(),
  hasMore: z.boolean(),
  nextCursor: CursorSchema.nullable(),
  /** Global retrieval insights retained from the former flat Audit surface. */
  /** Present on the first page unless explicitly opted out; unchanged on later pages. */
  aggregates: AgentAuditAggregatesSchema.nullable(),
})

export const AgentSessionEventsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: CursorSchema.optional(),
    filter: z.enum(['reads', 'writes']).optional(),
    agent: databaseTextSchema(256).optional(),
    tool: z.enum(toolNames).optional(),
    q: databaseTextSchema(4096).optional(),
    outcome: z.enum(['success', 'errors', ...enumValues(AGENT_CALL_OUTCOME)]).optional(),
    aggregates: z.literal('1').optional(),
  })
  .superRefine((value, ctx) => {
    const retrievalTools = new Set(['search', 'recall', 'get_note'])

    if (value.q != null && value.tool != null && !retrievalTools.has(value.tool)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'query requires a retrieval tool' })
    }
    if (value.q != null && value.filter === 'writes') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'query filter only applies to reads',
      })
    }
  })

export const AgentSessionRetrievalEventSchema = AgentRetrievalEventSchema.extend({
  type: z.literal('retrieval'),
  sessionId: z.string().nullable(),
  sessionName: z.string().nullable(),
  sessionAttach: AgentSessionAttachSchema.nullable(),
})

export const AgentSessionWriteEventSchema = z.object({
  type: z.literal('write'),
  id: z.string(),
  at: z.string(),
  principal: z.string().nullable(),
  agent: z.string().nullable(),
  sessionId: z.string().nullable(),
  sessionName: z.string().nullable(),
  sessionAttach: AgentSessionAttachSchema.nullable(),
  noteId: z.string(),
  space: z.string(),
  title: z.string(),
  class: z.string().nullable(),
  revisionKind: RevisionKindSchema,
  /** A journal GAP — see `RevisionUnavailableReasonSchema`. The write still counts
   *  and keeps its place in the session's timeline. */
  unavailableReason: RevisionUnavailableReasonSchema.optional(),
})

export const AgentCallEventSchema = z.object({
  type: z.literal('call'),
  id: z.string(),
  transport: z.enum(enumValues(AGENT_CALL_TRANSPORT)),
  tool: z.string(),
  effect: z.enum(enumValues(AGENT_CALL_EFFECT)),
  domain: z.string(),
  at: z.string(),
  finishedAt: z.string(),
  durationMs: z.number().int().nonnegative(),
  outcome: z.enum(enumValues(AGENT_CALL_OUTCOME)),
  reason: z.string().nullable(),
  principal: z.string(),
  agent: z.string().nullable(),
  sessionId: z.string().nullable(),
  sessionName: z.string().nullable(),
  sessionAttach: AgentSessionAttachSchema.nullable(),
  target: z.json().nullable(),
  result: z.json().nullable(),
  redacted: z.boolean(),
  truncated: z.boolean(),
  detailCaptureFailed: z.boolean(),
  projectionVersion: z.number().int().min(1),
})

export const AgentSessionEventSchema = z.discriminatedUnion('type', [
  AgentCallEventSchema,
  AgentSessionRetrievalEventSchema,
  AgentSessionWriteEventSchema,
])

export const AgentSessionTargetSchema = z.discriminatedUnion('kind', [
  AgentSessionSummarySchema.extend({ kind: z.literal('session') }),
  z.object({ kind: z.literal('outside'), lastSeenAt: z.string().nullable() }),
  z.object({ kind: z.literal('all') }),
])

export const AgentSessionAgentStatSchema = z.object({
  agent: z.string(),
  count: z.number().int(),
})

export const AgentSessionEventAggregatesSchema = z.object({
  retrieval: AgentAuditAggregatesSchema,
  agents: z.array(AgentSessionAgentStatSchema),
  recurringProblems: z.array(
    z.object({
      fingerprint: z.string(),
      tool: z.string(),
      issues: z.json().nullable(),
      count: z.number().int().positive(),
      firstAt: z.string(),
      lastAt: z.string(),
      agents: z.number().int().positive(),
    }),
  ),
})

export const AgentSessionEventsResponseSchema = z.object({
  target: AgentSessionTargetSchema,
  events: z.array(AgentSessionEventSchema),
  total: z.number().int().nullable(),
  hasMore: z.boolean(),
  nextCursor: CursorSchema.nullable(),
  aggregates: AgentSessionEventAggregatesSchema.nullable(),
})

export const AgentCallDetailResponseSchema = AgentCallEventSchema.extend({
  requestId: z.string().nullable(),
  inputBytes: z.number().int().nonnegative(),
  outputBytes: z.number().int().nonnegative().nullable(),
  inputShape: z.json(),
  issues: z.json().nullable(),
  detailed: z.discriminatedUnion('status', [
    z.object({ status: z.literal('available'), payload: z.json() }),
    z.object({ status: z.literal('disabled') }),
    z.object({ status: z.literal('expired_or_missing') }),
  ]),
  links: z.object({
    retrievals: z.array(AgentSessionRetrievalEventSchema),
    revisions: z.array(AgentSessionWriteEventSchema),
  }),
})

const AgentTelemetryCompactRetentionDaysSchema = z.union([
  z.literal(30),
  z.literal(90),
  z.literal(180),
  z.literal(365),
])
const AgentTelemetryDetailedRetentionDaysSchema = z.union([
  z.literal(7),
  z.literal(30),
  z.literal(90),
])

export const AgentTelemetryConfigSchema = z.object({
  available: z.literal(true),
  detailedEnabled: z.boolean(),
  compactRetentionDays: AgentTelemetryCompactRetentionDaysSchema,
  detailedRetentionDays: AgentTelemetryDetailedRetentionDaysSchema,
  versionToken: z.string(),
  updatedAt: z.string(),
  projectionVersion: z.literal(AGENT_TRACE_PROJECTION_VERSION),
  compactDisclosure: z.object({
    retrievalQuery: z.literal(true),
    topHitTitles: z.literal(true),
    rawContent: z.literal(false),
  }),
})

export const AgentTelemetryConfigPatchSchema = z
  .object({
    versionToken: z.string(),
    detailedEnabled: z.boolean().optional(),
    compactRetentionDays: AgentTelemetryCompactRetentionDaysSchema.optional(),
    detailedRetentionDays: AgentTelemetryDetailedRetentionDaysSchema.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.detailedEnabled !== undefined ||
      value.compactRetentionDays !== undefined ||
      value.detailedRetentionDays !== undefined,
    { message: 'provide at least one change' },
  )

export const AgentSessionDeleteQuerySchema = z.object({
  confirmActive: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .default(false),
})

export const AgentSessionDeleteAcceptedSchema = z.object({ status: z.literal('deleting') })
export const AgentSessionDeleteActiveConflictSchema = z.object({
  reason: z.literal('active_session'),
  session: AgentSessionSummarySchema,
})

export const AgentTraceExportMetadataSchema = z.object({
  type: z.literal('metadata'),
  schema: z.literal(AGENT_TRACE_SCHEMA),
  generatedAt: z.string(),
  target: AgentSessionTargetSchema,
  projectionVersion: z.number().int(),
  redactionVersion: z.number().int(),
  build: z.object({ name: z.string(), version: z.string() }),
  filters: z.object({}),
  telemetry: z.object({
    detailedEnabled: z.boolean(),
    compactRetentionDays: AgentTelemetryCompactRetentionDaysSchema,
    detailedRetentionDays: AgentTelemetryDetailedRetentionDaysSchema,
  }),
  complete: z.boolean(),
})
export const AgentTraceExportEventSchema = z.object({
  type: z.literal('event'),
  event: AgentSessionEventSchema,
  detail: z
    .object({
      detailed: z.json().nullable(),
      links: z.object({
        retrievals: z.array(AgentSessionRetrievalEventSchema),
        revisions: z.array(AgentSessionWriteEventSchema),
      }),
    })
    .optional(),
})
export const AgentTraceExportSummarySchema = z.object({
  type: z.literal('summary'),
  events: z.number().int().nonnegative(),
  complete: z.literal(true),
})

export type AgentSessionSummary = z.infer<typeof AgentSessionSummarySchema>
export type AgentSessionOutside = z.infer<typeof AgentSessionOutsideSchema>
export type AgentSessionsQuery = z.infer<typeof AgentSessionsQuerySchema>
export type AgentSessions = z.infer<typeof AgentSessionsResponseSchema>
export type AgentSessionEventsQuery = z.infer<typeof AgentSessionEventsQuerySchema>
export type AgentSessionEvent = z.infer<typeof AgentSessionEventSchema>
export type AgentCallEvent = z.infer<typeof AgentCallEventSchema>
export type AgentCallDetail = z.infer<typeof AgentCallDetailResponseSchema>
export type AgentTelemetryConfig = z.infer<typeof AgentTelemetryConfigSchema>
export type AgentTelemetryConfigPatch = z.infer<typeof AgentTelemetryConfigPatchSchema>
export type AgentSessionRetrievalEvent = z.infer<typeof AgentSessionRetrievalEventSchema>
export type AgentSessionWriteEvent = z.infer<typeof AgentSessionWriteEventSchema>
export type AgentSessionTarget = z.infer<typeof AgentSessionTargetSchema>
export type AgentSessionAgentStat = z.infer<typeof AgentSessionAgentStatSchema>
export type AgentSessionEventAggregates = z.infer<typeof AgentSessionEventAggregatesSchema>
export type AgentSessionEvents = z.infer<typeof AgentSessionEventsResponseSchema>
