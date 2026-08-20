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

/** Frozen readable-byte budget of the pre-source-locator basename. It is still
 * needed to compute exact legacy predecessor evidence; new source-aware names
 * reserve their 96-bit suffix from the ordinary basename budget. */
export const IMPORT_SLUG_MAX_BYTES = 180

/** A generated importer-owned directory is a bare filesystem component (no `.md`
 *  suffix), so it may use the host's full 255-byte component budget. Existing names
 *  below the boundary stay byte-for-byte stable; only an actual overflow is bounded. */
export const IMPORT_DIRECTORY_MAX_BYTES = 255
