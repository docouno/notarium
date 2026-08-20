// Claude `design_chats/<uuid>.json` → a note. A design/artifact chat is a
// single conversation OBJECT (one file each), shaped unlike `conversations.json`:
// `messages` (not `chat_messages`), each `{ role, content, created_at }` where
// `content` is itself `{ role, content: <text> }` (the text nested one level), or
// a bare string. One chat → one note, rendered like the other transcripts.

import { IMPORT_SOURCE } from '../consts'
import { convoFileName, importerDirectorySlug, stampOf, toIso } from '../helpers/format'
import {
  failedImportRecord,
  importedNote,
  partitionImportOutcomes,
  skippedImportRecord,
} from '../outcomes'
import { portableDisplayGroup, sourceNoteFileName, sourceProjectDirectoryName } from '../placement'
import { claudeDesignChatSourceLocator, claudeProjectPlacementLocator } from '../sourceLocator'
import type { ImportRecordOutcome } from '../types'

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

/** One design chat → one record outcome. Project-bound chats share the project's
 * source-tagged directory; an unbound chat uses portable display grouping. */
export const claudeDesignChatToNote = (chat: DesignChat): ImportRecordOutcome => {
  if (!chat || typeof chat !== 'object' || !Array.isArray(chat.messages)) {
    return skippedImportRecord('design chat has no message list')
  }
  const title = (chat.title || '').trim() || 'Design chat'
  const createdAt = toIso(chat.created_at ?? null)
  const body = chat.messages.map(renderMessage).filter(Boolean).join('\n\n')

  // No renderable content (voice/asset-only design chat) → not a note,
  // mirroring the conversation parsers; this also activates the empty-counter in
  // the streaming processSingleObject path.
  if (!body.trim()) {
    return skippedImportRecord('design chat has no renderable content')
  }
  const project = (chat.project?.name || '').trim()
  const projectSlug = importerDirectorySlug(project)
  // Preserve the pre-#296 fallback exactly as predecessor evidence. The host
  // refuses a source-less occupant there instead of guessing or duplicating it.
  const sub = project ? `/${projectSlug || 'project'}` : ''
  const sourceLocator = claudeDesignChatSourceLocator(chat.uuid)

  if (!sourceLocator) {
    return failedImportRecord(title, 'claude design chat: missing durable uuid')
  }
  const projectLocator = claudeProjectPlacementLocator(chat.project?.uuid)
  const directory = projectLocator
    ? `projects/${sourceProjectDirectoryName(project, projectLocator)}/design-chats`
    : project
      ? `design-chats/${portableDisplayGroup(project)}`
      : 'design-chats'

  return importedNote({
    title,
    body,
    directory,
    tags: ['claude', 'design-chat'],
    noteType: 'conversation',
    createdAt: createdAt ?? undefined,
    fileName: sourceNoteFileName(title, sourceLocator, createdAt),
    legacyDirectory: `design-chats${sub}`,
    legacyFileName: convoFileName(title, createdAt, chat.uuid!),
    source: IMPORT_SOURCE.claude,
    sourceLocator,
  })
}

export const parseClaudeDesignChat = (
  data: unknown,
): ReturnType<typeof partitionImportOutcomes> & { warnings: string[] } => {
  const chats: DesignChat[] = Array.isArray(data) ? (data as DesignChat[]) : [data as DesignChat]
  const partitioned = partitionImportOutcomes(chats.map((chat) => claudeDesignChatToNote(chat)))
  const warnings =
    partitioned.notes.length || partitioned.failures.length
      ? []
      : ['claude design chat: no renderable content']
  return { ...partitioned, warnings }
}
