// Domain constants for the importer.

/** Which export SHAPE a file is, auto-detected from content. */
export const IMPORT_FORMAT = {
  claudeConversations: 'claude-conversations',
  claudeProjects: 'claude-projects',
  claudeMemory: 'claude-memory',
  claudeDesignChat: 'claude-design-chat',
  chatgpt: 'chatgpt',
  memoryJson: 'memory-json',
  markdown: 'markdown',
} as const

/** The tool family a note came from — a provenance tag and the routing key. */
export const IMPORT_SOURCE = {
  claude: 'claude',
  chatgpt: 'chatgpt',
  memory: 'memory',
  file: 'file',
} as const

export type ImportFormat = (typeof IMPORT_FORMAT)[keyof typeof IMPORT_FORMAT]
export type ImportSource = (typeof IMPORT_SOURCE)[keyof typeof IMPORT_SOURCE]
