import { describe, expect, it } from 'vitest'

import { detectFormat } from './detect'
import { ImportError, parseImport } from './importer'

// ── fixtures: minimal-but-real shapes of each export format ──────────────────

const CLAUDE_CONVERSATIONS = JSON.stringify([
  {
    uuid: 'c-001',
    name: 'Planning the trip',
    created_at: '2024-03-15T14:30:00Z',
    updated_at: '2024-03-15T15:00:00Z',
    chat_messages: [
      { sender: 'human', created_at: '2024-03-15T14:30:00Z', text: 'Where should we go?' },
      {
        sender: 'assistant',
        created_at: '2024-03-15T14:30:05Z',
        content: [{ type: 'text', text: 'How about Lisbon?' }],
        attachments: [{ file_name: 'budget.txt', extracted_content: '500 EUR' }],
      },
    ],
  },
  { uuid: 'c-002', name: 'Untitled', created_at: '2024-03-15T09:00:00Z', chat_messages: [] },
])

const CHATGPT = JSON.stringify([
  {
    title: 'Recipe ideas',
    create_time: 1710512400, // 2024-03-15T14:20:00Z
    update_time: 1710512500,
    conversation_id: 'g-001',
    mapping: {
      root: { id: 'root', message: null, parent: null, children: ['a'] },
      a: {
        id: 'a',
        parent: 'root',
        children: ['b'],
        message: {
          author: { role: 'user' },
          create_time: 1710512400,
          content: { content_type: 'text', parts: ['Give me a recipe'] },
          metadata: {},
        },
      },
      b: {
        id: 'b',
        parent: 'a',
        children: ['c'],
        message: {
          author: { role: 'assistant' },
          create_time: 1710512405,
          content: { content_type: 'code', language: 'python', text: 'print("pasta")' },
          metadata: {},
        },
      },
      c: {
        id: 'c',
        parent: 'b',
        children: [],
        message: {
          author: { role: 'tool' },
          content: { content_type: 'text', parts: ['hidden'] },
          metadata: { is_visually_hidden_from_conversation: true },
        },
      },
    },
  },
])

const MEMORY_JSON = [
  JSON.stringify({
    type: 'entity',
    name: 'Alice',
    entityType: 'person',
    observations: ['Likes tea', 'Works at Acme'],
  }),
  JSON.stringify({
    type: 'entity',
    name: 'Acme',
    entityType: 'organization',
    observations: ['Founded 2010'],
  }),
  JSON.stringify({ type: 'relation', from: 'Alice', to: 'Acme', relationType: 'works at' }),
  JSON.stringify({ type: 'entity', entityType: 'ghost', observations: ['no name'] }),
].join('\n')

const CLAUDE_PROJECTS = JSON.stringify([
  {
    uuid: 'p-001',
    name: 'Acme Redesign',
    created_at: '2024-01-10T09:00:00Z',
    updated_at: '2024-01-20T12:00:00Z',
    prompt_template: 'You are a design assistant.',
    docs: [
      {
        uuid: 'd-001',
        filename: 'brief.md',
        content: '# Brief\nDo the thing.',
        created_at: '2024-01-11T09:00:00Z',
      },
    ],
  },
])

// ── detection ────────────────────────────────────────────────────────────────

describe('detectFormat', () => {
  it('recognises each format from content alone', () => {
    expect(detectFormat(CLAUDE_CONVERSATIONS)).toBe('claude-conversations')
    expect(detectFormat(CHATGPT)).toBe('chatgpt')
    expect(detectFormat(MEMORY_JSON)).toBe('memory-json')
    expect(detectFormat(CLAUDE_PROJECTS)).toBe('claude-projects')
  })
  it('returns null on unrecognised input', () => {
    expect(detectFormat('not json')).toBeNull()
    expect(detectFormat('[]')).toBeNull()
    expect(detectFormat('{"hello":"world"}')).toBeNull()
  })
})

// ── Claude conversations ─────────────────────────────────────────────────────

