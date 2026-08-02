// Claude `memories.json` → notes. The evolved claude.ai export ships an
// account memory file: a JSON ARRAY whose items carry markdown blobs under
// `*_memory` keys (today `conversations_memory`, an "about the user" summary;
// `projects_memory` appears in some accounts). This is NOT the MCP memory-server
// `{entities,relations}` graph (that's `memory-json`) — it's a handful of prose
// documents, so each blob becomes one note. Routed as `source: 'memory'`, so the
// import's memory-destination option (folder / space / skip) governs it.

import { slugify } from '../../libs/slug'
import { IMPORT_SOURCE } from '../consts'
import { shortHash } from '../helpers/format'
import type { ImportNote } from '../types'

type ClaudeMemoryItem = Record<string, unknown> & { account_uuid?: string }

/** A `conversations_memory` → "Conversations memory" heading-style title. */
const titleOfKey = (key: string): string => {
  const words = key.replace(/_/g, ' ').trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** One memory item → a note per non-empty `*_memory` string field. The filename
 *  is keyed on the field + account so a re-import overwrites the same file and two
 *  accounts' `conversations_memory` don't collide. */
export const claudeMemoryItemToNotes = (item: ClaudeMemoryItem): ImportNote[] => {
  if (!item || typeof item !== 'object') {
    return []
  }
  const account = typeof item.account_uuid === 'string' ? item.account_uuid : ''
  const notes: ImportNote[] = []

  for (const [key, value] of Object.entries(item)) {
    if (!/_memory$/.test(key) || typeof value !== 'string' || !value.trim()) {
      continue
    }
    notes.push({
      title: titleOfKey(key),
      body: value.trim(),
      directory: 'memory/claude',
      tags: ['claude', 'memory'],
      noteType: 'memory',
      fileName: `${slugify(key) || 'memory'}${account ? `-${shortHash(account)}` : ''}`,
      source: IMPORT_SOURCE.memory,
    })
  }

  return notes
}

export const parseClaudeMemory = (data: unknown): { notes: ImportNote[]; warnings: string[] } => {
  const items: ClaudeMemoryItem[] = Array.isArray(data)
    ? (data as ClaudeMemoryItem[])
    : data && typeof data === 'object'
      ? [data as ClaudeMemoryItem]
      : []
  const notes = items.flatMap(claudeMemoryItemToNotes)
  const warnings = notes.length ? [] : ['claude memory: no *_memory fields found']
  return { notes, warnings }
}
