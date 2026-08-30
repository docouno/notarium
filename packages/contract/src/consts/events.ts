/** Named SSE channels — `event: <name>` frames on GET /api/s/:space/events, distinct from
 *  the StoreEvent `data:` frames. Each is a nudge: the space/principal ones carry an empty
 *  body (truth is the named REST route), `job` carries the job's wire status (validated on
 *  emit against SseJobPayloadSchema / JobSchema in schemas/rest/jobs.ts). */
export const SSE_EVENT = {
  /** Principal grants changed → client re-syncs. Truth is /api/auth/session. */
  ACCESS: 'access',
  /** Space membership changed → viewers refetch GET /members. */
  MEMBERS: 'members',
  /** Space slug changed → viewers adopt it live. Truth is /api/spaces. */
  RENAME: 'rename',
  /** Owner's durable agent sessions changed → owner tabs refetch their session views. */
  AGENT_SESSIONS: 'agent-sessions',
  /** Owner-scoped async-job progress. */
  JOB: 'job',
  /** Changed ids from explicitly watched cross-space Context rows. */
  CONTEXT_CHANGED: 'context-changed',
  /** Every authorised active/supplemental bus is subscribed; a handoff may commit. */
  READY: 'ready',
} as const

export type SseEvent = (typeof SSE_EVENT)[keyof typeof SSE_EVENT]

/** StoreEvent data-frame `type` discriminants — distinct from the SSE channel names above. */
export const STORE_EVENT = {
  STATUS: 'status',
  CHANGED: 'changed',
  GRAPH: 'graph',
} as const

export type StoreEventType = (typeof STORE_EVENT)[keyof typeof STORE_EVENT]