describe('claude conversations', () => {
  it('one note per conversation with content; an empty conversation is skipped (#113)', () => {
    const { format, notes, warnings } = parseImport(CLAUDE_CONVERSATIONS)
    expect(format).toBe('claude-conversations')
    // c-002 has no messages → content-less → skipped (not an empty note), surfaced.
    expect(notes).toHaveLength(1)
    expect(warnings.join(' ')).toContain('skipped 1')
    const [trip] = notes
    expect(trip.title).toBe('Planning the trip')
    expect(trip.directory).toBe('conversations/claude')
    expect(trip.createdAt).toBe('2024-03-15T14:30:00.000Z')
    expect(trip.source).toBe('claude')
    expect(trip.body).toContain('### Human (2024-03-15 14:30:00)')
    expect(trip.body).toContain('Where should we go?')
    expect(trip.body).toContain('### Assistant')
    expect(trip.body).toContain('How about Lisbon?')
    expect(trip.body).toContain('**Attachment: budget.txt**')
    expect(trip.body).toContain('500 EUR')
  })

  it('an empty message emits no orphan `### Role` header (#113)', () => {
    const data = JSON.stringify([
      {
        uuid: 'c-empty-msg',
        name: 'Mixed',
        chat_messages: [
          { sender: 'human', created_at: '2024-03-15T14:30:00Z', text: '' }, // empty → no header
          { sender: 'assistant', created_at: '2024-03-15T14:30:05Z', text: 'real answer' },
        ],
      },
    ])
    const body = parseImport(data).notes[0].body
    expect(body).toContain('### Assistant')
    expect(body).toContain('real answer')
    expect(body).not.toContain('### Human') // the empty human turn produced nothing
  })

  it('an image-only turn keeps a file breadcrumb instead of vanishing (#113)', () => {
    const data = JSON.stringify([
      {
        uuid: 'c-img',
        name: 'Picture',
        chat_messages: [
          {
            sender: 'human',
            created_at: '2024-03-15T14:30:00Z',
            text: '',
            files: [{ file_name: 'photo.png', file_uuid: 'u-1' }],
          },
        ],
      },
    ])
    const note = parseImport(data).notes[0]
    expect(note).toBeDefined() // not skipped — the file reference is content
    expect(note.body).toContain('**File: photo.png**')
  })

  it('a nameless file ref (only file_uuid) still leaves a generic breadcrumb (#113)', () => {
    const data = JSON.stringify([
      {
        uuid: 'c-nf',
        name: 'Nameless',
        chat_messages: [
          {
            sender: 'human',
            created_at: '2024-03-15T14:30:00Z',
            text: '',
            files: [{ file_uuid: 'u-2' }],
          },
        ],
      },
    ])
    const note = parseImport(data).notes[0]
    expect(note).toBeDefined() // ~⅓ of real refs are nameless — the upload fact stays visible
    expect(note.body).toContain('**File: (uploaded file)**')
  })

  it('filenames are deterministic, date-prefixed and source-id-disambiguated', () => {
    const { notes } = parseImport(CLAUDE_CONVERSATIONS)
    expect(notes[0].fileName).toMatch(/^20240315-planning-the-trip-[a-z0-9]{8}$/)
    // Re-parsing the same export yields identical filenames (idempotent path).
    const again = parseImport(CLAUDE_CONVERSATIONS).notes
    expect(again.map((n) => n.fileName)).toEqual(notes.map((n) => n.fileName))
  })
})

// ── ChatGPT ──────────────────────────────────────────────────────────────────

