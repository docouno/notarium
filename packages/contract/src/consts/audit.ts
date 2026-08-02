export const AGENT_RETRIEVAL_TOOL = {
  search: 'search',
  recall: 'recall',
  getNote: 'get_note',
} as const

export type AgentRetrievalTool = (typeof AGENT_RETRIEVAL_TOOL)[keyof typeof AGENT_RETRIEVAL_TOOL]
