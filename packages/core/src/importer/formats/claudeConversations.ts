// Claude `conversations.json` → notes. The claude.ai data export ships a
// JSON ARRAY of conversations; one conversation → one note, the messages
// rendered as `### Human/Assistant (timestamp)` sections (readable).

import { IMPORT_SOURCE } from '../consts'
import { convoFileName, stampOf, toIso } from '../helpers/format'
import {
  failedImportRecord,
  importedNote,
  partitionImportOutcomes,
  skippedImportRecord,
} from '../outcomes'
import { sourceNoteFileName } from '../placement'
import { claudeConversationSourceLocator } from '../sourceLocator'
import type { ImportRecordOutcome } from '../types'

type ClaudeAttachment = { file_name?: string; extracted_content?: string }
type ClaudeFile = { file_name?: string; file_uuid?: string }
type ClaudeContentBlock = { text?: unknown }
type ClaudeMessage = {
  sender?: string
  text?: unknown
  created_at?: string
  content?: ClaudeContentBlock[]
  attachments?: ClaudeAttachment[]
  files?: ClaudeFile[]
}
type ClaudeConversation = {
  uuid?: string
  name?: string
  created_at?: string
  updated_at?: string
  chat_messages?: ClaudeMessage[]
}

/** A message's text: the `content` blocks win when present (richer than the flat
 *  `text`), else the flat `text`. The `.text` STRING-guard matters — real Claude
 *  exports interleave non-text blocks (tool_use/thinking) whose `text` is an
 *  object; a bare `?? ''` would stringify it to `[object Object]` into the body. */
const messageText = (m: ClaudeMessage): string => {
  if (Array.isArray(m.content) && m.content.length) {
    const joined = m.content
      .map((b) => (typeof b?.text === 'string' ? b.text : ''))
      .filter(Boolean)
      .join(' ')
      .trim()

    if (joined) {
      return joined
    }
  }

  return (typeof m.text === 'string' ? m.text : '').trim()
}

const renderMessage = (m: ClaudeMessage): string => {
  const body: string[] = [messageText(m)]

  for (const a of m.attachments ?? []) {
    if (!a?.file_name && !a?.extracted_content) {
      continue
    }
    body.push(`**Attachment: ${a.file_name ?? 'file'}**`)
    if (a.extracted_content) {
      body.push('```\n' + a.extracted_content + '\n```')
    }
  }
  // Uploaded files: binary refs (`file_name`/`file_uuid` only — the bytes
  // aren't in the export). Render a breadcrumb so an image-only turn keeps its
  // provenance instead of vanishing into an empty note; the bytes themselves wait
  // on the attachment class (same seam as export). A nameless ref (only file_uuid,
  // ~⅓ of real refs) still gets a generic crumb — the upload fact stays visible.
  for (const f of m.files ?? []) {
    if (f?.file_name) {
      body.push(`**File: ${f.file_name}**`)
    } else if (f?.file_uuid) {
      body.push('**File: (uploaded file)**')
    }
  }
  const content = body.filter(Boolean).join('\n\n')

  // An empty message (no text, no attachments — the export ships these) emits
  // NOTHING, not an orphan `### Role (ts)` header. Mirrors the chatgpt side.
  if (!content) {
    return ''
  }
  const role =
    m.sender === 'assistant' ? 'Assistant' : m.sender === 'human' ? 'Human' : m.sender || 'Message'
  const stamp = stampOf(toIso(m.created_at))
  return `### ${role}${stamp ? ` (${stamp})` : ''}\n\n${content}`
}

/** One conversation → one record outcome (the streaming unit). `index` only
 * seeds a diagnostic title for the rare unnamed-and-idless failure. */
export const claudeConversationToNote = (
  conv: ClaudeConversation,
  index = 0,
): ImportRecordOutcome => {
  const uuid = conv?.uuid || ''

  if (!uuid && !conv?.name && !conv?.chat_messages?.length) {
    return skippedImportRecord('not a conversation')
  }
  const title = (conv.name || '').trim() || `Conversation ${uuid || index + 1}`
  const createdAt = toIso(conv.created_at)
  const body = (conv.chat_messages ?? []).map(renderMessage).filter(Boolean).join('\n\n')

  // No renderable content (every message empty in the export) → not a note.
  if (!body.trim()) {
    return skippedImportRecord('conversation has no renderable content')
  }
  const sourceLocator = claudeConversationSourceLocator(uuid)

  if (!sourceLocator) {
    return failedImportRecord(title, 'claude conversation: missing durable uuid')
  }

  return importedNote({
    title,
    body,
    directory: 'conversations/claude',
    tags: ['claude', 'conversation'],
    noteType: 'conversation',
    createdAt: createdAt ?? undefined,
    fileName: sourceNoteFileName(title, sourceLocator, createdAt),
    legacyDirectory: 'conversations/claude',
    legacyFileName: convoFileName(title, createdAt, uuid),
    source: IMPORT_SOURCE.claude,
    sourceLocator,
  })
}

export const parseClaudeConversations = (
  data: unknown,
): ReturnType<typeof partitionImportOutcomes> & { warnings: string[] } => {
  if (!Array.isArray(data)) {
    return {
      notes: [],
      failures: [],
      skipped: 0,
      warnings: ['claude conversations: expected a JSON array'],
    }
  }
  const outcomes = data.map((conv, i) => claudeConversationToNote(conv as ClaudeConversation, i))
  const { notes, failures, skipped } = partitionImportOutcomes(outcomes)
  const warnings: string[] = []

  if (!notes.length && !failures.length) {
    warnings.push('claude conversations: no conversations found')
  }
  if (skipped) {
    warnings.push(`claude conversations: skipped ${skipped} conversation(s) with no content`)
  }

  return { notes, failures, skipped, warnings }
}