describe('chatgpt', () => {
  it('linearises the mapping graph, renders code, skips hidden nodes', () => {
    const { format, notes } = parseImport(CHATGPT)
    expect(format).toBe('chatgpt')
    expect(notes).toHaveLength(1)
    const [n] = notes
    expect(n.title).toBe('Recipe ideas')
    expect(n.directory).toBe('conversations/chatgpt')
    expect(n.createdAt).toBe('2024-03-15T14:20:00.000Z')
    expect(n.body).toContain('### User')
    expect(n.body).toContain('Give me a recipe')
    expect(n.body).toContain('### Assistant')
    expect(n.body).toContain('```python\nprint("pasta")\n```')
    // The hidden tool node is dropped.
    expect(n.body).not.toContain('hidden')
  })

  // The real-world bug: current exports wrap text parts as OBJECTS, and
  // interleave system/tool noise. The old string-only extractor emptied every body.
  it('extracts object-shaped text parts and filters system/tool noise', () => {
    const data = JSON.stringify([
      {
        title: 'Modern shape',
        create_time: 1710512400,
        conversation_id: 'm-1',
        mapping: {
          root: { id: 'root', message: null, parent: null, children: ['sys', 'u', 'a', 'tool'] },
          sys: {
            id: 'sys',
            parent: 'root',
            children: [],
            message: {
              author: { role: 'system' },
              content: { content_type: 'text', parts: [''] },
              metadata: { is_user_system_message: false },
            },
          },
          u: {
            id: 'u',
            parent: 'root',
            children: [],
            message: {
              author: { role: 'user' },
              recipient: 'all',
              content: {
                content_type: 'text',
                parts: [{ content_type: 'text', text: 'Plan my week' }],
              },
              metadata: {},
            },
          },
          a: {
            id: 'a',
            parent: 'root',
            children: [],
            message: {
              author: { role: 'assistant' },
              recipient: 'all',
              content: { content_type: 'text', parts: [{ type: 'text', text: 'Here is a plan.' }] },
              metadata: { is_visually_hidden_from_conversation: false },
            },
          },
          tool: {
            id: 'tool',
            parent: 'root',
            children: [],
            message: {
              author: { role: 'tool', name: 'browser' },
              content: { content_type: 'tether_browsing_display', result: 'search noise' },
              metadata: {},
            },
          },
        },
      },
    ])
    const { notes } = parseImport(data)
    expect(notes).toHaveLength(1)
    const body = notes[0].body
    expect(body).toContain('### User')
    expect(body).toContain('Plan my week') // object text part, not emptied
    expect(body).toContain('### Assistant')
    expect(body).toContain('Here is a plan.')
    expect(body).not.toContain('search noise') // tool/tether node dropped
    expect(body).not.toContain('### System') // non-user system message dropped
  })

  // The real-world bug: the current openai export is a PARENT-POINTER tree —
  // every node has `parent` but NO `children` array. The child-driven DFS never
  // descended, so EVERY body came out empty. Edges are reconstructed from parents.
  // (This mapping is a LINEAR chain given out of key order; branch-sibling ordering
  // by create_time is covered by the dedicated branching test below.)
  it('linearises a parent-pointer mapping (no `children`) in chronological order', () => {
    const data = JSON.stringify([
      {
        title: 'Parent pointers',
        create_time: 1710512400,
        conversation_id: 'pp-1',
        mapping: {
          // Deliberately out of order, no `children` anywhere, root has no message.
          a2: {
            id: 'a2',
            parent: 'u2',
            message: {
              author: { role: 'assistant' },
              recipient: 'all',
              create_time: 1710512430,
              content: { content_type: 'text', parts: ['Second answer'] },
            },
          },
          u1: {
            id: 'u1',
            parent: 'root',
            message: {
              author: { role: 'user' },
              create_time: 1710512400,
              content: { content_type: 'text', parts: ['First question'] },
            },
          },
          root: { id: 'root', parent: null, message: null },
          u2: {
            id: 'u2',
            parent: 'a1',
            message: {
              author: { role: 'user' },
              create_time: 1710512420,
              content: { content_type: 'text', parts: ['Second question'] },
            },
          },
          a1: {
            id: 'a1',
            parent: 'u1',
            message: {
              author: { role: 'assistant' },
              recipient: 'all',
              create_time: 1710512410,
              content: { content_type: 'text', parts: ['First answer'] },
            },
          },
        },
      },
    ])
    const [n] = parseImport(data).notes
    expect(n.body).toContain('First question')
    expect(n.body).toContain('Second answer')
    // Chronological: question → answer → question → answer (not mapping/key order).
    const order = ['First question', 'First answer', 'Second question', 'Second answer'].map((s) =>
      n.body.indexOf(s),
    )
    expect(order).toEqual([...order].sort((x, y) => x - y))
    expect(order.every((i) => i >= 0)).toBe(true)
  })

  // Guards the create_time sort specifically: a BRANCH — one user turn with
  // two assistant regenerations whose mapping keys are in REVERSE chronological
  // order. Only sorting siblings by create_time yields the right transcript order;
  // insertion/key order would put the later regen first.
  it('orders branch siblings by create_time, not mapping key order', () => {
    const data = JSON.stringify([
      {
        title: 'Branches',
        conversation_id: 'b-1',
        mapping: {
          root: { id: 'root', parent: null, message: null },
          u1: {
            id: 'u1',
            parent: 'root',
            message: {
              author: { role: 'user' },
              create_time: 1710512400,
              content: { content_type: 'text', parts: ['the question'] },
            },
          },
          // Keys deliberately reverse-chronological: zlater (t=30) before aearlier (t=20).
          zlater: {
            id: 'zlater',
            parent: 'u1',
            message: {
              author: { role: 'assistant' },
              recipient: 'all',
              create_time: 1710512430,
              content: { content_type: 'text', parts: ['LATER regen'] },
            },
          },
          aearlier: {
            id: 'aearlier',
            parent: 'u1',
            message: {
              author: { role: 'assistant' },
              recipient: 'all',
              create_time: 1710512420,
              content: { content_type: 'text', parts: ['EARLIER regen'] },
            },
          },
        },
      },
    ])
    const body = parseImport(data).notes[0].body
    expect(body).toContain('EARLIER regen')
    expect(body.indexOf('EARLIER regen')).toBeLessThan(body.indexOf('LATER regen'))
  })

  // a ChatGPT conversation with no renderable content (abandoned / voice /
  // asset-only — only hidden/tool nodes) is skipped, not written as an empty note.
  it('skips a content-less ChatGPT conversation, surfacing the count', () => {
    const data = JSON.stringify([
      {
        title: 'Real',
        conversation_id: 'r-1',
        mapping: {
          root: { id: 'root', parent: null, message: null },
          u: {
            id: 'u',
            parent: 'root',
            message: { author: { role: 'user' }, content: { content_type: 'text', parts: ['hi'] } },
          },
        },
      },
      {
        title: 'Empty',
        conversation_id: 'e-1',
        mapping: {
          root: { id: 'root', parent: null, message: null },
          t: {
            id: 't',
            parent: 'root',
            message: {
              author: { role: 'tool' },
              content: { content_type: 'tether_browsing_display', result: 'noise' },
            },
          },
        },
      },
    ])
    const { notes, warnings } = parseImport(data)
    expect(notes).toHaveLength(1)
    expect(notes[0].title).toBe('Real')
    expect(warnings.join(' ')).toContain('skipped 1')
  })

  // Guards the UNION in childrenOf: a MIXED mapping where some edges are
  // explicit `children` and a deeper node is reachable ONLY via its `parent`
  // pointer. An explicit-children-only walk (the old binary switch) would lose u2.
  it('UNION: a mixed mapping (explicit children + a parent-only node) loses no message', () => {
    const data = JSON.stringify([
      {
        title: 'Mixed',
        conversation_id: 'mx-1',
        mapping: {
          root: { id: 'root', parent: null, children: ['u1'], message: null },
          u1: {
            id: 'u1',
            parent: 'root',
            children: ['a1'],
            message: { author: { role: 'user' }, content: { content_type: 'text', parts: ['Q1'] } },
          },
          a1: {
            id: 'a1',
            parent: 'u1',
            message: {
              author: { role: 'assistant' },
              recipient: 'all',
              content: { content_type: 'text', parts: ['A1'] },
            },
          }, // no children array
          u2: {
            id: 'u2',
            parent: 'a1',
            message: { author: { role: 'user' }, content: { content_type: 'text', parts: ['Q2'] } },
          }, // reachable ONLY via parent
        },
      },
    ])
    const body = parseImport(data).notes[0].body

    for (const t of ['Q1', 'A1', 'Q2']) {
      expect(body).toContain(t)
    }
  })
})

