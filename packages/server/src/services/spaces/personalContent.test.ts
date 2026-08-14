import { describe, expect, it, vi } from 'vitest'
import type { KnowledgeStore, Revision } from '@notarium/core'

import { listMemoryCategories } from './personalContent'

const storeFixture = (withBatch = true) => {
  const metas = [
    {
      id: 'memory-communication',
      title: 'communication',
      class: 'agent-memory' as const,
      filePath: '.notarium/memory/communication.md',
      modifiedAt: '2026-07-01T10:00:00.000Z',
      createdAt: '2026-06-01T10:00:00.000Z',
    },
    {
      id: 'memory-workflow',
      title: 'workflow',
      class: 'agent-memory' as const,
      filePath: '.notarium/memory/workflow.md',
      modifiedAt: '2026-07-02T10:00:00.000Z',
      createdAt: '2026-06-02T10:00:00.000Z',
    },
  ]
  const latest = {
    id: '7',
    noteId: 'memory-communication',
    space: 'personal',
    baseRevisionId: '6',
    theirRevisionId: null,
    sourceRevisionId: null,
    kind: 'write',
    entryRole: 'change',
    principal: 'pat:sergey:agent',
    contentHash: 'hash',
    semanticFingerprint: null,
    restoreSafety: null,
    stateFormat: null,
    title: 'communication',
    class: 'agent-memory',
    slug: null,
    tags: [],
    createdAt: '2026-07-03T10:00:00.000Z',
    charsAdded: 1,
    charsRemoved: 0,
  } satisfies Revision
  const list = vi.fn(async () => metas)
  const read = vi.fn(async (id: string) => {
    const meta = metas.find((row) => row.id === id)!
    return {
      ...meta,
      content: `${meta.title} body`,
      frontmatter: { summary: `${meta.title} summary` },
      versionToken: `${id}-v1`,
    }
  })
  const latestRevisions = vi.fn(async () => new Map([[latest.noteId, latest]]))
  const revisions = vi.fn(async () => {
    throw new Error('per-note revision lookup must not run')
  })
  const store = {
    list,
    read,
    ...(withBatch ? { latestRevisions } : {}),
    revisions,
  } as unknown as KnowledgeStore

  return { store, list, read, latestRevisions, revisions }
}

const orderingStore = () => {
  const metas = [
    {
      id: 'decisions',
      title: 'decisions',
      class: 'agent-memory' as const,
      filePath: '.notarium/memory/decisions.md',
      createdAt: '2026-01-02T00:00:00.000Z',
      modifiedAt: '2026-03-01T00:00:00.000Z',
    },
    {
      id: 'conventions',
      title: 'conventions',
      class: 'agent-memory' as const,
      filePath: '.notarium/memory/conventions.md',
      createdAt: '2026-01-01T00:00:00.000Z',
      modifiedAt: '2026-03-03T00:00:00.000Z',
    },
    {
      id: 'gotchas',
      title: 'gotchas',
      class: 'agent-memory' as const,
      filePath: '.notarium/memory/gotchas.md',
      createdAt: '2026-01-03T00:00:00.000Z',
      modifiedAt: '2026-03-02T00:00:00.000Z',
    },
    {
      id: 'learnings',
      title: 'learnings',
      class: 'agent-memory' as const,
      filePath: '.notarium/memory/learnings.md',
      createdAt: null,
      modifiedAt: '2026-03-04T00:00:00.000Z',
    },
  ]

  return {
    list: vi.fn(async () => metas),
    read: vi.fn(async (id: string) => {
      const meta = metas.find((row) => row.id === id)!
      return {
        ...meta,
        content: `${meta.title} body`,
        frontmatter: { summary: `${meta.title} summary` },
        versionToken: `${id}-v1`,
      }
    }),
  } as unknown as KnowledgeStore
}

describe('listMemoryCategories', () => {
  it.each([
    [{ sort: 'title', dir: 'asc' }, ['conventions', 'decisions', 'gotchas', 'learnings']],
    [{ sort: 'title', dir: 'desc' }, ['learnings', 'gotchas', 'decisions', 'conventions']],
    [{ sort: 'modified', dir: 'asc' }, ['decisions', 'gotchas', 'conventions', 'learnings']],
    [{ sort: 'modified', dir: 'desc' }, ['learnings', 'conventions', 'gotchas', 'decisions']],
    [{ sort: 'created', dir: 'asc' }, ['conventions', 'decisions', 'gotchas', 'learnings']],
    [{ sort: 'created', dir: 'desc' }, ['gotchas', 'decisions', 'conventions', 'learnings']],
  ] as const)('sorts the audit by %j', async (opts, expected) => {
    const categories = await listMemoryCategories(orderingStore(), '', opts)

    expect(categories.map((category) => category.category)).toEqual(expected)
    expect(categories).toHaveLength(4)
  })

  it('keeps the historical newest-write default and lets eager win over sort + dir', async () => {
    const dflt = await listMemoryCategories(orderingStore())
    const eager = await listMemoryCategories(orderingStore(), '', {
      order: 'eager',
      sort: 'title',
      dir: 'desc',
    })

    expect(dflt.map((category) => category.category)).toEqual([
      'learnings',
      'conventions',
      'gotchas',
      'decisions',
    ])
    expect(eager.map((category) => category.category)).toEqual([
      'decisions',
      'conventions',
      'gotchas',
      'learnings',
    ])
  })

  it('lists only the memory class and decorates every category with one provenance batch', async () => {
    const { store, list, read, latestRevisions, revisions } = storeFixture()

    const categories = await listMemoryCategories(store)

    expect(list).toHaveBeenCalledOnce()
    expect(list).toHaveBeenCalledWith({ scope: 'agentRecall', classes: ['agent-memory'] })
    expect(read).toHaveBeenCalledTimes(2)
    expect(latestRevisions).toHaveBeenCalledOnce()
    expect(latestRevisions).toHaveBeenCalledWith(['memory-communication', 'memory-workflow'])
    expect(revisions).not.toHaveBeenCalled()
    expect(categories.map((category) => category.noteId)).toEqual([
      'memory-communication',
      'memory-workflow',
    ])
    expect(categories[0]).toMatchObject({
      modifiedAt: '2026-07-03T10:00:00.000Z',
      principal: 'pat:sergey:agent',
      kind: 'write',
    })
    expect(categories[1]).toMatchObject({
      modifiedAt: '2026-07-02T10:00:00.000Z',
      principal: null,
      kind: null,
    })
  })

  it('keeps the same filtered metadata timestamp when batch provenance is unavailable', async () => {
    const { store, list, revisions } = storeFixture(false)

    const categories = await listMemoryCategories(store)

    expect(list).toHaveBeenCalledOnce()
    expect(revisions).not.toHaveBeenCalled()
    expect(categories.map(({ noteId, modifiedAt }) => ({ noteId, modifiedAt }))).toEqual([
      { noteId: 'memory-workflow', modifiedAt: '2026-07-02T10:00:00.000Z' },
      { noteId: 'memory-communication', modifiedAt: '2026-07-01T10:00:00.000Z' },
    ])
  })
})
