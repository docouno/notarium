// ChatGPT `conversations.json` → notes. The openai export ships a JSON
// ARRAY of conversations, but a conversation is a NODE GRAPH (`mapping`), not a
// flat list: branches/regenerations live as siblings. We linearise it — find
// the root (parent == null), pre-order DFS pushing children reversed so they pop
// in original order — then render the visible messages.

import { IMPORT_SOURCE } from '../consts'
import { convoFileName, shortHash, stampOf, toIso } from '../helpers/format'
import type { ImportNote } from '../types'

type ChatGptContent = {
  content_type?: string
  parts?: unknown[]
  text?: string
  result?: string
  content?: string
  language?: string
}
type ChatGptMessage = {
  author?: { role?: string }
  create_time?: number | null
  content?: ChatGptContent
  recipient?: string
  metadata?: { is_visually_hidden_from_conversation?: boolean; is_user_system_message?: boolean }
}
type ChatGptNode = {
  id?: string
  message?: ChatGptMessage | null
  parent?: string | null
  children?: string[]
}
type ChatGptConversation = {
  title?: string
  create_time?: number
  update_time?: number
  conversation_id?: string
  id?: string
  mapping?: Record<string, ChatGptNode>
}

/** The child adjacency for a mapping, UNIONING both edge sources so no message is
 *  lost. Classic exports ship explicit `children` arrays (branch order
 *  encoded); the real openai export as of 2026 ships ONLY `parent` pointers and NO
 *  `children` — a child-driven DFS over the latter never descends past the root, so
 *  EVERY body comes out empty. We take explicit children first (preserving their
 *  order), then ADD any parent-pointer edge not already present (ordered by
 *  `create_time`, since key/insertion order isn't reliably chronological). Pure
 *  classic and pure parent-only each reduce to one source; a mixed/inconsistent
 *  export keeps every reachable node either way. */
const childrenOf = (mapping: Record<string, ChatGptNode>): Map<string, string[]> => {
  const ids = Object.keys(mapping)
  const adjacency = new Map<string, string[]>()
  const seen = new Map<string, Set<string>>()

  const add = (parent: string, child: string): void => {
    let kids = adjacency.get(parent)

    if (!kids) {
      adjacency.set(parent, (kids = []))
    }
    let s = seen.get(parent)

    if (!s) {
      seen.set(parent, (s = new Set()))
    }
    if (s.has(child)) {
      return
    }
    s.add(child)
    kids.push(child)
  }

  // 1. explicit children — classic branch order.
  for (const id of ids) {
    for (const child of mapping[id]?.children ?? []) {
      if (mapping[child]) {
        add(id, child)
      }
    }
  }
  // 2. parent pointers — the children-less variant; append edges not already present,
  //    grouped per parent and ordered by create_time.
  const stamp = (id: string): number => mapping[id]?.message?.create_time ?? 0
  const byParent = new Map<string, string[]>()

  for (const id of ids) {
    const parent = mapping[id]?.parent

    if (parent == null || !mapping[parent]) {
      continue
    } // root / dangling — not a child edge
    const kids = byParent.get(parent) ?? []
    kids.push(id)
    byParent.set(parent, kids)
  }
  for (const [parent, kids] of byParent) {
    kids.sort((a, b) => stamp(a) - stamp(b))
    for (const child of kids) {
      add(parent, child)
    }
  }

  return adjacency
}

/** Pre-order walk of the message tree: roots first,
 *  children in original order, each node visited once. Real exports legitimately
 *  carry MULTIPLE roots (a detached system/context node beside the conversation
 *  root, forks) — walk them ALL, or whole message subtrees go missing. When no
 *  node has `parent == null` (corrupt/cyclic mapping) fall back to the nodes that
 *  nobody lists as a child (true roots by reverse edge), else every node, so a
 *  conversation never silently empties. */
const traverse = (mapping: Record<string, ChatGptNode>): ChatGptMessage[] => {
  const ids = Object.keys(mapping)
  const adjacency = childrenOf(mapping)
  let roots = ids.filter((k) => mapping[k]?.parent == null)

  if (!roots.length) {
    const childSet = new Set([...adjacency.values()].flat())
    roots = ids.filter((k) => !childSet.has(k))
    if (!roots.length) {
      roots = ids
    } // fully cyclic — emit everything rather than nothing
  }
  const out: ChatGptMessage[] = []
  const seen = new Set<string>()
  const stack = [...roots].reverse()

  while (stack.length) {
    const id = stack.pop()!

    if (seen.has(id)) {
      continue
    }
    seen.add(id)
    const node = mapping[id]

    if (!node) {
      continue
    }
    if (node.message) {
      out.push(node.message)
    }
    const children = adjacency.get(id) ?? []

    for (let i = children.length - 1; i >= 0; i--) {
      stack.push(children[i])
    }
  }

  return out
}

/** A content part's text. CRITICAL: in current ChatGPT exports
 *  `parts` items are frequently OBJECTS (`{content_type:'text',text:'…'}` /
 *  `{type:'text',text:'…'}`), not bare strings — the old string-only map turned
 *  every object part into '' and emptied every body. Strings pass through; object
 *  parts yield their `.text`/`.content`; image-pointer/other objects → ''. */
