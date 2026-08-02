import { z } from 'zod'
import { AGENT_RETRIEVAL_TOOL } from '../../../consts/audit'
import { enumValues } from '../../../libs/enumValues'

/** The read tools the audit captures: the agent's runtime retrieval surface.
 *  Writes/mutations are out of scope — the audit answers "what did the agent look FOR
 *  and did it find it", not "what did it change". `get_note` is the follow-through (an
 *  opened result), not a query — it feeds the "found, but did they open it" signal. */
export const AgentRetrievalToolSchema = z.enum(enumValues(AGENT_RETRIEVAL_TOOL))

/** One hit a retrieval returned: the note it surfaced and — for `search` — its
 *  engine-native `score` (recall/get_note carry none). `title` is a cheap label taken
 *  at capture time; the id is the durable address (the note may since move/rename).
 *  `class` (user-doc / agent-memory) both routes the "open" to the right surface (/n vs
 *  /m) and tells the reader whether the agent found this in a doc or its OWN memory.
 *  Only the top few per event are kept — enough to read the row, not the whole result. */
export const AgentRetrievalHitSchema = z.object({
  noteId: z.string(),
  title: z.string().optional(),
  score: z.number().optional(),
  class: z.string().optional(),
})

/** One captured retrieval call: what the agent searched (`tool` + `query`, plus
 *  the optional `project` scope / `classFilter` it narrowed to) and what came back
 *  (`resultCount`, `topScore`, the top `hits`). `topScore` is null for recall/get_note
 *  (no score) and for a zero-result search. `project` is null for a whole-reach fan-out.
 *  `agent` is the friendly name of the token/app that made the call (a PAT's name or a
 *  connected app's, captured at write time — self-scoped, so it's always the viewer's own
 *  agent); `principal` is the raw id behind it. The owner axis is the viewer, so the
 *  username isn't echoed. `at` = call time. */
export const AgentRetrievalEventSchema = z.object({
  id: z.string(),
  at: z.string(),
  tool: AgentRetrievalToolSchema,
  query: z.string(),
  project: z.string().nullable(),
  classFilter: z.string().nullable(),
  resultCount: z.number().int(),
  topScore: z.number().nullable(),
  hits: z.array(AgentRetrievalHitSchema),
  agent: z.string().nullable(),
  principal: z.string().nullable(),
})

/** GET /api/me/agent-audit query: a windowed, newest-first history of the
 *  viewer's OWN agent retrievals. `tool` narrows to one tool; `filter='misses'` keeps
 *  only the zero-result calls — the "searched but didn't find" signal that is the point
 *  of the audit. The first page may use offset (legacy/list idiom); follow-up pages use
 *  the keyset cursor (`beforeAt` + `beforeId`) from the last rendered row, so new live
 *  retrievals inserted above the page do not shift the next page into duplicates/skips. */
const AgentAuditCursorId = z
  .string()
  .regex(/^\d+$/)
  .refine((v) => {
    const n = Number(v)
    return Number.isSafeInteger(n) && n > 0
  }, 'cursor id must be a safe positive integer')

export const AgentAuditQuerySchema = z.object({
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  tool: AgentRetrievalToolSchema.optional(),
  filter: z.enum(['misses']).optional(),
  beforeAt: z.string().datetime({ offset: true }).optional(),
  beforeId: AgentAuditCursorId.optional(),
  /** `aggregates=0` opts OUT of the whole-history aggregate scan — the client passes it when
   *  it already holds them (a tool-filter switch: aggregates are tool-independent), so the
   *  server skips the scan and returns `aggregates: null` (like an appended page). */
  aggregates: z.enum(['0']).optional(),
})

/** One aggregated query line: a distinct query text, how many times the agent
 *  ran it, how many of those came back empty (`misses`), and when it last ran. Powers
 *  both "frequently searched" (rank by `count`) and "recurring blind spots" (rank by
 *  `misses`). A miss is a ZERO-result call — the reliable signal; "relevant but not in
 *  the top" needs re-running the query against memory and is a separate job, not captured
 *  here. */
export const AgentAuditQueryStatSchema = z.object({
  query: z.string(),
  tool: AgentRetrievalToolSchema,
  count: z.number().int(),
  misses: z.number().int(),
  lastAt: z.string(),
})

/** The audit's whole-history aggregates: the rollup the header + the "blind
 *  spots" panel read. `totalQueries` counts search+recall calls (get_note is a
 *  follow-through, not a query); `missCount` how many of those returned zero. `top` and
 *  `misses` are the ranked query lines (by count / by misses). */
export const AgentAuditAggregatesSchema = z.object({
  totalQueries: z.number().int(),
  missCount: z.number().int(),
  top: z.array(AgentAuditQueryStatSchema),
  misses: z.array(AgentAuditQueryStatSchema),
})

/** GET /api/me/agent-audit — the viewer's own agent-retrieval audit: the
 *  windowed history (newest-first) plus the whole-history aggregates. Self-scoped
 *  (`self:read`), like the memory audit. Empty everywhere on a host that never captured
 *  one — a meta-DB-less host simply never logs (honest zero-state, not an error).
 *  @see docs/architecture.md#p5 */
export const AgentAuditResponseSchema = z.object({
  events: z.array(AgentRetrievalEventSchema),
  total: z.number().int(),
  hasMore: z.boolean(),
  nextCursor: z.object({ beforeAt: z.string(), beforeId: z.string() }).nullable(),
  /** Whole-history (tool-independent) aggregates — computed on the FIRST page only (no
   *  cursor); `null` on an appended page, where they are unchanged and the client keeps the
   *  ones it already holds (so infinite-scroll doesn't re-scan the whole log every page). */
  aggregates: AgentAuditAggregatesSchema.nullable(),
})
export type AgentRetrievalHit = z.infer<typeof AgentRetrievalHitSchema>

export type AgentRetrievalEvent = z.infer<typeof AgentRetrievalEventSchema>

export type AgentAuditQuery = z.infer<typeof AgentAuditQuerySchema>

export type AgentAuditQueryStat = z.infer<typeof AgentAuditQueryStatSchema>

export type AgentAuditAggregates = z.infer<typeof AgentAuditAggregatesSchema>

export type AgentAudit = z.infer<typeof AgentAuditResponseSchema>
