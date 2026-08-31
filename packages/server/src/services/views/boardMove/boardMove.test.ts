import { describe, expect, it, vi } from 'vitest'
import { FIELD_TYPE } from '@notarium/contract'
import { type KnowledgeStore, parseBoardRanks, parseViewDocument } from '@notarium/core'
import { InMemoryStore } from '@notarium/engine-memory'

import { createInMemoryFieldSchemaStore } from '../../fields'
import { setNoteFields } from '../../spaces'
import { BoardMoveService } from './boardMove'

const boardBody = (name = 'Tasks', ranks = '["card-a","a0"]\n["card-b","a1"]') => `# Board

\`\`\`nota
version: 1
source:
  kind: notes
  scope: space
  filter:
    op: and
    nodes:
      - op: or
        ns: note
        key: kind
        values:
          - kind: eq
            value: task
views:
  - name: ${name}
    type: board
    options:
      groupBy: note.status
      order:
        kind: manual
        ranks: |-
${ranks
  .split('\n')
  .map((line) => `          ${line}`)
  .join('\n')}
\`\`\`
`

const fixture = async (secondBoard = false) => {
  const notes = [
    {
      id: 'board',
      title: 'Board',
      filePath: 'board.md',
      content: boardBody(),
      frontmatter: 'view: board',
    },
    {
      id: 'card-a',
      title: 'Alpha',
      filePath: 'alpha.md',
      content: 'Alpha body',
      frontmatter: 'kind: task\nstatus: todo',
    },
    {
      id: 'card-b',
      title: 'Beta',
      filePath: 'beta.md',
      content: 'Beta body',
      frontmatter: 'kind: task\nstatus: doing',
    },
    {
      id: 'card-c',
      title: 'Gamma',
      filePath: 'gamma.md',
      content: 'Gamma body',
      frontmatter: 'kind: task',
    },
    ...(secondBoard
      ? [
          {
            id: 'board-two',
            title: 'Board two',
            filePath: 'board-two.md',
            content: boardBody('Other', '["card-a","a1"]'),
            frontmatter: 'view: board',
          },
        ]
      : []),
  ]
  const store = new InMemoryStore({ space: 'space-1', notes })
  const fieldSchemaStore = createInMemoryFieldSchemaStore()

  fieldSchemaStore.seed('space-1', {
    version: 1,
    fields: [
      {
        key: 'status',
        type: FIELD_TYPE.enum,
        values: [
          { key: 'todo', label: 'To do' },
          { key: 'doing', label: 'Doing' },
          { key: 'done', label: 'Done' },
        ],
      },
    ],
  })
  const viewRefFor = async (id: string): Promise<string> => {
    const note = await store.read(id)
    const parsed = parseViewDocument(note.content, {
      documentId: id,
      versionToken: note.versionToken!,
    })

    return parsed.views[0]!.viewRef!
  }

  return { store, fieldSchemaStore, viewRefFor }
}

const move = async (
  setup: Awaited<ReturnType<typeof fixture>>,
  request: {
    viewRef: string
    cardId: string
    to: { kind: 'value'; value: string } | { kind: 'absent' }
    beforeId?: string
    afterId?: string
  },
) =>
  new BoardMoveService(() => 0).move({
    request,
    store: setup.store,
    space: 'space-1',
    projects: [],
    schema: await setup.fieldSchemaStore.read('space-1'),
    fieldSchemaStore: setup.fieldSchemaStore,
    principal: 'user:test',
  })