const partText = (part: unknown): string => {
  if (typeof part === 'string') {
    return part
  }
  if (part && typeof part === 'object') {
    const o = part as Record<string, unknown>

    if (typeof o.text === 'string') {
      return o.text
    }
    if (typeof o.content === 'string') {
      return o.content
    }
  }

  return ''
}

const partsToText = (parts: unknown[] | undefined): string =>
  (parts ?? []).map(partText).filter(Boolean).join('\n').trim()

/** A message's human-readable text across the content shapes current exports
 *  produce. `parts` first (the common text/multimodal case), then the
 *  content-type-specific fields (code/execution_output/tether/reasoning). */
const messageContent = (c: ChatGptContent | undefined): string => {
  if (!c) {
    return ''
  }
  if (c.content_type === 'code') {
    const text = typeof c.text === 'string' ? c.text : partsToText(c.parts)
    return text ? '```' + (c.language || '') + '\n' + text + '\n```' : ''
  }
  if (c.content_type === 'user_editable_context') {
    return ''
  } // custom-instructions blob, not a turn
  const fromParts = partsToText(c.parts)

  if (fromParts) {
    return fromParts
  }
  // Fallbacks for shapes that carry text outside `parts`.
  if (typeof c.text === 'string' && c.text) {
    return c.text
  }
  if (typeof c.result === 'string' && c.result) {
    return c.result
  }
  if (typeof c.content === 'string' && c.content) {
    return c.content
  }

  return ''
}

/** Internal content types that are machinery, never a visible turn. */
const HIDDEN_CONTENT = new Set([
  'system_error',
  'tether_browsing_display',
  'tether_browsing_code',
  'thoughts',
  'reasoning_recap',
  'sonic_webpage',
])

/** Whether a message is a human-visible user/assistant turn. `is_visually_hidden`
 *  alone isn't enough — system (non-user), tool roles, code-interpreter input and
 *  tool-recipient assistant messages are all internal noise (research: convoviz
 *  `is_message_hidden`). `recipient==='all'` is the "shown to the user" signal. */
const isVisible = (m: ChatGptMessage): boolean => {
  if (!m?.author || m.metadata?.is_visually_hidden_from_conversation) {
    return false
  }
  const role = m.author.role
  const type = m.content?.content_type

  if (role === 'system') {
    return Boolean(m.metadata?.is_user_system_message)
  }
  if (role === 'tool') {
    return false
  }
  if (type && HIDDEN_CONTENT.has(type)) {
    return false
  }
  // An assistant message addressed to a tool (recipient 'python'/a plugin) is a
  // tool CALL, not the user-facing reply — drop it. `all`/absent = the visible turn
  // (a code block in a real reply rides as markdown text, or as recipient-'all' code).
  if (role === 'assistant' && m.recipient && m.recipient !== 'all') {
    return false
  }

  return true
}

const renderMessage = (m: ChatGptMessage): string => {
  if (!isVisible(m)) {
    return ''
  }
  const content = messageContent(m.content)

  if (!content) {
    return ''
  }
  const role = m.author?.role || 'message'
  const label = role.charAt(0).toUpperCase() + role.slice(1)
  const stamp = stampOf(toIso(m.create_time ?? null))
  return `### ${label}${stamp ? ` (${stamp})` : ''}\n\n${content}`
}

/** One ChatGPT conversation (a mapping graph) → one note (the streaming unit).
 *  null when the record has no message graph. `index` disambiguates an idless
 *  conversation's filename. */
export const chatGptConversationToNote = (
  conv: ChatGptConversation,
  index = 0,
): ImportNote | null => {
  if (!conv?.mapping || typeof conv.mapping !== 'object') {
    return null
  }
  const title = (conv.title || '').trim() || 'Untitled'
  const createdAt = toIso(conv.create_time ?? null)
  const body = traverse(conv.mapping).map(renderMessage).filter(Boolean).join('\n\n')

  // A conversation with no renderable text (an abandoned/voice/asset-only chat the
  // export left content-less) isn't worth an empty note — skip it.
  if (!body.trim()) {
    return null
  }
  // Without a stable id, key the filename on the index + a body hash so two
  // idless 'Untitled' chats don't collide onto one file.
  const sourceId = conv.conversation_id || conv.id || `${index}-${shortHash(body)}`
  return {
    title,
    body,
    directory: 'conversations/chatgpt',
    tags: ['chatgpt', 'conversation'],
    noteType: 'conversation',
    createdAt: createdAt ?? undefined,
    fileName: convoFileName(title, createdAt, sourceId),
    source: IMPORT_SOURCE.chatgpt,
  }
}

export const parseChatGpt = (data: unknown): { notes: ImportNote[]; warnings: string[] } => {
  if (!Array.isArray(data)) {
    return { notes: [], warnings: ['chatgpt: expected a JSON array'] }
  }
  const notes: ImportNote[] = []
  let empty = 0
  data.forEach((conv, i) => {
    const note = chatGptConversationToNote(conv as ChatGptConversation, i)

    if (note) {
      notes.push(note)
    } else {
      empty++
    }
  })
  const warnings: string[] = []

  if (!notes.length) {
    warnings.push('chatgpt: no conversations found')
  }
  if (empty) {
    warnings.push(`chatgpt: skipped ${empty} conversation(s) with no content`)
  }

  return { notes, warnings }
}