// ── memory-json ──────────────────────────────────────────────────────────────

describe('memory-json', () => {
  it('one note per entity, observations + relation wikilinks, skips nameless', () => {
    const { format, notes, warnings } = parseImport(MEMORY_JSON)
    expect(format).toBe('memory-json')
    expect(notes).toHaveLength(2)
    const alice = notes.find((n) => n.title === 'Alice')!
    expect(alice.directory).toBe('memory/person')
    expect(alice.fileName).toBe('alice')
    expect(alice.body).toContain('- Likes tea')
    expect(alice.body).toContain('- works at [[Acme]]')
    expect(warnings.join(' ')).toContain('skipped 1')
  })
})

// ── Claude projects ──────────────────────────────────────────────────────────

describe('claude projects', () => {
  it('project folder with docs and a prompt template', () => {
    const { format, notes } = parseImport(CLAUDE_PROJECTS)
    expect(format).toBe('claude-projects')
    expect(notes).toHaveLength(2)
    const prompt = notes.find((n) => n.noteType === 'prompt_template')!
    expect(prompt.directory).toBe('projects/acme-redesign')
    expect(prompt.fileName).toBe('prompt-template')
    expect(prompt.body).toContain('You are a design assistant.')
    const doc = notes.find((n) => n.noteType === 'project_doc')!
    expect(doc.directory).toBe('projects/acme-redesign/docs')
    expect(doc.title).toBe('brief')
    expect(doc.createdAt).toBe('2024-01-11T09:00:00.000Z')
  })
})

