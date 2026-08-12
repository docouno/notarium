import { z } from 'zod'
import { AGENT_SESSION_ATTACH } from '../../../consts/audit'
import { enumValues } from '../../../libs/enumValues'
import { RevisionKindSchema, RevisionUnavailableReasonSchema } from '../../primitives'
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
})

export const AgentSessionOutsideSchema = z.object({
  reads: z.number().int(),
  writes: z.number().int(),
  lastSeenAt: z.string(),
})

const CursorSchema = z.string().min(1).max(512)

export const AgentSessionsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  cursor: CursorSchema.optional(),
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

export const AgentSessionEventsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: CursorSchema.optional(),
  filter: z.enum(['reads', 'writes']).optional(),
})

export const AgentSessionRetrievalEventSchema = AgentRetrievalEventSchema.extend({
  type: z.literal('retrieval'),
  sessionAttach: AgentSessionAttachSchema.nullable(),
})

export const AgentSessionWriteEventSchema = z.object({
  type: z.literal('write'),
  id: z.string(),
  at: z.string(),
  principal: z.string().nullable(),
  agent: z.string().nullable(),
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

export const AgentSessionEventSchema = z.discriminatedUnion('type', [
  AgentSessionRetrievalEventSchema,
  AgentSessionWriteEventSchema,
])

export const AgentSessionTargetSchema = z.discriminatedUnion('kind', [
  AgentSessionSummarySchema.extend({ kind: z.literal('session') }),
  AgentSessionOutsideSchema.extend({ kind: z.literal('outside') }),
])

export const AgentSessionEventsResponseSchema = z.object({
  target: AgentSessionTargetSchema,
  events: z.array(AgentSessionEventSchema),
  total: z.number().int(),
  hasMore: z.boolean(),
  nextCursor: CursorSchema.nullable(),
})

export type AgentSessionSummary = z.infer<typeof AgentSessionSummarySchema>
export type AgentSessionOutside = z.infer<typeof AgentSessionOutsideSchema>
export type AgentSessionsQuery = z.infer<typeof AgentSessionsQuerySchema>
export type AgentSessions = z.infer<typeof AgentSessionsResponseSchema>
export type AgentSessionEventsQuery = z.infer<typeof AgentSessionEventsQuerySchema>
export type AgentSessionEvent = z.infer<typeof AgentSessionEventSchema>
export type AgentSessionRetrievalEvent = z.infer<typeof AgentSessionRetrievalEventSchema>
export type AgentSessionWriteEvent = z.infer<typeof AgentSessionWriteEventSchema>
export type AgentSessionTarget = z.infer<typeof AgentSessionTargetSchema>
export type AgentSessionEvents = z.infer<typeof AgentSessionEventsResponseSchema>
