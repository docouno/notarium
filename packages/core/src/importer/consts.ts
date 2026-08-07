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

/** How many UTF-8 BYTES of the readable part of an imported file name survive. The
 *  rest of the 255-byte component budget belongs to the `<YYYYMMDD>-` prefix and the
 *  `-<hash8>` suffix that make a re-import idempotent, plus `.md`. Counted in bytes,
 *  not characters; storage keys remain on the legacy ASCII handle algebra so a
 *  re-import after a slug implementation upgrade still lands on its old path. */
export const IMPORT_SLUG_MAX_BYTES = 180

/** A generated importer-owned directory is a bare filesystem component (no `.md`
 *  suffix), so it may use the host's full 255-byte component budget. Existing names
 *  below the boundary stay byte-for-byte stable; only an actual overflow is bounded. */
export const IMPORT_DIRECTORY_MAX_BYTES = 255
