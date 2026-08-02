// Claude `design_chats/<uuid>.json` → a note. A design/artifact chat is a
// single conversation OBJECT (one file each), shaped unlike `conversations.json`:
// `messages` (not `chat_messages`), each `{ role, content, created_at }` where
// `content` is itself `{ role, content: <text> }` (the text nested one level), or
// a bare string. One chat → one note, rendered like the other transcripts.

import { slugify } from '../../libs/slug'
import { IMPORT_SOURCE } from '../consts'
import { convoFileName, stampOf, toIso } from '../helpers/format'
import type { ImportNote } from '../types'

type DesignBlock = { type?: string; text?: unknown }
type DesignContent = { content?: unknown } | string
type DesignMessage = { role?: string; content?: DesignContent; text?: unknown; created_at?: string }
type DesignChat = {
  uuid?: string
  title?: string
  project?: { uuid?: string; name?: string }
  created_at?: string
  updated_at?: string
  messages?: DesignMessage[]
}

/** A design message's text. `content` is usually `{ role, content: '…' }`, but
 *  tolerate a bare string and an array of `{text}` blocks; never stringify an
 *  object into the body. */
const messageText = (m: DesignMessage): string => {
  const c = m.content

  if (typeof c === 'string') {
    return c.trim()
  }
  if (c && typeof c === 'object') {
    const inner = (c as { content?: unknown }).content

    if (typeof inner === 'string') {
      return inner.trim()
    }
    if (Array.isArray(inner)) {
      return (inner as DesignBlock[])
        .map((b) => (typeof b === 'string' ? b : typeof b?.text === 'string' ? b.text : ''))
        .filter(Boolean)
        .join('\n')
        .trim()
    }
  }

  return (typeof m.text === 'string' ? m.text : '').trim()
}

const renderMessage = (m: DesignMessage): string => {
  const role =
    m.role === 'assistant' ? 'Assistant' : m.role === 'user' ? 'User' : m.role || 'Message'
  const stamp = stampOf(toIso(m.created_at ?? null))
  const text = messageText(m)

  if (!text) {
    return ''
  }

  return `### ${role}${stamp ? ` (${stamp})` : ''}\n\n${text}`
}

/** One design chat → one note (the streaming unit). null when there's no message
 *  list. Grouped under `design-chats/<project>` so a project's chats sit together
 *  even though each is its own file. */
export const claudeDesignChatToNote = (chat: DesignChat, index = 0): ImportNote | null => {
  if (!chat || typeof chat !== 'object' || !Array.isArray(chat.messages)) {
    return null
  }
  const title = (chat.title || '').trim() || 'Design chat'
  const createdAt = toIso(chat.created_at ?? null)
  const body = chat.messages.map(renderMessage).filter(Boolean).join('\n\n')

  // No renderable content (voice/asset-only design chat) → not a note,
  // mirroring the conversation parsers; this also activates the empty-counter in
  // the streaming processSingleObject path.
  if (!body.trim()) {
    return null
  }
  const project = (chat.project?.name || '').trim()
  const sub = project ? `/${slugify(project) || 'project'}` : ''
  const sourceId = chat.uuid || `${index}`
  return {
    title,
    body,
    directory: `design-chats${sub}`,
    tags: ['claude', 'design-chat'],
    noteType: 'conversation',
    createdAt: createdAt ?? undefined,
    fileName: convoFileName(title, createdAt, sourceId),
    source: IMPORT_SOURCE.claude,
  }
}

export const parseClaudeDesignChat = (
  data: unknown,
): { notes: ImportNote[]; warnings: string[] } => {
  const chats: DesignChat[] = Array.isArray(data) ? (data as DesignChat[]) : [data as DesignChat]
  const notes = chats
    .map((c, i) => claudeDesignChatToNote(c, i))
    .filter((n): n is ImportNote => n != null)
  const warnings = notes.length ? [] : ['claude design chat: no renderable content']
  return { notes, warnings }
}
