export const EDIT_OPERATION = {
  append: 'append',
  prepend: 'prepend',
  replace: 'replace',
  replaceSection: 'replaceSection',
  findReplace: 'findReplace',
} as const

export type EditOperation = (typeof EDIT_OPERATION)[keyof typeof EDIT_OPERATION]

export const RESPONSE_FORMAT = {
  concise: 'concise',
  detailed: 'detailed',
} as const

export type ResponseFormat = (typeof RESPONSE_FORMAT)[keyof typeof RESPONSE_FORMAT]

export const WRITE_OUTCOME = {
  created: 'created',
  appended: 'appended',
  skipped: 'skipped',
} as const

export type WriteOutcome = (typeof WRITE_OUTCOME)[keyof typeof WRITE_OUTCOME]

export const AGENT_SESSION_STATE = {
  new: 'new',
  resumed: 'resumed',
  forked: 'forked',
} as const

export type AgentSessionState = (typeof AGENT_SESSION_STATE)[keyof typeof AGENT_SESSION_STATE]
