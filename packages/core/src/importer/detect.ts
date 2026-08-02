// Auto-detect an export's format from its CONTENT (the filename is only a hint —
// all three sources ship a file literally named `conversations.json`). Content
// detection is robust: memory.json is JSONL with `type` discriminators; ChatGPT
// conversations carry a `mapping` graph; Claude conversations carry
// `chat_messages`; Claude projects carry `docs`/`prompt_template`.

import { IMPORT_FORMAT } from './consts'
import type { ImportFormat } from './consts'

/** First non-empty trimmed line — cheap peek for the JSONL (memory-json) case
 *  without parsing a possibly-huge file. */
const firstLine = (raw: string): string => {
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim()

    if (t) {
      return t
    }
  }

  return ''
}

const looksLikeMemoryJson = (raw: string): boolean => {
  const first = firstLine(raw)

  if (!first.startsWith('{')) {
    return false
  }
  try {
    const o = JSON.parse(first) as Record<string, unknown>
    return (
      o.type === 'entity' ||
      o.type === 'relation' ||
      (typeof o.entityType === 'string' && Array.isArray(o.observations))
    )
  } catch {
    return false
  }
}

/** Detect the array-format from ONE element's shape (the streaming path sniffs
 *  the first element instead of parsing the whole array). Mirrors the per-item
 *  checks in detectFormat. Returns null for memory records (those are JSONL, not
 *  array elements) and the unrecognisable. */
export const detectFromArrayItem = (item: unknown): ImportFormat | null => {
  if (!item || typeof item !== 'object') {
    return null
  }
  const o = item as Record<string, unknown>

  if (o.mapping && typeof o.mapping === 'object') {
    return IMPORT_FORMAT.chatgpt
  }
  if (Array.isArray(o.chat_messages)) {
    return IMPORT_FORMAT.claudeConversations
  }
  if (Array.isArray(o.docs) || typeof o.prompt_template === 'string') {
    return IMPORT_FORMAT.claudeProjects
  }
  // Claude account memory: `memories.json` items carry `*_memory` blobs.
  if (typeof o.conversations_memory === 'string' || typeof o.projects_memory === 'string') {
    return IMPORT_FORMAT.claudeMemory
  }

  return null
}

/** Detect a SINGLE-object member's format: the evolved Claude export ships
 *  one project / one design-chat PER FILE, not as an array. Null for the
 *  unrecognised (the caller surfaces it as a skipped member). MCP single-object
 *  memory (`{entities,relations}`) is handled separately, before this. */
export const detectSingleObject = (obj: unknown): ImportFormat | null => {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return null
  }
  const o = obj as Record<string, unknown>

  if (Array.isArray(o.messages)) {
    return IMPORT_FORMAT.claudeDesignChat
  }
  if (Array.isArray(o.docs) || typeof o.prompt_template === 'string') {
    return IMPORT_FORMAT.claudeProjects
  }
  if (typeof o.conversations_memory === 'string' || typeof o.projects_memory === 'string') {
    return IMPORT_FORMAT.claudeMemory
  }

  return null
}

/** Is this parsed JSONL record a memory-graph entity/relation? (the streaming
 *  path peeks the first line to choose the JSONL-memory branch). */
export const isMemoryRecord = (o: Record<string, unknown>): boolean =>
  o.type === 'entity' ||
  o.type === 'relation' ||
  Boolean(o.relationType) ||
  Boolean(o.relation_type) ||
  (typeof o.entityType === 'string' && Array.isArray(o.observations))

/** Is a parsed JSON ROOT the single-object memory shape `{entities,relations}`
 *  (not JSONL, not an array)? */
export const isMemoryObject = (o: unknown): boolean =>
  Boolean(o) &&
  typeof o === 'object' &&
  !Array.isArray(o) &&
  (Array.isArray((o as Record<string, unknown>).entities) ||
    Array.isArray((o as Record<string, unknown>).relations))

export const detectFormat = (raw: string): ImportFormat | null => {
  if (looksLikeMemoryJson(raw)) {
    return IMPORT_FORMAT.memoryJson
  }
  let data: unknown

  try {
    data = JSON.parse(raw)
  } catch {
    return null
  }
  if (isMemoryObject(data)) {
    return IMPORT_FORMAT.memoryJson
  }
  // A single-object member: one project / design-chat / memory per file.
  if (!Array.isArray(data)) {
    return detectSingleObject(data)
  }
  if (!data.length) {
    return null
  }
  // Sniff the first few records (the head may be a stray/empty object).
  for (const item of data.slice(0, 5)) {
    const fmt = detectFromArrayItem(item)

    if (fmt) {
      return fmt
    }
  }

  return null
}
