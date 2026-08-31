import { describe, expect, it, vi } from 'vitest'

import { FIELD_TYPE } from '@notarium/contract'
import {
  createReaderRegistry,
  type KnowledgeStore,
  type NoteContent,
  type NoteMeta,
  type ReaderDefinition,
} from '@notarium/core'

import { SYSTEM_PRINCIPAL } from '../../../authz'
import type { ViewProjectionAdapter } from '../../../views/viewProjection'
import type { Ctx } from '../../gateway'
import { handleGetNote } from './read'

const reader: ReaderDefinition<{ label: string }> = {
  type: 'stub',
  compileOptions: () => ({ status: 'ready', options: { label: 'Rows' } }),
  dataNeeds: (_options, view) => ({ properties: view.fields ?? [], window: 'source' }),
  mutationCapabilities: () => ({}),
  project: (data, options) => ({ data, label: options.label }),
}

const adapter: ViewProjectionAdapter = {
  prose: (projection) => {
    const data = (projection as { data: { total?: number } }).data
    return `Stub rows: ${data.total ?? 0}`
  },
  structured: () => ({ kind: 'stub' }),
}

const configToken = 'unique-config-token-must-stay-raw-only'
const carrier = [
  'Visible prose.',
  '',
  '```nota',
  'version: 1',
  'source:',
  '  kind: notes',
  '  scope: space',
  '  filter:',
  '    op: and',
  '    nodes:',
  '      - op: or',
  '        ns: note',
  '        key: type',
  '        values: [{ kind: eq, value: task }]',
  'views:',
  '  - name: Stub',
  '    type: stub',
  '    fields: [note.owner]',
  `    options: { token: ${configToken} }`,
  '```',
].join('\n')

const metas: NoteMeta[] = [
  {
    id: 'view-note',
    title: 'Sprint',
    filePath: 'work/sprint.md',
    viewType: 'stub',
    modifiedAt: '2026-08-30T00:00:00.000Z',
    createdAt: null,
    fields: { keys: {} },
  },
  {
    id: 'task-a',
    title: 'Task A',
    filePath: 'work/a.md',
    modifiedAt: '2026-08-30T00:00:01.000Z',
    createdAt: null,
    fields: { keys: { type: 'task', owner: 'ann' } },
  },
]

const details: Record<string, NoteContent> = {
  'view-note': {
    id: 'view-note',
    title: 'Sprint',
    class: 'user-doc',
    filePath: 'work/sprint.md',
    content: carrier,
    frontmatter: { view: 'stub' },
    versionToken: 'v1:view-note',
  },
  'task-a': {
    id: 'task-a',
    title: 'Task A',
    class: 'user-doc',
    filePath: 'work/a.md',
    content: 'Task A',
    frontmatter: { type: 'task', owner: 'ann' },
    versionToken: 'v1:task-a',
  },
}

describe('get_note view projection', () => {
  it('keeps raw carrier only in structured content and renders a sanitized semantic view', async () => {
    const read = vi.fn(async (id: string) => details[id]!)
    const store = {
      list: async () => metas,
      read,
      graph: async () => ({ nodes: [], links: [] }),
    } as unknown as KnowledgeStore
    const ctx = {
      principal: SYSTEM_PRINCIPAL,
      store: { noteStore: async () => ({ store, space: 'space-1' }) },
      spaces: {
        slugOf: () => 'main',
      },
      fieldSchemaStore: {
        read: async () => ({
          version: 1,
          versionToken: 'schema-v1',
          status: 'ready',
          fields: [{ key: 'owner', type: FIELD_TYPE.text }],
        }),
      },
      viewReaders: createReaderRegistry([reader]),
      viewProjectionAdapters: { stub: adapter },
      projectsInSpace: async () => [],
      personalSpace: async () => 'space-1',
    } as unknown as Ctx
    const rendered = await handleGetNote(ctx, {
      ref: 'view-note',
      responseFormat: 'detailed',
    })

    expect(rendered.markdown).toContain('Visible prose.')
    expect(rendered.markdown).toContain('Stub rows: 1')
    expect(rendered.markdown).not.toContain(configToken)
    expect(rendered.structured.content).toContain(configToken)
    expect(read.mock.calls.filter(([id]) => id === 'view-note')).toHaveLength(1)
    expect(rendered.structured.views).toEqual([
      expect.objectContaining({
        name: 'Stub',
        type: 'stub',
        total: 1,
        rows: [
          expect.objectContaining({
            id: 'task-a',
            fields: { owner: expect.objectContaining({ value: 'ann' }) },
          }),
        ],
      }),
    ])
  })

  it('does not leak overflow carriers into detailed prose', async () => {
    const content = Array.from(
      { length: 34 },
      (_, index) => `\`\`\`nota\nsecret-overflow-${index}\n\`\`\``,
    ).join('\n')
    const note = { ...details['view-note']!, content }
    const store = {
      list: async () => [],
      read: async () => note,
      graph: async () => ({ nodes: [], links: [] }),
    } as unknown as KnowledgeStore
    const ctx = {
      principal: SYSTEM_PRINCIPAL,
      store: { noteStore: async () => ({ store, space: 'space-1' }) },
      spaces: { slugOf: () => 'main' },
      viewReaders: createReaderRegistry([reader]),
      viewProjectionAdapters: { stub: adapter },
      projectsInSpace: async () => [],
      personalSpace: async () => 'space-1',
    } as unknown as Ctx
    const rendered = await handleGetNote(ctx, {
      ref: 'view-note',
      responseFormat: 'detailed',
    })

    expect(rendered.markdown).not.toContain('secret-overflow')
    expect(rendered.structured.content).toContain('secret-overflow-33')
  })
})
