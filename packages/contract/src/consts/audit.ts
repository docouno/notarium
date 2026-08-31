export const AGENT_RETRIEVAL_TOOL = {
  search: 'search',
  recall: 'recall',
  getNote: 'get_note',
} as const

export type AgentRetrievalTool = (typeof AGENT_RETRIEVAL_TOOL)[keyof typeof AGENT_RETRIEVAL_TOOL]

export const AGENT_SESSION_ATTACH = {
  declared: 'declared',
  inferred: 'inferred',
} as const

export type AgentSessionAttach = (typeof AGENT_SESSION_ATTACH)[keyof typeof AGENT_SESSION_ATTACH]

export const AGENT_CALL_EFFECT = {
  read: 'read',
  mutation: 'mutation',
  control: 'control',
} as const

export type AgentCallEffect = (typeof AGENT_CALL_EFFECT)[keyof typeof AGENT_CALL_EFFECT]

export const AGENT_CALL_OUTCOME = {
  success: 'success',
  invalidArguments: 'invalid_arguments',
  denied: 'denied',
  toolError: 'tool_error',
  internalError: 'internal_error',
} as const

export type AgentCallOutcome = (typeof AGENT_CALL_OUTCOME)[keyof typeof AGENT_CALL_OUTCOME]

export const AGENT_CALL_TRANSPORT = {
  mcp: 'mcp',
} as const

export type AgentCallTransport = (typeof AGENT_CALL_TRANSPORT)[keyof typeof AGENT_CALL_TRANSPORT]

export const AGENT_TELEMETRY_COMPACT_RETENTION_DAYS = [30, 90, 180, 365] as const
export type AgentTelemetryCompactRetentionDays =
  (typeof AGENT_TELEMETRY_COMPACT_RETENTION_DAYS)[number]

export const AGENT_TELEMETRY_DETAILED_RETENTION_DAYS = [7, 30, 90] as const
export type AgentTelemetryDetailedRetentionDays =
  (typeof AGENT_TELEMETRY_DETAILED_RETENTION_DAYS)[number]

export const AGENT_TRACE_SCHEMA = 'notarium-agent-trace-v1'
export const AGENT_TRACE_PROJECTION_VERSION = 1