// ── evolved Claude export: per-file projects, memories, design chats ───

describe('claude export — evolved layout (#113)', () => {
  it('detects + parses a SINGLE project object (projects/<uuid>.json, not an array)', () => {
    const data = JSON.stringify({
      uuid: 'p-9',
      name: 'How to use Claude',
      prompt_template: 'You are helpful.',
      created_at: '2024-02-01T00:00:00Z',
      docs: [
        {
          uuid: 'd-9',
          filename: 'guide.md',
          content: '# Guide\nText.',
          created_at: '2024-02-02T00:00:00Z',
        },
      ],
    })
    expect(detectFormat(data)).toBe('claude-projects')
    const { format, notes } = parseImport(data)
    expect(format).toBe('claude-projects')
    const prompt = notes.find((n) => n.noteType === 'prompt_template')!
    expect(prompt.directory).toBe('projects/how-to-use-claude')
    const doc = notes.find((n) => n.noteType === 'project_doc')!
    expect(doc.directory).toBe('projects/how-to-use-claude/docs')
    expect(doc.title).toBe('guide')
  })

  it('detects + parses memories.json (a conversations_memory blob → a memory note)', () => {
    const data = JSON.stringify([
      {
        conversations_memory: '**Work context**\nBuilding a note-taking tool.',
        account_uuid: 'acc-1',
      },
    ])
    expect(detectFormat(data)).toBe('claude-memory')
    const { format, notes } = parseImport(data)
    expect(format).toBe('claude-memory')
    expect(notes).toHaveLength(1)
    const [n] = notes
    expect(n.title).toBe('Conversations memory')
    expect(n.directory).toBe('memory/claude')
    expect(n.source).toBe('memory') // routed by the memory-destination option
    expect(n.body).toContain('Work context')
    // Account-keyed filename → re-import overwrites, two accounts don't collide.
    expect(n.fileName).toMatch(/^conversations_memory-[a-z0-9]{8}$/)
  })

  it('detects + parses a design chat (messages[], content nested one level)', () => {
    const data = JSON.stringify({
      uuid: 'dc-1',
      title: 'Landing page',
      project: { uuid: 'pr-1', name: 'Landing Redesign' },
      created_at: '2024-04-22T23:02:40Z',
      messages: [
        {
          uuid: 'm1',
          role: 'user',
          content: { role: 'user', content: 'need a landing page' },
          created_at: '2024-04-22T23:02:40Z',
        },
        {
          uuid: 'm2',
          role: 'assistant',
          content: { role: 'assistant', content: 'here is a draft' },
          created_at: '2024-04-22T23:03:00Z',
        },
      ],
    })
    expect(detectFormat(data)).toBe('claude-design-chat')
    const { format, notes } = parseImport(data)
    expect(format).toBe('claude-design-chat')
    expect(notes).toHaveLength(1)
    const [n] = notes
    expect(n.directory).toBe('design-chats/landing-redesign') // grouped under the project
    expect(n.createdAt).toBe('2024-04-22T23:02:40.000Z')
    expect(n.body).toContain('### User')
    expect(n.body).toContain('need a landing page')
    expect(n.body).toContain('### Assistant')
    expect(n.body).toContain('here is a draft')
    expect(n.body.indexOf('need a landing page')).toBeLessThan(n.body.indexOf('here is a draft'))
  })

  it('design chat: content as an ARRAY of text blocks is extracted', () => {
    const data = JSON.stringify({
      uuid: 'dc-2',
      title: 'Blocks',
      messages: [
        {
          uuid: 'm1',
          role: 'user',
          content: {
            content: [
              { type: 'text', text: 'block one' },
              { type: 'text', text: 'block two' },
            ],
          },
        },
      ],
    })
    const [n] = parseImport(data).notes
    expect(n.body).toContain('block one')
    expect(n.body).toContain('block two')
  })

  it('design chat with no renderable content is skipped, not an empty note (#113)', () => {
    const data = JSON.stringify({
      uuid: 'dc-empty',
      title: 'Empty design chat',
      messages: [{ uuid: 'm1', role: 'user', content: { role: 'user', content: '' } }],
    })
    const { notes, warnings } = parseImport(data)
    expect(notes).toHaveLength(0)
    expect(warnings.join(' ')).toContain('no renderable content')
  })

  it('claude-memory: a projects_memory blob also becomes a note (not just conversations_memory)', () => {
    const data = JSON.stringify([
      { projects_memory: '**Projects**\nAcme redesign.', account_uuid: 'acc-2' },
    ])
    const [n] = parseImport(data).notes
    expect(n.title).toBe('Projects memory')
    expect(n.body).toContain('Acme redesign')
  })

  // Idempotency for the new formats: re-parsing yields identical
  // source-id-keyed filenames, so a re-import overwrites the same files (no dupes).
  it('new Claude formats produce deterministic filenames across re-parses', () => {
    const project = JSON.stringify({
      uuid: 'p-id',
      name: 'Proj',
      docs: [{ uuid: 'd', filename: 'd.md', content: 'x' }],
    })
    const memory = JSON.stringify([{ conversations_memory: 'm', account_uuid: 'a-id' }])
    const design = JSON.stringify({
      uuid: 'dc-id',
      title: 'T',
      messages: [{ role: 'user', content: { content: 'hi' } }],
    })

    for (const raw of [project, memory, design]) {
      const a = parseImport(raw).notes.map((n) => n.fileName)
      const b = parseImport(raw).notes.map((n) => n.fileName)
      expect(a.length).toBeGreaterThan(0)
      expect(b).toEqual(a)
    }
  })
})

