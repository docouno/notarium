// Claude `conversations.json` → notes. The claude.ai data export ships a
// JSON ARRAY of conversations; one conversation → one note, the messages
// rendered as `### Human/Assistant (timestamp)` sections (readable).

import { IMPORT_SOURCE } from '../consts'
import { convoFileName, shortHash, stampOf, toIso } from '../helpers/format'
import type { ImportNote } from '../types'

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

/** One conversation → one note (the streaming unit). null when the record is too
 *  empty to be a conversation (no id/name/messages). `index` only seeds a
 *  fallback title for the rare unnamed-and-idless case. */
export const claudeConversationToNote = (
  conv: ClaudeConversation,
  index = 0,
): ImportNote | null => {
  const uuid = conv?.uuid || ''

  if (!uuid && !conv?.name && !conv?.chat_messages?.length) {
    return null
  }
  const title = (conv.name || '').trim() || `Conversation ${uuid || index + 1}`
  const createdAt = toIso(conv.created_at)
  const body = (conv.chat_messages ?? []).map(renderMessage).filter(Boolean).join('\n\n')

  // No renderable content (every message empty in the export) → not a note.
  if (!body.trim()) {
    return null
  }
  // The id keys the deterministic filename. Without one (rare), key on the index
  // + a body hash so two idless same-titled chats don't collide onto one file.
  const sourceId = uuid || `${index}-${shortHash(body)}`
  return {
    title,
    body,
    directory: 'conversations/claude',
    tags: ['claude', 'conversation'],
    noteType: 'conversation',
    createdAt: createdAt ?? undefined,
    fileName: convoFileName(title, createdAt, sourceId),
    source: IMPORT_SOURCE.claude,
  }
}

export const parseClaudeConversations = (
  data: unknown,
): { notes: ImportNote[]; warnings: string[] } => {
  if (!Array.isArray(data)) {
    return { notes: [], warnings: ['claude conversations: expected a JSON array'] }
  }
  const notes: ImportNote[] = []
  let empty = 0
  data.forEach((conv, i) => {
    const note = claudeConversationToNote(conv as ClaudeConversation, i)

    if (note) {
      notes.push(note)
    } else {
      empty++
    }
  })
  const warnings: string[] = []

  if (!notes.length) {
    warnings.push('claude conversations: no conversations found')
  }
  if (empty) {
    warnings.push(`claude conversations: skipped ${empty} conversation(s) with no content`)
  }

  return { notes, warnings }
}
