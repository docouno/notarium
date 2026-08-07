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