describe('BoardMoveService', () => {
  it('writes membership first and then changes one rank tuple', async () => {
    const setup = await fixture()
    const viewRef = await setup.viewRefFor('board')
    const before = (await setup.store.read('board')).content
    const write = vi.spyOn(setup.store, 'write')
    const list = vi.spyOn(setup.store, 'list')
    const result = await move(setup, {
      viewRef,
      cardId: 'card-a',
      to: { kind: 'value', value: 'doing' },
      beforeId: 'card-b',
    })
    const after = (await setup.store.read('board')).content
    const changedLines = after
      .split('\n')
      .filter((line, index) => line !== before.split('\n')[index])

    expect(result).toMatchObject({ status: 'moved' })
    expect(result).not.toHaveProperty('rebalanced')
    expect((await setup.store.read('card-a')).frontmatter.status).toBe('doing')
    expect(write.mock.calls.map(([input]) => input.originalId)).toEqual(['card-a', 'board'])
    expect(list).toHaveBeenCalledTimes(2)
    expect(changedLines).toHaveLength(1)
    expect(
      parseBoardRanks(/ranks: \|-\n((?:\s+.*\n?)*)/u.exec(after)?.[1]?.trim()).entries.has(
        'card-a',
      ),
    ).toBe(true)
  })

  it('never writes the view when the point-field channel refuses', async () => {
    const setup = await fixture()
    const viewRef = await setup.viewRefFor('board')
    const before = (await setup.store.read('board')).content
    const write = vi.spyOn(setup.store, 'write')

    await expect(
      new BoardMoveService(() => 0).move({
        request: {
          viewRef,
          cardId: 'card-a',
          to: { kind: 'value', value: 'doing' },
          beforeId: 'card-b',
        },
        store: setup.store,
        space: 'space-1',
        projects: [],
        schema: await setup.fieldSchemaStore.read('space-1'),
      }),
    ).rejects.toMatchObject({ reason: 'field_schema_unavailable' })

    expect(write).not.toHaveBeenCalled()
    expect((await setup.store.read('board')).content).toBe(before)
  })

  it('returns moved-unranked immediately after a stable non-conflict rank failure', async () => {
    const setup = await fixture()
    const viewRef = await setup.viewRefFor('board')
    const before = (await setup.store.read('board')).content
    const store = setup.store as KnowledgeStore
    const originalWrite = store.write.bind(store)
    const list = vi.spyOn(store, 'list')
    let viewWrites = 0

    vi.spyOn(store, 'write').mockImplementation(async (input, options) => {
      if (input.originalId === 'board') {
        viewWrites++
        throw new Error('rank storage unavailable')
      }

      return originalWrite(input, options)
    })
    const result = await move(setup, {
      viewRef,
      cardId: 'card-a',
      to: { kind: 'value', value: 'doing' },
      beforeId: 'card-b',
    })

    expect(result).toMatchObject({ status: 'moved-unranked', reason: 'rank-write-failed' })
    expect(viewWrites).toBe(1)
    expect(list).toHaveBeenCalledTimes(2)
    expect((await setup.store.read('card-a')).frontmatter.status).toBe('doing')
    expect((await setup.store.read('board')).content).toBe(before)
  })

  it('revalidates and retries a rank-only view CAS conflict', async () => {
    const setup = await fixture()
    const viewRef = await setup.viewRefFor('board')
    const store = setup.store as KnowledgeStore
    const originalWrite = store.write.bind(store)
    let viewWrites = 0

    vi.spyOn(store, 'write').mockImplementation(async (input, options) => {
      if (input.originalId === 'board' && viewWrites++ === 0) {
        const board = await setup.store.read('board')

        await originalWrite({
          originalId: 'board',
          title: board.title ?? '',
          content: board.content.replace('["card-b","a1"]', '["card-b","a2"]'),
          versionToken: board.versionToken,
          derivedContentUnchanged: true,
        })
      }

      return originalWrite(input, options)
    })
    const result = await move(setup, {
      viewRef,
      cardId: 'card-a',
      to: { kind: 'value', value: 'doing' },
      beforeId: 'card-b',
    })

    expect(result.status).toBe('moved')
    expect(viewWrites).toBe(2)
    expect((await setup.store.read('board')).content).toContain('["card-b","a2"]')
  })

  it('reports the exact committed field effect when the view changes after it', async () => {
    const setup = await fixture()
    const viewRef = await setup.viewRefFor('board')
    const store = setup.store as KnowledgeStore
    const originalWrite = store.write.bind(store)
    let injected = false

    vi.spyOn(store, 'write').mockImplementation(async (input, options) => {
      const result = await originalWrite(input, options)

      if (input.originalId === 'card-a' && !injected) {
        injected = true
        const board = await setup.store.read('board')

        await originalWrite({
          originalId: 'board',
          title: board.title ?? '',
          content: board.content.replace('name: Tasks', 'name: Changed'),
          versionToken: board.versionToken,
          derivedContentUnchanged: true,
        })
      }

      return result
    })
    const result = await move(setup, {
      viewRef,
      cardId: 'card-a',
      to: { kind: 'value', value: 'doing' },
      beforeId: 'card-b',
    })

    expect(result).toMatchObject({
      status: 'moved-partial',
      reason: 'view-changed',
      fieldEffect: { key: 'status', value: 'doing' },
    })
    expect(result.status === 'moved-partial' && result.fieldEffect.versionToken).not.toBe('')
  })

  it('reports view deletion after the field effect without rolling the card back', async () => {
    const setup = await fixture()
    const viewRef = await setup.viewRefFor('board')
    const store = setup.store as KnowledgeStore
    const originalWrite = store.write.bind(store)
    let injected = false

    vi.spyOn(store, 'write').mockImplementation(async (input, options) => {
      const result = await originalWrite(input, options)

      if (input.originalId === 'card-a' && !injected) {
        injected = true
        await setup.store.remove('board')
      }

      return result
    })
    const result = await move(setup, {
      viewRef,
      cardId: 'card-a',
      to: { kind: 'value', value: 'doing' },
      beforeId: 'card-b',
    })

    expect(result).toMatchObject({
      status: 'moved-partial',
      reason: 'view-deleted',
      fieldEffect: { key: 'status', value: 'doing' },
    })
    expect((await setup.store.read('card-a')).frontmatter.status).toBe('doing')
  })

  it('reports membership drift after the exact field effect', async () => {
    const setup = await fixture()
    const viewRef = await setup.viewRefFor('board')
    const store = setup.store as KnowledgeStore
    const originalWrite = store.write.bind(store)
    let injected = false

    vi.spyOn(store, 'write').mockImplementation(async (input, options) => {
      const result = await originalWrite(input, options)

      if (input.originalId === 'card-a' && !injected) {
        injected = true
        const card = await setup.store.read('card-a')

        await originalWrite({
          originalId: 'card-a',
          title: card.title ?? '',
          content: card.content,
          versionToken: card.versionToken,
          fields: { kind: null },
          fieldsUnquoted: [],
          preservePath: true,
        })
      }

      return result
    })
    const result = await move(setup, {
      viewRef,
      cardId: 'card-a',
      to: { kind: 'value', value: 'doing' },
      beforeId: 'card-b',
    })

    expect(result).toMatchObject({
      status: 'moved-partial',
      reason: 'membership-changed',
      fieldEffect: { key: 'status', value: 'doing' },
    })
  })

  it('rejects a stale viewRef before either note is written', async () => {
    const setup = await fixture()
    const viewRef = await setup.viewRefFor('board')
    const board = await setup.store.read('board')

    await setup.store.write({
      originalId: 'board',
      title: board.title ?? '',
      content: board.content.replace('name: Tasks', 'name: Fresh'),
      versionToken: board.versionToken,
      derivedContentUnchanged: true,
    })
    const write = vi.spyOn(setup.store, 'write')

    await expect(
      move(setup, {
        viewRef,
        cardId: 'card-a',
        to: { kind: 'value', value: 'doing' },
        beforeId: 'card-b',
      }),
    ).rejects.toMatchObject({ status: 409 })
    expect(write).not.toHaveBeenCalled()
    expect((await setup.store.read('card-a')).frontmatter.status).toBe('todo')
  })

  it('returns unchanged for an equal destination without manufacturing a rank', async () => {
    const setup = await fixture()
    const viewRef = await setup.viewRefFor('board')
    const write = vi.spyOn(setup.store, 'write')
    const result = await move(setup, {
      viewRef,
      cardId: 'card-a',
      to: { kind: 'value', value: 'todo' },
    })

    expect(result.status).toBe('unchanged')
    expect(write).not.toHaveBeenCalled()
  })

  it('materializes rankless neighbours only after moving to the absent column', async () => {
    const setup = await fixture()
    const viewRef = await setup.viewRefFor('board')
    const result = await move(setup, {
      viewRef,
      cardId: 'card-a',
      to: { kind: 'absent' },
      beforeId: 'card-c',
    })

    expect(result).toMatchObject({ status: 'moved', rebalanced: true })
    expect((await setup.store.read('card-a')).frontmatter.status).toBeUndefined()
    expect((await setup.store.read('board')).content).toContain('["card-c",')
  })

  it('does not retry the card CAS more than three total attempts', async () => {
    const setup = await fixture()
    const viewRef = await setup.viewRefFor('board')
    const store = setup.store as KnowledgeStore
    const originalWrite = store.write.bind(store)
    let cardWrites = 0

    vi.spyOn(store, 'write').mockImplementation(async (input, options) => {
      if (input.originalId === 'card-a') {
        cardWrites++
        throw Object.assign(new Error('conflict'), { isConflict: true })
      }

      return originalWrite(input, options)
    })

    await expect(
      move(setup, {
        viewRef,
        cardId: 'card-a',
        to: { kind: 'value', value: 'doing' },
        beforeId: 'card-b',
      }),
    ).rejects.toMatchObject({ isConflict: true })
    expect(cardWrites).toBe(3)
    expect((await setup.store.read('card-a')).frontmatter.status).toBe('todo')
  })

  it('revalidates target neighbours before a card CAS retry', async () => {
    const setup = await fixture()
    const viewRef = await setup.viewRefFor('board')
    const store = setup.store as KnowledgeStore
    const originalWrite = store.write.bind(store)
    let cardWrites = 0

    vi.spyOn(store, 'write').mockImplementation(async (input, options) => {
      if (input.originalId === 'card-a') {
        cardWrites++
        if (cardWrites === 1) {
          const neighbour = await store.read('card-b')

          await setNoteFields({
            store,
            fieldSchemaStore: setup.fieldSchemaStore,
            space: 'space-1',
            id: 'card-b',
            versionToken: neighbour.versionToken,
            fields: { status: 'done' },
          })
        }
        throw Object.assign(new Error('conflict'), { isConflict: true })
      }

      return originalWrite(input, options)
    })

    await expect(
      move(setup, {
        viewRef,
        cardId: 'card-a',
        to: { kind: 'value', value: 'doing' },
        beforeId: 'card-b',
      }),
    ).rejects.toThrow('beforeId is not in the target column')
    expect(cardWrites).toBe(1)
    expect((await store.read('card-a')).frontmatter.status).toBe('todo')
    expect((await store.read('card-b')).frontmatter.status).toBe('done')
  })

  it('keeps rank overlays independent for two boards over the same cards', async () => {
    const setup = await fixture(true)
    const viewRef = await setup.viewRefFor('board')
    const otherBefore = (await setup.store.read('board-two')).content

    await move(setup, {
      viewRef,
      cardId: 'card-a',
      to: { kind: 'value', value: 'doing' },
      beforeId: 'card-b',
    })

    expect((await setup.store.read('board-two')).content).toBe(otherBefore)
  })
})