// ── robustness against real / malformed data ────────────────────────────────

describe('robustness fixes', () => {
  it('Claude: a non-string content block does not stringify to [object Object]', () => {
    const data = JSON.stringify([
      {
        uuid: 'b-1',
        name: 'Mixed blocks',
        chat_messages: [
          {
            sender: 'assistant',
            content: [
              { type: 'tool_use', text: { nested: 'x' } },
              { type: 'text', text: 'real reply' },
            ],
          },
        ],
      },
    ])
    const body = parseImport(data).notes[0].body
    expect(body).toContain('real reply')
    expect(body).not.toContain('[object Object]')
  })

  it('ChatGPT: walks MULTIPLE roots — no message subtree is dropped', () => {
    const data = JSON.stringify([
      {
        title: 'Two roots',
        conversation_id: 'tr-1',
        mapping: {
          r1: { id: 'r1', parent: null, children: ['m1'] },
          m1: {
            id: 'm1',
            parent: 'r1',
            children: [],
            message: {
              author: { role: 'user' },
              content: { content_type: 'text', parts: ['from tree one'] },
            },
          },
          r2: { id: 'r2', parent: null, children: ['m2'] },
          m2: {
            id: 'm2',
            parent: 'r2',
            children: [],
            message: {
              author: { role: 'assistant' },
              recipient: 'all',
              content: { content_type: 'text', parts: ['from tree two'] },
            },
          },
        },
      },
    ])
    const body = parseImport(data).notes[0].body
    expect(body).toContain('from tree one')
    expect(body).toContain('from tree two')
  })

  it('ChatGPT: a cyclic/rootless mapping still yields a body (no silent empty)', () => {
    const data = JSON.stringify([
      {
        title: 'No root',
        conversation_id: 'nr-1',
        mapping: {
          a: {
            id: 'a',
            parent: 'b',
            children: ['b'],
            message: {
              author: { role: 'user' },
              content: { content_type: 'text', parts: ['hello from a'] },
            },
          },
          b: {
            id: 'b',
            parent: 'a',
            children: ['a'],
            message: {
              author: { role: 'assistant' },
              recipient: 'all',
              content: { content_type: 'text', parts: ['hi from b'] },
            },
          },
        },
      },
    ])
    const body = parseImport(data).notes[0].body
    expect(body.length).toBeGreaterThan(0)
    expect(body).toContain('hello from a')
  })

  it('memory-json: the single-object {entities,relations} shape is detected + parsed', () => {
    const data = JSON.stringify({
      entities: [
        { name: 'Alice', entityType: 'person', observations: ['Likes tea'] },
        { name: 'Acme', entityType: 'organization', observations: [] },
      ],
      relations: [{ from: 'Alice', to: 'Acme', relationType: 'works at' }],
    })
    expect(detectFormat(data)).toBe('memory-json')
    const { format, notes } = parseImport(data)
    expect(format).toBe('memory-json')
    expect(notes).toHaveLength(2)
    const alice = notes.find((n) => n.title === 'Alice')!
    expect(alice.body).toContain('- works at [[Acme]]')
  })

  it('a numeric-string date is read as a year, not epoch 1970', () => {
    // `created_at: "2024"` must NOT become 1970 (epoch seconds) — it's the YEAR.
    const data = JSON.stringify([
      {
        uuid: 'd-1',
        name: 'Bad date',
        created_at: '2024',
        chat_messages: [{ sender: 'human', text: 'hi' }],
      },
    ])
    const note = parseImport(data).notes[0]
    expect(note.createdAt).toBe('2024-01-01T00:00:00.000Z')
  })

  it('a very long title is capped so the filename stays under the OS limit', () => {
    const long = 'a'.repeat(400)
    const data = JSON.stringify([
      {
        uuid: 'd-2',
        name: long,
        created_at: '2024-01-01T00:00:00Z',
        chat_messages: [{ sender: 'human', text: 'hi' }],
      },
    ])
    const fn = parseImport(data).notes[0].fileName
    expect(fn.length).toBeLessThan(120) // date(8)+'-'+slug(≤80)+'-'+hash(8)
  })

  it('two idless untitled conversations get distinct filenames (no collision)', () => {
    const data = JSON.stringify([
      {
        name: '',
        mapping: {
          r: { id: 'r', parent: null, children: ['a'] },
          a: {
            id: 'a',
            parent: 'r',
            children: [],
            message: {
              author: { role: 'user' },
              content: { content_type: 'text', parts: ['first'] },
            },
          },
        },
      },
      {
        name: '',
        mapping: {
          r: { id: 'r', parent: null, children: ['a'] },
          a: {
            id: 'a',
            parent: 'r',
            children: [],
            message: {
              author: { role: 'user' },
              content: { content_type: 'text', parts: ['second'] },
            },
          },
        },
      },
    ])
    const notes = parseImport(data).notes
    expect(notes).toHaveLength(2)
    expect(notes[0].fileName).not.toBe(notes[1].fileName)
  })
})

// ── errors ───────────────────────────────────────────────────────────────────

describe('errors', () => {
  it('throws ImportError on unrecognised input', () => {
    expect(() => parseImport('garbage')).toThrow(ImportError)
  })
})
