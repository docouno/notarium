// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseViewDocument } from '@notarium/core'

import { endDrag, startDrag } from '../../libs/dnd/dnd'
import { api, ApiError } from '../../services/api'
import { BoardColumn } from '../../widgets/Board'
import type { ViewReaderComponentProps } from '../ViewRuntime'
import { BoardView } from './BoardView'

const parsed = parseViewDocument(
  '```nota\nversion: 1\nsource: { kind: notes, scope: space }\nviews: [{ name: Board, type: board, options: { groupBy: note.status } }]\n```',
)

class FakeDataTransfer {
  private readonly values = new Map<string, string>()
  effectAllowed = 'uninitialized'
  dropEffect = 'none'

  get types(): string[] {
    return [...this.values.keys()]
  }

  setData(type: string, value: string): void {
    this.values.set(type, value)
  }

  getData(type: string): string {
    return this.values.get(type) ?? ''
  }
}

const dragEvent = (type: string, dataTransfer: FakeDataTransfer, clientY = 0): Event => {
  const event = new Event(type, { bubbles: true, cancelable: true })

  Object.defineProperties(event, {
    dataTransfer: { value: dataTransfer },
    clientY: { value: clientY },
  })
  return event
}

const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })

  return { promise, reject, resolve }
}

describe('BoardView', () => {
  let host: HTMLDivElement
  let root: Root

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })

  afterEach(async () => {
    endDrag()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    await act(async () => root.unmount())
    host.remove()
  })

  it('renders schema columns first and loads only the initially visible window', async () => {
    const loadWindow = vi.fn(async ({ group }: { group?: string }) => ({
      viewRef: 'view-ref',
      group,
      offset: 0,
      limit: 50,
      total: group === 'doing-key' ? 1 : 0,
      snapshotGeneration: 'g1',
      rows:
        group === 'doing-key'
          ? [
              {
                id: 'task-a',
                title: 'Task A',
                filePath: 'work/a.md',
                fields: { owner: { state: 'value' as const, value: 'ann', label: 'Ann' } },
              },
            ]
          : [],
      execution: { exactReads: 0, exactCacheHits: 0, exactRemaining: 0 },
    }))
    const props: ViewReaderComponentProps = {
      view: parsed.views[0]!,
      options: { groupBy: 'note.status' },
      mode: 'current-reader',
      projection: {},
      manifest: {
        viewRef: 'view-ref',
        block: 0,
        occurrence: 0,
        name: 'Board',
        type: 'board',
        status: 'ready',
        total: 1,
        groups: [
          {
            key: 'doing-key',
            state: 'value',
            value: 'doing',
            label: 'Doing',
            color: 'blue',
            count: 1,
          },
          {
            key: 'done-key',
            state: 'value',
            value: 'done',
            label: 'Done',
            color: 'green',
            count: 0,
          },
        ],
      },
      loading: false,
      error: null,
      loadWindow: loadWindow as ViewReaderComponentProps['loadWindow'],
      refresh: vi.fn(),
    }

    await act(async () => root.render(createElement(BoardView, props)))
    await act(async () => Promise.resolve())

    expect(loadWindow).toHaveBeenCalledTimes(1)
    expect(loadWindow).toHaveBeenCalledWith(expect.objectContaining({ group: 'doing-key' }))
    expect(host.textContent).toContain('Doing')
    expect(host.textContent).toContain('Done')
    expect(host.textContent).toContain('Task A')
    expect(host.textContent).toContain('Ann')
    expect(host.querySelector('a[href^="/n/task-a/"]')).not.toBeNull()
    expect(host.querySelector('[data-note-id="task-a"] button')).toBeNull()
  })

  it('shows an explicit incomplete source state', async () => {
    const props = {
      view: parsed.views[0]!,
      options: {},
      mode: 'current-writer' as const,
      projection: {},
      manifest: {
        block: 0,
        occurrence: 0,
        name: 'Board',
        type: 'board',
        status: 'incomplete' as const,
        groups: [],
      },
      loading: false,
      error: null,
      loadWindow: vi.fn(),
      refresh: vi.fn(),
    }

    await act(async () => root.render(createElement(BoardView, props)))

    expect(host.textContent).toContain('could not be resolved exactly')
  })

  it('uses board and card geometry for the initial loading state', async () => {
    await act(async () =>
      root.render(
        createElement(BoardView, {
          view: parsed.views[0]!,
          options: { groupBy: 'note.status' },
          mode: 'current-reader',
          projection: {},
          loading: true,
          error: null,
          loadWindow: vi.fn(),
          refresh: vi.fn(),
        }),
      ),
    )

    expect(host.querySelector('[data-testid="board-loading-skeleton"]')).not.toBeNull()
    expect(host.querySelectorAll('[data-testid="board-column-skeleton"]')).toHaveLength(4)
    for (const card of host.querySelectorAll('[data-testid="board-column-skeleton"]')) {
      expect(card.children).toHaveLength(2)
      expect(card.children[0]?.children).toHaveLength(1)
      expect(card.children[1]?.children).toHaveLength(3)
    }
  })

  it('moves optimistically and keeps loaded cards mounted during manifest reconcile', async () => {
    const result = deferred<Awaited<ReturnType<typeof api.boardMove>>>()
    const refresh = vi.fn()
    const boardMove = vi.spyOn(api, 'boardMove').mockReturnValue(result.promise)
    const loadWindow = vi
      .fn()
      .mockResolvedValueOnce({
        viewRef: 'view-ref-v1',
        group: 'backlog-key',
        offset: 0,
        limit: 50,
        total: 1,
        snapshotGeneration: 'g1',
        rows: [{ id: 'task-a', title: 'Task A', filePath: 'work/a.md' }],
        execution: { exactReads: 0, exactCacheHits: 0, exactRemaining: 0 },
      })
      .mockImplementation(() => new Promise(() => undefined))
    const manifest = {
      viewRef: 'view-ref-v1',
      block: 0,
      occurrence: 0,
      name: 'Board',
      type: 'board',
      status: 'ready' as const,
      capabilities: { move: true as const },
      total: 1,
      groups: [
        {
          key: 'backlog-key',
          state: 'value' as const,
          value: 'backlog',
          label: 'Backlog',
          count: 1,
        },
        { key: 'doing-key', state: 'value' as const, value: 'doing', label: 'Doing', count: 0 },
      ],
    }
    const props: ViewReaderComponentProps = {
      view: parsed.views[0]!,
      options: { groupBy: 'note.status' },
      mode: 'current-writer',
      projection: {},
      manifest,
      loading: false,
      error: null,
      loadWindow,
      refresh,
    }

    await act(async () => root.render(createElement(BoardView, props)))
    await act(async () => Promise.resolve())
    const card = host.querySelector<HTMLElement>('[data-note-id="task-a"]')!
    const destination = host.querySelector<HTMLElement>('[data-group="doing-key"]')!
    const transfer = new FakeDataTransfer()

    await act(async () => {
      card.dispatchEvent(dragEvent('dragstart', transfer))
      destination.lastElementChild!.dispatchEvent(dragEvent('dragover', transfer))
      destination.lastElementChild!.dispatchEvent(dragEvent('drop', transfer))
    })

    expect(boardMove).toHaveBeenCalledTimes(1)
    expect(refresh).not.toHaveBeenCalled()
    expect(host.querySelector('[data-group="backlog-key"]')?.getAttribute('aria-label')).toBe(
      'Backlog, 0 cards',
    )
    expect(destination.getAttribute('aria-label')).toBe('Doing, 1 cards')
    expect(destination.querySelector('[data-note-id="task-a"]')).not.toBeNull()
    expect(host.querySelector('[data-testid="board-column-skeleton"]')).toBeNull()

    await act(async () => {
      result.resolve({
        status: 'moved',
        cardVersionToken: 'card-v2',
        viewVersionToken: 'view-v2',
        rank: 'a1',
      })
      await result.promise
    })
    expect(refresh).toHaveBeenCalledTimes(1)

    await act(async () =>
      root.render(
        createElement(BoardView, {
          ...props,
          manifest: {
            ...manifest,
            viewRef: 'view-ref-v2',
            groups: [
              { ...manifest.groups[0]!, count: 0 },
              { ...manifest.groups[1]!, count: 1 },
            ],
          },
        }),
      ),
    )

    expect(host.querySelector('[data-group="doing-key"] [data-note-id="task-a"]')).not.toBeNull()
    expect(host.querySelector('[data-testid="board-column-skeleton"]')).toBeNull()
  })

  it('commits the last shown pointer gap target through the semantic move API', async () => {
    const refresh = vi.fn()
    const boardMove = vi.spyOn(api, 'boardMove').mockResolvedValue({
      status: 'moved',
      cardVersionToken: 'card-v2',
      viewVersionToken: 'view-v2',
      rank: 'a2',
    })
    const rows = [
      { id: 'task-a', title: 'Task A', filePath: 'work/a.md' },
      { id: 'task-b', title: 'Task B', filePath: 'work/b.md' },
    ]
    const props: ViewReaderComponentProps = {
      view: parsed.views[0]!,
      options: { groupBy: 'note.status' },
      mode: 'current-writer',
      projection: {},
      manifest: {
        viewRef: 'view-ref',
        block: 0,
        occurrence: 0,
        name: 'Board',
        type: 'board',
        status: 'ready',
        capabilities: { move: true },
        total: 2,
        groups: [
          { key: 'doing-key', state: 'value', value: 'doing', label: 'Doing', count: 2 },
          { key: 'done-key', state: 'value', value: 'done', label: 'Done', count: 0 },
        ],
      },
      loading: false,
      error: null,
      loadWindow: vi.fn(async ({ group }) => ({
        viewRef: 'view-ref',
        group,
        offset: 0,
        limit: 50,
        total: group === 'doing-key' ? 2 : 0,
        snapshotGeneration: 'g1',
        rows: group === 'doing-key' ? rows : [],
        execution: { exactReads: 0, exactCacheHits: 0, exactRemaining: 0 },
      })),
      refresh,
    }

    await act(async () => root.render(createElement(BoardView, props)))
    await act(async () => Promise.resolve())
    const first = host.querySelector<HTMLElement>('[data-note-id="task-a"]')!
    const second = host.querySelector<HTMLElement>('[data-note-id="task-b"]')!
    const list = second.parentElement!
    const transfer = new FakeDataTransfer()

    second.getBoundingClientRect = () => ({ top: 0, height: 100 }) as unknown as DOMRect
    await act(async () => {
      first.dispatchEvent(dragEvent('dragstart', transfer))
      second.dispatchEvent(dragEvent('dragover', transfer, 90))
    })

    expect(host.querySelectorAll('[data-testid="insertion-placeholder"]')).toHaveLength(1)
    expect(host.querySelectorAll('[data-drop]')).toHaveLength(0)

    await act(async () => {
      first.dispatchEvent(dragEvent('dragend', transfer))
    })
    expect(host.querySelectorAll('[data-testid="insertion-placeholder"]')).toHaveLength(0)

    await act(async () => {
      first.dispatchEvent(dragEvent('dragstart', transfer))
      second.dispatchEvent(dragEvent('dragover', transfer, 90))
      list.dispatchEvent(dragEvent('drop', transfer, 0))
      await Promise.resolve()
    })

    expect(boardMove).toHaveBeenCalledWith({
      viewRef: 'view-ref',
      cardId: 'task-a',
      to: { kind: 'value', value: 'doing' },
      afterId: 'task-b',
    })
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(host.textContent).toContain('Card moved to Doing.')

    await act(async () =>
      root.render(
        createElement(BoardView, {
          ...props,
          manifest: { ...props.manifest!, viewRef: 'view-ref-after-rank-write' },
        }),
      ),
    )
    expect(host.textContent).toContain('Card moved to Doing.')
  })

  it('uses the card drag surface without a grip and announces rank degradation', async () => {
    const refresh = vi.fn()
    const boardMove = vi.spyOn(api, 'boardMove').mockResolvedValue({
      status: 'moved-unranked',
      cardVersionToken: 'card-v2',
      viewVersionToken: 'view-v1',
      reason: 'rank-write-failed',
    })
    const props: ViewReaderComponentProps = {
      view: parsed.views[0]!,
      options: { groupBy: 'note.status' },
      mode: 'current-writer',
      projection: {},
      manifest: {
        viewRef: 'view-ref',
        block: 0,
        occurrence: 0,
        name: 'Board',
        type: 'board',
        status: 'ready',
        capabilities: { move: true },
        total: 2,
        groups: [
          { key: 'doing-key', state: 'value', value: 'doing', label: 'Doing', count: 2 },
          { key: 'done-key', state: 'value', value: 'done', label: 'Done', count: 0 },
        ],
      },
      loading: false,
      error: null,
      loadWindow: vi.fn(async ({ group }) => ({
        viewRef: 'view-ref',
        group,
        offset: 0,
        limit: 50,
        total: group === 'doing-key' ? 2 : 0,
        snapshotGeneration: 'g1',
        rows:
          group === 'doing-key'
            ? [
                { id: 'task-a', title: 'Task A', filePath: 'work/a.md' },
                { id: 'task-b', title: 'Task B', filePath: 'work/b.md' },
              ]
            : [],
        execution: { exactReads: 0, exactCacheHits: 0, exactRemaining: 0 },
      })),
      refresh,
    }

    await act(async () => root.render(createElement(BoardView, props)))
    await act(async () => Promise.resolve())
    const first = host.querySelector<HTMLElement>('[data-note-id="task-a"]')!
    const second = host.querySelector<HTMLElement>('[data-note-id="task-b"]')!
    const transfer = new FakeDataTransfer()

    expect(host.querySelector('[aria-label^="Reorder "]')).toBeNull()
    second.getBoundingClientRect = () => ({ top: 0, height: 100 }) as unknown as DOMRect
    await act(async () => {
      first.dispatchEvent(dragEvent('dragstart', transfer))
      second.dispatchEvent(dragEvent('dragover', transfer, 90))
      second.parentElement!.dispatchEvent(dragEvent('drop', transfer))
      await Promise.resolve()
    })

    expect(boardMove).toHaveBeenCalledWith({
      viewRef: 'view-ref',
      cardId: 'task-a',
      to: { kind: 'value', value: 'doing' },
      afterId: 'task-b',
    })
    expect(host.textContent).toContain('manual position could not be saved')
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('moves across columns and gaps from the focused card without resting controls', async () => {
    const VisibleColumnsObserver = function (
      this: { observe: (target: Element) => void; disconnect: () => void },
      callback: (entries: Array<{ isIntersecting: boolean; target: Element }>) => void,
    ) {
      this.observe = (target) => callback([{ isIntersecting: true, target }])
      this.disconnect = () => undefined
    }

    vi.stubGlobal('IntersectionObserver', VisibleColumnsObserver)
    const boardMove = vi.spyOn(api, 'boardMove').mockResolvedValue({
      status: 'moved',
      cardVersionToken: 'card-v2',
      viewVersionToken: 'view-v2',
      rank: 'a2',
    })
    const groups = [
      { key: 'doing-key', state: 'value' as const, value: 'doing', label: 'Doing', count: 2 },
      { key: 'done-key', state: 'value' as const, value: 'done', label: 'Done', count: 1 },
    ]

    await act(async () =>
      root.render(
        createElement(BoardView, {
          view: parsed.views[0]!,
          options: { groupBy: 'note.status' },
          mode: 'current-writer',
          projection: {},
          manifest: {
            viewRef: 'view-ref',
            block: 0,
            occurrence: 0,
            name: 'Board',
            type: 'board',
            status: 'ready',
            capabilities: { move: true },
            total: 3,
            groups,
          },
          loading: false,
          error: null,
          loadWindow: vi.fn(async ({ group }) => ({
            viewRef: 'view-ref',
            group,
            offset: 0,
            limit: 50,
            total: group === 'doing-key' ? 2 : 1,
            snapshotGeneration: 'g1',
            rows:
              group === 'doing-key'
                ? [
                    { id: 'task-a', title: 'Task A', filePath: 'work/a.md' },
                    { id: 'task-b', title: 'Task B', filePath: 'work/b.md' },
                  ]
                : [{ id: 'task-c', title: 'Task C', filePath: 'work/c.md' }],
            execution: { exactReads: 0, exactCacheHits: 0, exactRemaining: 0 },
          })),
          refresh: vi.fn(),
        }),
      ),
    )
    await act(async () => Promise.resolve())

    const card = host.querySelector<HTMLElement>('[data-note-id="task-a"]')!

    expect(card.tabIndex).toBe(0)
    expect(card.querySelector('button, svg')).toBeNull()
    expect(host.querySelector('[aria-label^="Reorder"], [aria-label^="Move"]')).toBeNull()
    card.getBoundingClientRect = () => ({ height: 72 }) as DOMRect
    card.focus()
    await act(async () =>
      card.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true })),
    )
    expect(host.textContent).toContain('Use arrow keys')

    await act(async () =>
      card.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })),
    )
    await act(async () =>
      card.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })),
    )
    expect(
      host.querySelector('[data-group="done-key"] [data-testid="insertion-placeholder"]'),
    ).not.toBeNull()

    await act(async () => {
      card.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
      await Promise.resolve()
    })

    expect(boardMove).toHaveBeenCalledWith({
      viewRef: 'view-ref',
      cardId: 'task-a',
      to: { kind: 'value', value: 'done' },
      afterId: 'task-c',
    })
    const moved = host.querySelector<HTMLElement>('[data-group="done-key"] [data-note-id="task-a"]')

    expect(moved).not.toBeNull()
    expect(document.activeElement).toBe(moved)
  })

  it('cancels keyboard move with Escape and exposes no mode to readers', async () => {
    const baseProps: ViewReaderComponentProps = {
      view: parsed.views[0]!,
      options: { groupBy: 'note.status' },
      mode: 'current-writer',
      projection: {},
      manifest: {
        viewRef: 'view-ref',
        block: 0,
        occurrence: 0,
        name: 'Board',
        type: 'board',
        status: 'ready',
        capabilities: { move: true },
        total: 1,
        groups: [{ key: 'doing-key', state: 'value', value: 'doing', label: 'Doing', count: 1 }],
      },
      loading: false,
      error: null,
      loadWindow: vi.fn(async ({ group }) => ({
        viewRef: 'view-ref',
        group,
        offset: 0,
        limit: 50,
        total: 1,
        snapshotGeneration: 'g1',
        rows: [{ id: 'task-a', title: 'Task A', filePath: 'work/a.md' }],
        execution: { exactReads: 0, exactCacheHits: 0, exactRemaining: 0 },
      })),
      refresh: vi.fn(),
    }

    await act(async () => root.render(createElement(BoardView, baseProps)))
    await act(async () => Promise.resolve())
    const card = host.querySelector<HTMLElement>('[data-note-id="task-a"]')!

    card.getBoundingClientRect = () => ({ height: 72 }) as DOMRect
    card.focus()
    await act(async () =>
      card.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true })),
    )
    await act(async () =>
      card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    )
    expect(host.textContent).toContain('Card move cancelled.')
    expect(document.activeElement).toBe(card)

    await act(async () =>
      card.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true })),
    )

    await act(async () =>
      root.render(createElement(BoardView, { ...baseProps, mode: 'current-reader' })),
    )
    expect(
      host.querySelector<HTMLElement>('[data-note-id="task-a"]')?.getAttribute('tabindex'),
    ).toBe(null)
    expect(host.querySelector('[aria-keyshortcuts]')).toBeNull()
    expect(document.activeElement).toBe(host.querySelector('[data-board]'))
    expect(host.textContent).toContain('cancelled because the board changed')
  })

  it('cancels an orphaned keyboard move after reconcile and restores the next card focus', async () => {
    let generation = 'g1'
    const loadWindow = vi.fn(async ({ group }) => ({
      viewRef: 'view-ref',
      group,
      offset: 0,
      limit: 50,
      total: generation === 'g1' ? 2 : 1,
      snapshotGeneration: generation,
      rows:
        generation === 'g1'
          ? [
              { id: 'task-a', title: 'Task A', filePath: 'work/a.md' },
              { id: 'task-b', title: 'Task B', filePath: 'work/b.md' },
            ]
          : [{ id: 'task-b', title: 'Task B', filePath: 'work/b.md' }],
      execution: { exactReads: 0, exactCacheHits: 0, exactRemaining: 0 },
    }))
    const manifest = {
      viewRef: 'view-ref',
      block: 0,
      occurrence: 0,
      name: 'Board',
      type: 'board',
      status: 'ready' as const,
      capabilities: { move: true as const },
      total: 2,
      snapshotGeneration: 'g1',
      groups: [
        { key: 'doing-key', state: 'value' as const, value: 'doing', label: 'Doing', count: 2 },
      ],
    }
    const props: ViewReaderComponentProps = {
      view: parsed.views[0]!,
      options: {},
      mode: 'current-writer',
      projection: {},
      manifest,
      loading: false,
      error: null,
      loadWindow,
      refresh: vi.fn(),
    }

    await act(async () => root.render(createElement(BoardView, props)))
    await act(async () => Promise.resolve())
    const first = host.querySelector<HTMLElement>('[data-note-id="task-a"]')!
    const second = host.querySelector<HTMLElement>('[data-note-id="task-b"]')!

    first.getBoundingClientRect = () => ({ height: 72 }) as DOMRect
    first.focus()
    await act(async () =>
      first.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true })),
    )
    expect(second.getAttribute('draggable')).toBe('false')
    expect(second.getAttribute('tabindex')).toBeNull()

    generation = 'g2'
    await act(async () =>
      root.render(
        createElement(BoardView, {
          ...props,
          manifest: {
            ...manifest,
            snapshotGeneration: 'g2',
            total: 1,
            groups: [{ ...manifest.groups[0]!, count: 1 }],
          },
        }),
      ),
    )
    await act(async () => Promise.resolve())
    const survivor = host.querySelector<HTMLElement>('[data-note-id="task-b"]')!

    expect(host.querySelector('[data-note-id="task-a"]')).toBeNull()
    expect(survivor.getAttribute('draggable')).toBe('true')
    expect(survivor.getAttribute('tabindex')).toBe('0')
    expect(document.activeElement).toBe(survivor)
    expect(host.textContent).toContain('cancelled because the board changed')
  })

  it('renders an invalid source diagnostic instead of a false empty board', async () => {
    await act(async () =>
      root.render(
        createElement(BoardView, {
          view: parsed.views[0]!,
          options: {},
          mode: 'current-writer',
          projection: {},
          manifest: {
            block: 0,
            occurrence: 0,
            name: 'Board',
            type: 'board',
            status: 'invalid',
            diagnostics: ['Source “future-source” is unavailable.'],
          },
          loading: false,
          error: null,
          loadWindow: vi.fn(),
          refresh: vi.fn(),
        }),
      ),
    )

    expect(host.textContent).toContain('Source “future-source” is unavailable.')
    expect(host.textContent).not.toContain('No columns')
  })

  it('scrolls and loads an offscreen keyboard target before allowing commit', async () => {
    const destinationWindow = deferred<{
      viewRef: string
      group: string
      offset: number
      limit: number
      total: number
      snapshotGeneration: string
      rows: Array<{ id: string; title: string; filePath: string }>
      execution: { exactReads: number; exactCacheHits: number; exactRemaining: number }
    }>()
    const boardMove = vi.spyOn(api, 'boardMove').mockResolvedValue({
      status: 'moved',
      cardVersionToken: 'card-v2',
      viewVersionToken: 'view-v2',
      rank: 'a1',
    })
    const loadWindow = vi.fn(({ group }) =>
      group === 'doing-key'
        ? Promise.resolve({
            viewRef: 'view-ref',
            group,
            offset: 0,
            limit: 50,
            total: 1,
            snapshotGeneration: 'g1',
            rows: [{ id: 'task-a', title: 'Task A', filePath: 'work/a.md' }],
            execution: { exactReads: 0, exactCacheHits: 0, exactRemaining: 0 },
          })
        : destinationWindow.promise,
    )

    await act(async () =>
      root.render(
        createElement(BoardView, {
          view: parsed.views[0]!,
          options: {},
          mode: 'current-writer',
          projection: {},
          manifest: {
            viewRef: 'view-ref',
            block: 0,
            occurrence: 0,
            name: 'Board',
            type: 'board',
            status: 'ready',
            capabilities: { move: true },
            total: 2,
            groups: [
              { key: 'doing-key', state: 'value', value: 'doing', label: 'Doing', count: 1 },
              { key: 'done-key', state: 'value', value: 'done', label: 'Done', count: 1 },
            ],
          },
          loading: false,
          error: null,
          loadWindow,
          refresh: vi.fn(),
        }),
      ),
    )
    await act(async () => Promise.resolve())
    const card = host.querySelector<HTMLElement>('[data-note-id="task-a"]')!
    const destination = host.querySelector<HTMLElement>('[data-group="done-key"]')!
    const scrollIntoView = vi.fn()

    destination.scrollIntoView = scrollIntoView
    card.getBoundingClientRect = () => ({ height: 72 }) as DOMRect
    card.focus()
    await act(async () =>
      card.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true })),
    )
    await act(async () =>
      card.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })),
    )

    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', inline: 'start' })
    expect(loadWindow).toHaveBeenCalledWith(expect.objectContaining({ group: 'done-key' }))
    expect(host.textContent).toContain('Loading Done')
    await act(async () =>
      card.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true })),
    )
    expect(boardMove).not.toHaveBeenCalled()

    await act(async () => {
      destinationWindow.resolve({
        viewRef: 'view-ref',
        group: 'done-key',
        offset: 0,
        limit: 50,
        total: 1,
        snapshotGeneration: 'g1',
        rows: [{ id: 'task-c', title: 'Task C', filePath: 'work/c.md' }],
        execution: { exactReads: 0, exactCacheHits: 0, exactRemaining: 0 },
      })
      await destinationWindow.promise
    })
    await act(async () => {
      card.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
      await Promise.resolve()
    })
    expect(boardMove).toHaveBeenCalledWith({
      viewRef: 'view-ref',
      cardId: 'task-a',
      to: { kind: 'value', value: 'done' },
      beforeId: 'task-c',
    })
  })

  it('moves a keyboard card out of a structural non-destination column', async () => {
    const boardMove = vi.spyOn(api, 'boardMove').mockResolvedValue({
      status: 'moved',
      cardVersionToken: 'card-v2',
      viewVersionToken: 'view-v2',
      rank: 'a1',
    })

    await act(async () =>
      root.render(
        createElement(BoardView, {
          view: parsed.views[0]!,
          options: {},
          mode: 'current-writer',
          projection: {},
          manifest: {
            viewRef: 'view-ref',
            block: 0,
            occurrence: 0,
            name: 'Board',
            type: 'board',
            status: 'ready',
            capabilities: { move: true },
            total: 1,
            groups: [
              { key: 'unreadable-key', state: 'unreadable', label: 'Unreadable', count: 1 },
              { key: 'doing-key', state: 'value', value: 'doing', label: 'Doing', count: 0 },
            ],
          },
          loading: false,
          error: null,
          loadWindow: vi.fn(async ({ group }) => ({
            viewRef: 'view-ref',
            group,
            offset: 0,
            limit: 50,
            total: 1,
            snapshotGeneration: 'g1',
            rows: [{ id: 'task-a', title: 'Task A', filePath: 'work/a.md' }],
            execution: { exactReads: 0, exactCacheHits: 0, exactRemaining: 0 },
          })),
          refresh: vi.fn(),
        }),
      ),
    )
    await act(async () => Promise.resolve())
    const card = host.querySelector<HTMLElement>('[data-note-id="task-a"]')!

    card.getBoundingClientRect = () => ({ height: 72 }) as DOMRect
    card.focus()
    await act(async () =>
      card.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true })),
    )
    await act(async () =>
      card.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })),
    )
    expect(
      host.querySelector('[data-group="doing-key"] [data-testid="insertion-placeholder"]'),
    ).not.toBeNull()
    await act(async () => {
      card.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
      await Promise.resolve()
    })

    expect(boardMove).toHaveBeenCalledWith({
      viewRef: 'view-ref',
      cardId: 'task-a',
      to: { kind: 'value', value: 'doing' },
    })
  })

  it('restores keyboard focus to the source card after a refused cross-column move', async () => {
    const refusal = new ApiError('move refused')

    refusal.status = 400
    vi.spyOn(api, 'boardMove').mockRejectedValue(refusal)
    const manifest = {
      viewRef: 'view-ref',
      block: 0,
      occurrence: 0,
      name: 'Board',
      type: 'board',
      status: 'ready' as const,
      capabilities: { move: true as const },
      total: 1,
      groups: [
        {
          key: 'backlog-key',
          state: 'value' as const,
          value: 'backlog',
          label: 'Backlog',
          count: 1,
        },
        { key: 'done-key', state: 'value' as const, value: 'done', label: 'Done', count: 0 },
      ],
    }

    await act(async () =>
      root.render(
        createElement(BoardView, {
          view: parsed.views[0]!,
          options: {},
          mode: 'current-writer',
          projection: {},
          manifest,
          loading: false,
          error: null,
          loadWindow: vi.fn(async ({ group }) => ({
            viewRef: 'view-ref',
            group,
            offset: 0,
            limit: 50,
            total: 1,
            snapshotGeneration: 'g1',
            rows: [{ id: 'task-a', title: 'Task A', filePath: 'work/a.md' }],
            execution: { exactReads: 0, exactCacheHits: 0, exactRemaining: 0 },
          })),
          refresh: vi.fn(),
        }),
      ),
    )
    await act(async () => Promise.resolve())
    const card = host.querySelector<HTMLElement>('[data-note-id="task-a"]')!

    card.getBoundingClientRect = () => ({ height: 72 }) as DOMRect
    card.focus()
    await act(async () =>
      card.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true })),
    )
    await act(async () =>
      card.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })),
    )
    await act(async () => {
      card.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
      await Promise.resolve()
    })
    const restored = host.querySelector<HTMLElement>(
      '[data-group="backlog-key"] [data-note-id="task-a"]',
    )

    expect(restored).not.toBeNull()
    expect(document.activeElement).toBe(restored)
    expect(host.textContent).toContain('move refused')
  })

  it('fences a window from a different manifest generation and refreshes once', async () => {
    const refresh = vi.fn()
    const loadWindow = vi.fn(async ({ group }) => ({
      viewRef: 'view-ref',
      group,
      offset: 0,
      limit: 50,
      total: 1,
      snapshotGeneration: 'g2',
      schemaVersionToken: 'schema-2',
      rows: [{ id: 'task-a', title: 'Task A', filePath: 'work/a.md' }],
      execution: { exactReads: 0, exactCacheHits: 0, exactRemaining: 0 },
    }))

    await act(async () =>
      root.render(
        createElement(BoardView, {
          view: parsed.views[0]!,
          options: {},
          mode: 'current-reader',
          projection: {},
          manifest: {
            viewRef: 'view-ref',
            block: 0,
            occurrence: 0,
            name: 'Board',
            type: 'board',
            status: 'ready',
            total: 1,
            snapshotGeneration: 'g1',
            schemaVersionToken: 'schema-1',
            groups: [
              { key: 'doing-key', state: 'value', value: 'doing', label: 'Doing', count: 1 },
            ],
          },
          loading: false,
          error: null,
          loadWindow,
          refresh,
        }),
      ),
    )
    await act(async () => Promise.resolve())

    expect(host.querySelector('[data-note-id="task-a"]')).toBeNull()
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(loadWindow).toHaveBeenCalledTimes(1)
  })

  it('keeps a same-generation 409 fence across manifest objects without a refresh loop', async () => {
    const refresh = vi.fn()
    const conflict = new ApiError('snapshot conflict')

    conflict.status = 409
    let call = 0
    const loadWindow = vi.fn(async ({ group, offset = 0 }) => {
      call++
      if (call === 2) {
        throw conflict
      }
      const g2 = call >= 5
      const rows =
        call === 1
          ? [{ id: 'task-a', title: 'Stale task', filePath: 'work/a.md' }]
          : call === 3
            ? [{ id: 'task-b', title: 'Recovered tail', filePath: 'work/b.md' }]
            : g2
              ? [{ id: 'task-a', title: 'Fresh task', filePath: 'work/a.md' }]
              : [
                  { id: 'task-a', title: 'Recovered task', filePath: 'work/a.md' },
                  { id: 'task-b', title: 'Recovered tail', filePath: 'work/b.md' },
                ]

      return {
        viewRef: 'view-ref',
        group,
        offset,
        limit: 50,
        total: g2 ? 1 : 2,
        snapshotGeneration: g2 ? 'g2' : 'g1',
        rows,
        execution: { exactReads: 0, exactCacheHits: 0, exactRemaining: 0 },
      }
    })
    const manifest = {
      viewRef: 'view-ref',
      block: 0,
      occurrence: 0,
      name: 'Board',
      type: 'board',
      status: 'ready' as const,
      total: 2,
      snapshotGeneration: 'g1',
      groups: [
        { key: 'doing-key', state: 'value' as const, value: 'doing', label: 'Doing', count: 2 },
      ],
    }
    const props: ViewReaderComponentProps = {
      view: parsed.views[0]!,
      options: {},
      mode: 'current-reader',
      projection: {},
      manifest,
      loading: false,
      error: null,
      loadWindow,
      refresh,
    }

    await act(async () => root.render(createElement(BoardView, props)))
    await act(async () => Promise.resolve())
    expect(host.textContent).toContain('Stale task')

    await act(async () =>
      root.render(createElement(BoardView, { ...props, manifest: { ...manifest } })),
    )
    await act(async () => Promise.resolve())
    expect(loadWindow).toHaveBeenCalledTimes(2)
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(host.textContent).toContain('Stale task')
    expect(host.textContent).toContain('Board snapshot changed')

    await act(async () =>
      root.render(createElement(BoardView, { ...props, manifest: { ...manifest } })),
    )
    await act(async () => Promise.resolve())
    expect(loadWindow).toHaveBeenCalledTimes(2)
    expect(refresh).toHaveBeenCalledTimes(1)

    const retry = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === 'Retry',
    )!
    await act(async () => {
      retry.click()
      await Promise.resolve()
    })
    expect(loadWindow).toHaveBeenCalledTimes(3)
    expect(host.textContent).toContain('Recovered tail')
    expect(host.textContent).not.toContain('Board snapshot changed')

    await act(async () =>
      root.render(createElement(BoardView, { ...props, manifest: { ...manifest } })),
    )
    await act(async () => Promise.resolve())
    expect(loadWindow).toHaveBeenCalledTimes(4)
    expect(host.textContent).toContain('Recovered task')

    await act(async () =>
      root.render(
        createElement(BoardView, {
          ...props,
          manifest: {
            ...manifest,
            snapshotGeneration: 'g2',
            total: 1,
            groups: [{ ...manifest.groups[0]!, count: 1 }],
          },
        }),
      ),
    )
    await act(async () => Promise.resolve())
    expect(loadWindow).toHaveBeenCalledTimes(5)
    expect(host.textContent).toContain('Fresh task')
    expect(host.textContent).not.toContain('Board snapshot changed')
  })

  it('offers Retry for a full 50-row column after 409 and recovers without another refresh', async () => {
    const refresh = vi.fn()
    const conflict = new ApiError('snapshot conflict')

    conflict.status = 409
    const rows = Array.from({ length: 50 }, (_, index) => ({
      id: `task-${index}`,
      title: `Task ${index}`,
      filePath: `work/${index}.md`,
    }))
    let call = 0
    const loadWindow = vi.fn(async ({ group, offset = 0, limit = 50 }) => {
      call++
      if (call === 2) {
        throw conflict
      }

      return {
        viewRef: 'view-ref',
        group,
        offset,
        limit,
        total: 50,
        snapshotGeneration: 'g1',
        rows,
        execution: { exactReads: 0, exactCacheHits: 0, exactRemaining: 0 },
      }
    })
    const manifest = {
      viewRef: 'view-ref',
      block: 0,
      occurrence: 0,
      name: 'Board',
      type: 'board',
      status: 'ready' as const,
      total: 50,
      snapshotGeneration: 'g1',
      groups: [
        { key: 'doing-key', state: 'value' as const, value: 'doing', label: 'Doing', count: 50 },
      ],
    }
    const props: ViewReaderComponentProps = {
      view: parsed.views[0]!,
      options: {},
      mode: 'current-reader',
      projection: {},
      manifest,
      loading: false,
      error: null,
      loadWindow,
      refresh,
    }

    await act(async () => root.render(createElement(BoardView, props)))
    await act(async () => Promise.resolve())
    expect(host.querySelectorAll('[data-note-id]')).toHaveLength(50)

    await act(async () =>
      root.render(createElement(BoardView, { ...props, manifest: { ...manifest } })),
    )
    await act(async () => Promise.resolve())
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(host.textContent).toContain('Board snapshot changed')
    expect(host.querySelectorAll('[data-note-id]')).toHaveLength(50)
    expect(host.textContent).not.toContain('Load more')
    const retry = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === 'Retry',
    )!

    await act(async () => {
      retry.focus()
      retry.click()
      await Promise.resolve()
    })
    expect(loadWindow).toHaveBeenCalledTimes(3)
    expect(loadWindow.mock.calls[2]?.[0]).toEqual(
      expect.objectContaining({ group: 'doing-key', offset: 0, limit: 50 }),
    )
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(host.textContent).not.toContain('Board snapshot changed')
    expect(host.querySelectorAll('[data-note-id]')).toHaveLength(50)
  })

  it('reconciles every loaded row without collapsing a 100-row column', async () => {
    const reconciliation = deferred<{
      viewRef: string
      group: string
      offset: number
      limit: number
      total: number
      snapshotGeneration: string
      rows: Array<{ id: string; title: string; filePath: string }>
      execution: { exactReads: number; exactCacheHits: number; exactRemaining: number }
    }>()
    const initialRows = Array.from({ length: 100 }, (_, index) => ({
      id: `task-${index}`,
      title: `Task ${index}`,
      filePath: `work/${index}.md`,
    }))
    const loadWindowMock = vi.fn(({ offset = 0, limit = 50, group }) => {
      if (loadWindowMock.mock.calls.length <= 2) {
        return Promise.resolve({
          viewRef: 'view-ref-v1',
          group,
          offset,
          limit,
          total: 100,
          snapshotGeneration: 'g1',
          rows: initialRows.slice(offset, offset + limit),
          execution: { exactReads: 0, exactCacheHits: 0, exactRemaining: 0 },
        })
      }

      return reconciliation.promise
    })
    const loadWindow = loadWindowMock as ViewReaderComponentProps['loadWindow']
    const manifest = {
      viewRef: 'view-ref-v1',
      block: 0,
      occurrence: 0,
      name: 'Board',
      type: 'board',
      status: 'ready' as const,
      total: 100,
      snapshotGeneration: 'g1',
      groups: [
        { key: 'doing-key', state: 'value' as const, value: 'doing', label: 'Doing', count: 100 },
      ],
    }
    const props: ViewReaderComponentProps = {
      view: parsed.views[0]!,
      options: {},
      mode: 'current-reader',
      projection: {},
      manifest,
      loading: false,
      error: null,
      loadWindow,
      refresh: vi.fn(),
    }

    await act(async () => root.render(createElement(BoardView, props)))
    await act(async () => Promise.resolve())
    const loadMore = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === 'Load more',
    )!

    await act(async () => {
      loadMore.click()
      await Promise.resolve()
    })
    expect(host.querySelectorAll('[data-note-id]')).toHaveLength(100)

    await act(async () =>
      root.render(
        createElement(BoardView, {
          ...props,
          manifest: { ...manifest, viewRef: 'view-ref-v2', snapshotGeneration: 'g2' },
        }),
      ),
    )
    expect(host.querySelectorAll('[data-note-id]')).toHaveLength(100)
    expect(host.querySelector('[data-note-id="task-99"]')).not.toBeNull()
    expect(loadWindowMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ group: 'doing-key', offset: 0, limit: 100 }),
    )

    const reconciledRows = initialRows.map((row) =>
      row.id === 'task-99' ? { ...row, title: 'Task 99 refreshed' } : row,
    )
    await act(async () => {
      reconciliation.resolve({
        viewRef: 'view-ref-v2',
        group: 'doing-key',
        offset: 0,
        limit: 100,
        total: 100,
        snapshotGeneration: 'g2',
        rows: reconciledRows,
        execution: { exactReads: 0, exactCacheHits: 0, exactRemaining: 0 },
      })
      await reconciliation.promise
    })
    expect(host.querySelectorAll('[data-note-id]')).toHaveLength(100)
    expect(host.querySelector('[data-note-id="task-99"]')?.textContent).toContain('refreshed')
  })

  it('limits all concurrent board windows to four across visible columns', async () => {
    const VisibleColumnsObserver = function (
      this: { observe: (target: Element) => void; disconnect: () => void },
      callback: (entries: Array<{ isIntersecting: boolean; target: Element }>) => void,
    ) {
      this.observe = (target) => callback([{ isIntersecting: true, target }])
      this.disconnect = () => undefined
    }

    vi.stubGlobal('IntersectionObserver', VisibleColumnsObserver)
    let active = 0
    let maxActive = 0
    const loadWindow = vi.fn(async ({ group }) => {
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 10))
      active--
      return {
        viewRef: 'view-ref',
        group,
        offset: 0,
        limit: 50,
        total: 1,
        snapshotGeneration: 'g1',
        rows: [{ id: `task-${group}`, title: `Task ${group}`, filePath: `work/${group}.md` }],
        execution: { exactReads: 0, exactCacheHits: 0, exactRemaining: 0 },
      }
    })
    const groups = Array.from({ length: 10 }, (_, index) => ({
      key: `group-${index}`,
      state: 'value' as const,
      value: `group-${index}`,
      label: `Group ${index}`,
      count: 1,
    }))

    await act(async () =>
      root.render(
        createElement(BoardView, {
          view: parsed.views[0]!,
          options: {},
          mode: 'current-reader',
          projection: {},
          manifest: {
            viewRef: 'view-ref',
            block: 0,
            occurrence: 0,
            name: 'Board',
            type: 'board',
            status: 'ready',
            total: 10,
            snapshotGeneration: 'g1',
            groups,
          },
          loading: false,
          error: null,
          loadWindow,
          refresh: vi.fn(),
        }),
      ),
    )
    await act(async () => new Promise((resolve) => setTimeout(resolve, 80)))

    expect(loadWindow).toHaveBeenCalledTimes(10)
    expect(maxActive).toBe(4)
    expect(active).toBe(0)
  })

  it('does not let a failed move rollback overwrite newer window completions', async () => {
    const moveResult = deferred<Awaited<ReturnType<typeof api.boardMove>>>()
    vi.spyOn(api, 'boardMove').mockReturnValue(moveResult.promise)
    const initialRows = Array.from({ length: 50 }, (_, index) => ({
      id: `task-${index}`,
      title: `Task ${index}`,
      filePath: `work/${index}.md`,
    }))
    const loadWindow = vi.fn(async ({ group, limit = 50 }) => ({
      viewRef: 'view-ref',
      group,
      offset: 0,
      limit,
      total: group === 'doing-key' ? 51 : 0,
      snapshotGeneration: loadWindow.mock.calls.length <= 1 ? 'g1' : 'g2',
      rows:
        group === 'doing-key'
          ? [
              ...initialRows.slice(0, 49),
              { id: 'task-new', title: 'Arrived during move', filePath: 'work/new.md' },
            ].slice(0, limit)
          : [],
      execution: { exactReads: 0, exactCacheHits: 0, exactRemaining: 0 },
    }))
    const manifest = {
      viewRef: 'view-ref-v1',
      block: 0,
      occurrence: 0,
      name: 'Board',
      type: 'board',
      status: 'ready' as const,
      capabilities: { move: true as const },
      total: 50,
      snapshotGeneration: 'g1',
      groups: [
        { key: 'doing-key', state: 'value' as const, value: 'doing', label: 'Doing', count: 50 },
        { key: 'done-key', state: 'value' as const, value: 'done', label: 'Done', count: 0 },
      ],
    }
    const props: ViewReaderComponentProps = {
      view: parsed.views[0]!,
      options: {},
      mode: 'current-writer',
      projection: {},
      manifest,
      loading: false,
      error: null,
      loadWindow,
      refresh: vi.fn(),
    }

    await act(async () => root.render(createElement(BoardView, props)))
    await act(async () => Promise.resolve())
    const card = host.querySelector<HTMLElement>('[data-note-id="task-0"]')!
    const destination = host.querySelector<HTMLElement>('[data-group="done-key"]')!
    const transfer = new FakeDataTransfer()

    await act(async () => {
      card.dispatchEvent(dragEvent('dragstart', transfer))
      destination.lastElementChild!.dispatchEvent(dragEvent('dragover', transfer))
      destination.lastElementChild!.dispatchEvent(dragEvent('drop', transfer))
    })

    await act(async () =>
      root.render(
        createElement(BoardView, {
          ...props,
          manifest: {
            ...manifest,
            viewRef: 'view-ref-v2',
            snapshotGeneration: 'g2',
            total: 51,
            groups: [{ ...manifest.groups[0]!, count: 51 }, manifest.groups[1]!],
          },
        }),
      ),
    )
    await act(async () => Promise.resolve())
    expect(host.textContent).toContain('Arrived during move')

    await act(async () => {
      moveResult.resolve({
        status: 'unchanged',
        cardVersionToken: 'card-v1',
        viewVersionToken: 'view-v2',
      })
      await moveResult.promise
    })
    expect(host.textContent).toContain('Arrived during move')
    expect(host.querySelectorAll('[data-note-id="task-0"]')).toHaveLength(1)
    expect(host.querySelector('[data-group="doing-key"] [data-note-id="task-0"]')).not.toBeNull()
  })

  it('rolls back after a newer load starts but fails and preserves that load error', async () => {
    const moveResult = deferred<Awaited<ReturnType<typeof api.boardMove>>>()

    vi.spyOn(api, 'boardMove').mockReturnValue(moveResult.promise)
    let call = 0
    const loadWindow = vi.fn(async ({ group }) => {
      call++
      if (call > 1) {
        throw new Error('reconcile failed')
      }

      return {
        viewRef: 'view-ref',
        group,
        offset: 0,
        limit: 50,
        total: 1,
        snapshotGeneration: 'g1',
        rows: [{ id: 'task-a', title: 'Task A', filePath: 'work/a.md' }],
        execution: { exactReads: 0, exactCacheHits: 0, exactRemaining: 0 },
      }
    })
    const manifest = {
      viewRef: 'view-ref',
      block: 0,
      occurrence: 0,
      name: 'Board',
      type: 'board',
      status: 'ready' as const,
      capabilities: { move: true as const },
      total: 1,
      groups: [
        { key: 'doing-key', state: 'value' as const, value: 'doing', label: 'Doing', count: 1 },
        { key: 'done-key', state: 'value' as const, value: 'done', label: 'Done', count: 0 },
      ],
    }
    const props: ViewReaderComponentProps = {
      view: parsed.views[0]!,
      options: {},
      mode: 'current-writer',
      projection: {},
      manifest,
      loading: false,
      error: null,
      loadWindow,
      refresh: vi.fn(),
    }

    await act(async () => root.render(createElement(BoardView, props)))
    await act(async () => Promise.resolve())
    const card = host.querySelector<HTMLElement>('[data-note-id="task-a"]')!
    const destination = host.querySelector<HTMLElement>('[data-group="done-key"]')!
    const transfer = new FakeDataTransfer()

    await act(async () => {
      card.dispatchEvent(dragEvent('dragstart', transfer))
      destination.lastElementChild!.dispatchEvent(dragEvent('dragover', transfer))
      destination.lastElementChild!.dispatchEvent(dragEvent('drop', transfer))
    })
    await act(async () =>
      root.render(createElement(BoardView, { ...props, manifest: { ...manifest } })),
    )
    await act(async () => Promise.resolve())
    expect(host.textContent).toContain('reconcile failed')

    await act(async () => {
      moveResult.resolve({
        status: 'unchanged',
        cardVersionToken: 'card-v1',
        viewVersionToken: 'view-v1',
      })
      await moveResult.promise
    })
    expect(host.querySelector('[data-group="doing-key"] [data-note-id="task-a"]')).not.toBeNull()
    expect(host.querySelector('[data-group="done-key"] [data-note-id="task-a"]')).toBeNull()
    expect(host.textContent).toContain('reconcile failed')
  })

  it('retains a 100-row loaded extent through optimistic removal before reconcile and rejection', async () => {
    const moveResult = deferred<Awaited<ReturnType<typeof api.boardMove>>>()
    const refusal = new ApiError('move refused')

    refusal.status = 400
    vi.spyOn(api, 'boardMove').mockReturnValue(moveResult.promise)
    const rows = Array.from({ length: 100 }, (_, index) => ({
      id: `task-${index}`,
      title: `Task ${index}`,
      filePath: `work/${index}.md`,
    }))
    let reconcile = false
    const loadWindow = vi.fn(async ({ group, offset = 0, limit = 50 }) => ({
      viewRef: 'view-ref',
      group,
      offset,
      limit,
      total: group === 'source-key' ? 100 : 0,
      snapshotGeneration: reconcile ? 'g2' : 'g1',
      rows: group === 'source-key' ? rows.slice(offset, offset + limit) : [],
      execution: { exactReads: 0, exactCacheHits: 0, exactRemaining: 0 },
    }))
    const manifest = {
      viewRef: 'view-ref',
      block: 0,
      occurrence: 0,
      name: 'Board',
      type: 'board',
      status: 'ready' as const,
      capabilities: { move: true as const },
      total: 100,
      snapshotGeneration: 'g1',
      groups: [
        {
          key: 'source-key',
          state: 'value' as const,
          value: 'source',
          label: 'Source',
          count: 100,
        },
        {
          key: 'destination-key',
          state: 'value' as const,
          value: 'destination',
          label: 'Destination',
          count: 0,
        },
      ],
    }
    const props: ViewReaderComponentProps = {
      view: parsed.views[0]!,
      options: {},
      mode: 'current-writer',
      projection: {},
      manifest,
      loading: false,
      error: null,
      loadWindow,
      refresh: vi.fn(),
    }

    await act(async () => root.render(createElement(BoardView, props)))
    await act(async () => Promise.resolve())
    const loadMore = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === 'Load more',
    )!
    await act(async () => {
      loadMore.click()
      await Promise.resolve()
    })
    expect(host.querySelectorAll('[data-note-id]')).toHaveLength(100)

    const card = host.querySelector<HTMLElement>('[data-note-id="task-99"]')!

    card.getBoundingClientRect = () => ({ height: 72 }) as DOMRect
    card.focus()
    await act(async () =>
      card.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true })),
    )
    await act(async () =>
      card.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })),
    )
    await act(async () =>
      card.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true })),
    )

    reconcile = true
    await act(async () =>
      root.render(
        createElement(BoardView, {
          ...props,
          manifest: { ...manifest, snapshotGeneration: 'g2' },
        }),
      ),
    )
    await act(async () => Promise.resolve())
    const sourceReconcile = loadWindow.mock.calls.find(
      ([input], index) => index >= 2 && input.group === 'source-key',
    )?.[0]

    expect(sourceReconcile).toEqual(expect.objectContaining({ offset: 0, limit: 100 }))
    expect(host.querySelectorAll('[data-note-id]')).toHaveLength(100)
    expect(host.querySelectorAll('[data-note-id="task-99"]')).toHaveLength(1)

    await act(async () => {
      moveResult.reject(refusal)
      await moveResult.promise.catch(() => undefined)
    })
    const restored = host.querySelector<HTMLElement>(
      '[data-group="source-key"] [data-note-id="task-99"]',
    )

    expect(host.querySelectorAll('[data-note-id]')).toHaveLength(100)
    expect(host.querySelectorAll('[data-note-id="task-99"]')).toHaveLength(1)
    expect(restored).not.toBeNull()
    expect(document.activeElement).toBe(restored)
  })

  it('fences an ignored-abort A response across an A to B to A identity cycle', async () => {
    const oldA = deferred<Awaited<ReturnType<ViewReaderComponentProps['loadWindow']>>>()
    const newA = deferred<Awaited<ReturnType<ViewReaderComponentProps['loadWindow']>>>()
    let call = 0
    const response = (title: string) => ({
      viewRef: 'view-ref',
      group: 'doing-key',
      offset: 0,
      limit: 50,
      total: 1,
      snapshotGeneration: 'g1',
      rows: [{ id: title.toLowerCase().replaceAll(' ', '-'), title, filePath: 'work/task.md' }],
      execution: { exactReads: 0, exactCacheHits: 0, exactRemaining: 0 },
    })
    const loadWindow = vi.fn(() => {
      call++
      if (call === 1) {
        return oldA.promise
      }
      if (call === 2) {
        return Promise.resolve(response('Board B'))
      }

      return newA.promise
    })
    const manifest = {
      viewRef: 'view-ref',
      block: 0,
      occurrence: 0,
      name: 'Board',
      type: 'board',
      status: 'ready' as const,
      total: 1,
      groups: [
        { key: 'doing-key', state: 'value' as const, value: 'doing', label: 'Doing', count: 1 },
      ],
    }
    const props: ViewReaderComponentProps = {
      view: parsed.views[0]!,
      options: {},
      mode: 'current-reader',
      projection: {},
      manifest,
      loading: false,
      error: null,
      loadWindow,
      refresh: vi.fn(),
    }

    await act(async () => root.render(createElement(BoardView, props)))
    await act(async () => Promise.resolve())
    await act(async () =>
      root.render(
        createElement(BoardView, {
          ...props,
          view: { ...props.view, block: 1 },
          manifest: { ...manifest, block: 1 },
        }),
      ),
    )
    await act(async () => Promise.resolve())
    expect(host.textContent).toContain('Board B')

    await act(async () => root.render(createElement(BoardView, props)))
    await act(async () => Promise.resolve())
    await act(async () => {
      newA.resolve(response('Fresh Board A'))
      await newA.promise
    })
    expect(host.textContent).toContain('Fresh Board A')

    await act(async () => {
      oldA.resolve(response('Stale Board A'))
      await oldA.promise
    })
    expect(host.textContent).toContain('Fresh Board A')
    expect(host.textContent).not.toContain('Stale Board A')
  })

  it('ignores an old window when same-generation manifest viewRef changes', async () => {
    const oldWindow = deferred<Awaited<ReturnType<ViewReaderComponentProps['loadWindow']>>>()
    const freshWindow = deferred<Awaited<ReturnType<ViewReaderComponentProps['loadWindow']>>>()
    let call = 0
    const response = (viewRef: string, title: string) => ({
      viewRef,
      group: 'doing-key',
      offset: 0,
      limit: 50,
      total: 1,
      snapshotGeneration: 'g1',
      rows: [{ id: 'task-a', title, filePath: 'work/a.md' }],
      execution: { exactReads: 0, exactCacheHits: 0, exactRemaining: 0 },
    })
    const loadWindow = vi.fn(() => (++call === 1 ? oldWindow.promise : freshWindow.promise))
    const manifest = {
      viewRef: 'view-ref-old',
      block: 0,
      occurrence: 0,
      name: 'Board',
      type: 'board',
      status: 'ready' as const,
      total: 1,
      snapshotGeneration: 'g1',
      groups: [
        { key: 'doing-key', state: 'value' as const, value: 'doing', label: 'Doing', count: 1 },
      ],
    }
    const props: ViewReaderComponentProps = {
      view: parsed.views[0]!,
      options: {},
      mode: 'current-reader',
      projection: {},
      manifest,
      loading: false,
      error: null,
      loadWindow,
      refresh: vi.fn(),
    }

    await act(async () => root.render(createElement(BoardView, props)))
    await act(async () => Promise.resolve())
    await act(async () =>
      root.render(
        createElement(BoardView, {
          ...props,
          manifest: { ...manifest, viewRef: 'view-ref-new' },
        }),
      ),
    )
    await act(async () => Promise.resolve())
    await act(async () => {
      freshWindow.resolve(response('view-ref-new', 'Fresh config'))
      await freshWindow.promise
    })
    expect(host.textContent).toContain('Fresh config')

    await act(async () => {
      oldWindow.resolve(response('view-ref-old', 'Stale config'))
      await oldWindow.promise
    })
    expect(host.textContent).toContain('Fresh config')
    expect(host.textContent).not.toContain('Stale config')
  })

  it('prunes disjoint config groups, aborts old work and moves only the current card instance', async () => {
    const oldWindow = deferred<Awaited<ReturnType<ViewReaderComponentProps['loadWindow']>>>()
    let oldSignal: AbortSignal | undefined
    const loadWindow = vi.fn(({ group, signal }) => {
      if (group === 'old-source') {
        oldSignal = signal
        return oldWindow.promise
      }

      return Promise.resolve({
        viewRef: 'view-ref-new',
        group,
        offset: 0,
        limit: 50,
        total: group === 'new-source' ? 1 : 0,
        snapshotGeneration: 'g2',
        rows:
          group === 'new-source'
            ? [{ id: 'task-a', title: 'Current Task A', filePath: 'work/a.md' }]
            : [],
        execution: { exactReads: 0, exactCacheHits: 0, exactRemaining: 0 },
      })
    })
    const boardMove = vi.spyOn(api, 'boardMove').mockResolvedValue({
      status: 'moved',
      cardVersionToken: 'card-v2',
      viewVersionToken: 'view-v3',
      rank: 'a1',
    })
    const oldManifest = {
      viewRef: 'view-ref-old',
      block: 0,
      occurrence: 0,
      name: 'Board',
      type: 'board',
      status: 'ready' as const,
      capabilities: { move: true as const },
      total: 1,
      snapshotGeneration: 'g1',
      groups: [
        {
          key: 'old-source',
          state: 'value' as const,
          value: 'old',
          label: 'Old',
          count: 1,
        },
      ],
    }
    const props: ViewReaderComponentProps = {
      view: parsed.views[0]!,
      options: {},
      mode: 'current-writer',
      projection: {},
      manifest: oldManifest,
      loading: false,
      error: null,
      loadWindow,
      refresh: vi.fn(),
    }

    await act(async () => root.render(createElement(BoardView, props)))
    await act(async () => Promise.resolve())
    expect(oldSignal?.aborted).toBe(false)

    const newManifest = {
      ...oldManifest,
      viewRef: 'view-ref-new',
      snapshotGeneration: 'g2',
      groups: [
        {
          key: 'new-source',
          state: 'value' as const,
          value: 'new',
          label: 'New',
          count: 1,
        },
        {
          key: 'new-destination',
          state: 'value' as const,
          value: 'done',
          label: 'Done',
          count: 0,
        },
      ],
    }

    await act(async () =>
      root.render(createElement(BoardView, { ...props, manifest: newManifest })),
    )
    await act(async () => Promise.resolve())
    expect(oldSignal?.aborted).toBe(true)
    expect(host.querySelectorAll('[data-note-id="task-a"]')).toHaveLength(1)
    expect(host.textContent).toContain('Current Task A')

    await act(async () => {
      oldWindow.resolve({
        viewRef: 'view-ref-old',
        group: 'old-source',
        offset: 0,
        limit: 50,
        total: 1,
        snapshotGeneration: 'g1',
        rows: [{ id: 'task-a', title: 'Old Task A', filePath: 'work/old-a.md' }],
        execution: { exactReads: 0, exactCacheHits: 0, exactRemaining: 0 },
      })
      await oldWindow.promise
    })
    const card = host.querySelector<HTMLElement>('[data-note-id="task-a"]')!
    const destination = host.querySelector<HTMLElement>('[data-group="new-destination"]')!
    const transfer = new FakeDataTransfer()

    await act(async () => {
      card.dispatchEvent(dragEvent('dragstart', transfer))
      destination.lastElementChild!.dispatchEvent(dragEvent('dragover', transfer))
      destination.lastElementChild!.dispatchEvent(dragEvent('drop', transfer))
      await Promise.resolve()
    })
    expect(host.querySelectorAll('[data-note-id="task-a"]')).toHaveLength(1)
    expect(
      host.querySelector('[data-group="new-destination"] [data-note-id="task-a"]'),
    ).not.toBeNull()
    expect(boardMove.mock.calls[0]?.[0].viewRef).toBe('view-ref-new')
  })

  it.each(['success', 'failure'] as const)(
    'makes an old boardMove %s inert after identity reset and immediately unlocks the new board',
    async (outcome) => {
      const oldMove = deferred<Awaited<ReturnType<typeof api.boardMove>>>()
      const boardMove = vi
        .spyOn(api, 'boardMove')
        .mockReturnValueOnce(oldMove.promise)
        .mockResolvedValueOnce({
          status: 'moved',
          cardVersionToken: 'new-card-v2',
          viewVersionToken: 'new-view-v2',
          rank: 'a1',
        })
      let loadCall = 0
      const loadWindow = vi.fn(async ({ group }) => {
        loadCall++
        const id = loadCall === 1 ? 'task-a' : 'task-b'

        return {
          viewRef: 'view-ref',
          group,
          offset: 0,
          limit: 50,
          total: group === 'backlog-key' ? 1 : 0,
          snapshotGeneration: 'g1',
          rows:
            group === 'backlog-key'
              ? [{ id, title: id === 'task-a' ? 'Task A' : 'Task B', filePath: `work/${id}.md` }]
              : [],
          execution: { exactReads: 0, exactCacheHits: 0, exactRemaining: 0 },
        }
      })
      const manifest = {
        viewRef: 'view-ref',
        block: 0,
        occurrence: 0,
        name: 'Board',
        type: 'board',
        status: 'ready' as const,
        capabilities: { move: true as const },
        total: 1,
        groups: [
          {
            key: 'backlog-key',
            state: 'value' as const,
            value: 'backlog',
            label: 'Backlog',
            count: 1,
          },
          { key: 'done-key', state: 'value' as const, value: 'done', label: 'Done', count: 0 },
        ],
      }
      const props: ViewReaderComponentProps = {
        view: parsed.views[0]!,
        options: {},
        mode: 'current-writer',
        projection: {},
        manifest,
        loading: false,
        error: null,
        loadWindow,
        refresh: vi.fn(),
      }

      const pointerMove = async (cardId: string) => {
        const card = host.querySelector<HTMLElement>(`[data-note-id="${cardId}"]`)!
        const destination = host.querySelector<HTMLElement>('[data-group="done-key"]')!
        const transfer = new FakeDataTransfer()

        await act(async () => {
          card.dispatchEvent(dragEvent('dragstart', transfer))
          destination.lastElementChild!.dispatchEvent(dragEvent('dragover', transfer))
          destination.lastElementChild!.dispatchEvent(dragEvent('drop', transfer))
          await Promise.resolve()
        })
      }

      await act(async () => root.render(createElement(BoardView, props)))
      await act(async () => Promise.resolve())
      await pointerMove('task-a')
      expect(host.querySelector('[data-note-id="task-a"]')?.getAttribute('aria-busy')).toBe('true')

      await act(async () =>
        root.render(
          createElement(BoardView, {
            ...props,
            view: { ...props.view, block: 1 },
            manifest: { ...manifest, block: 1 },
          }),
        ),
      )
      await act(async () => Promise.resolve())
      const newCard = host.querySelector<HTMLElement>('[data-note-id="task-b"]')!

      expect(newCard.getAttribute('aria-busy')).toBeNull()
      expect(newCard.getAttribute('draggable')).toBe('true')
      await pointerMove('task-b')
      expect(boardMove).toHaveBeenCalledTimes(2)
      expect(host.querySelector('[data-group="done-key"] [data-note-id="task-b"]')).not.toBeNull()

      await act(async () => {
        if (outcome === 'success') {
          oldMove.resolve({
            status: 'unchanged',
            cardVersionToken: 'old-card-v1',
            viewVersionToken: 'old-view-v1',
          })
          await oldMove.promise
        } else {
          oldMove.reject(new Error('old move failed'))
          await oldMove.promise.catch(() => undefined)
        }
      })
      expect(host.querySelector('[data-group="done-key"] [data-note-id="task-b"]')).not.toBeNull()
      expect(host.textContent).not.toContain('old move failed')
      expect(host.textContent).toContain('Card moved to Done.')
    },
  )

  it('invalidates a pending boardMove when the saved viewRef changes in place', async () => {
    const oldMove = deferred<Awaited<ReturnType<typeof api.boardMove>>>()
    const boardMove = vi
      .spyOn(api, 'boardMove')
      .mockReturnValueOnce(oldMove.promise)
      .mockResolvedValueOnce({
        status: 'moved',
        cardVersionToken: 'card-v2',
        viewVersionToken: 'view-v3',
        rank: 'a1',
      })
    const loadWindow = vi.fn(async ({ group }) => ({
      viewRef: 'view-ref',
      group,
      offset: 0,
      limit: 50,
      total: group === 'backlog-key' ? 1 : 0,
      snapshotGeneration: 'g1',
      rows:
        group === 'backlog-key' ? [{ id: 'task-a', title: 'Task A', filePath: 'work/a.md' }] : [],
      execution: { exactReads: 0, exactCacheHits: 0, exactRemaining: 0 },
    }))
    const manifest = {
      viewRef: 'view-ref-old',
      block: 0,
      occurrence: 0,
      name: 'Board',
      type: 'board',
      status: 'ready' as const,
      capabilities: { move: true as const },
      total: 1,
      snapshotGeneration: 'g1',
      groups: [
        {
          key: 'backlog-key',
          state: 'value' as const,
          value: 'backlog',
          label: 'Backlog',
          count: 1,
        },
        { key: 'done-key', state: 'value' as const, value: 'done', label: 'Done', count: 0 },
      ],
    }
    const props: ViewReaderComponentProps = {
      view: parsed.views[0]!,
      options: {},
      mode: 'current-writer',
      projection: {},
      manifest,
      loading: false,
      error: null,
      loadWindow,
      refresh: vi.fn(),
    }

    const pointerMove = async () => {
      const card = host.querySelector<HTMLElement>('[data-note-id="task-a"]')!
      const destination = host.querySelector<HTMLElement>('[data-group="done-key"]')!
      const transfer = new FakeDataTransfer()

      await act(async () => {
        card.dispatchEvent(dragEvent('dragstart', transfer))
        destination.lastElementChild!.dispatchEvent(dragEvent('dragover', transfer))
        destination.lastElementChild!.dispatchEvent(dragEvent('drop', transfer))
        await Promise.resolve()
      })
    }

    await act(async () => root.render(createElement(BoardView, props)))
    await act(async () => Promise.resolve())
    await pointerMove()
    expect(host.querySelector('[data-note-id="task-a"]')?.getAttribute('aria-busy')).toBe('true')

    await act(async () =>
      root.render(
        createElement(BoardView, {
          ...props,
          manifest: { ...manifest, viewRef: 'view-ref-new' },
        }),
      ),
    )
    await act(async () => Promise.resolve())
    expect(host.querySelector('[data-note-id="task-a"]')?.getAttribute('aria-busy')).toBeNull()
    await pointerMove()
    expect(boardMove).toHaveBeenCalledTimes(2)
    expect(boardMove.mock.calls[1]?.[0].viewRef).toBe('view-ref-new')

    await act(async () => {
      oldMove.resolve({
        status: 'unchanged',
        cardVersionToken: 'old-card-v1',
        viewVersionToken: 'old-view-v1',
      })
      await oldMove.promise
    })
    expect(host.querySelector('[data-group="done-key"] [data-note-id="task-a"]')).not.toBeNull()
    expect(host.textContent).toContain('Card moved to Done.')
  })

  it('caches column-local pointer geometry for the whole drag', async () => {
    const group = {
      key: 'doing-key',
      state: 'value' as const,
      value: 'doing',
      label: 'Doing',
      count: 3,
    }

    await act(async () =>
      root.render(
        createElement(BoardColumn, {
          group,
          rows: [
            { id: 'task-a', title: 'Task A', filePath: 'work/a.md' },
            { id: 'task-b', title: 'Task B', filePath: 'work/b.md' },
            { id: 'task-c', title: 'Task C', filePath: 'work/c.md' },
          ],
          total: 3,
          loading: false,
          error: null,
          writable: true,
          dropWritable: true,
          onMove: vi.fn(),
        }),
      ),
    )
    const first = host.querySelector<HTMLElement>('[data-note-id="task-a"]')!
    const second = host.querySelector<HTMLElement>('[data-note-id="task-b"]')!
    const third = host.querySelector<HTMLElement>('[data-note-id="task-c"]')!
    const list = first.parentElement!
    const query = vi.spyOn(list, 'querySelectorAll')
    const globalQuery = vi.spyOn(document, 'querySelectorAll')
    const firstRect = vi.fn(() => ({ height: 72 }) as DOMRect)
    const secondRect = vi.fn(() => ({ top: 0, height: 100 }) as DOMRect)
    const thirdRect = vi.fn(() => ({ top: 100, height: 100 }) as DOMRect)
    const transfer = new FakeDataTransfer()

    first.getBoundingClientRect = firstRect
    second.getBoundingClientRect = secondRect
    third.getBoundingClientRect = thirdRect
    await act(async () => first.dispatchEvent(dragEvent('dragstart', transfer)))
    for (const y of [75, 75, 75, 175, 175, 175]) {
      await act(async () => list.dispatchEvent(dragEvent('dragover', transfer, y)))
    }

    expect(query).toHaveBeenCalledTimes(1)
    expect(globalQuery).not.toHaveBeenCalled()
    expect(firstRect).toHaveBeenCalledTimes(1)
    expect(secondRect.mock.calls.length + thirdRect.mock.calls.length).toBe(2)
    expect(host.querySelectorAll('[data-testid="insertion-placeholder"]')).toHaveLength(1)
  })

  it('does not publish placement or move for the card current gap', async () => {
    const onMove = vi.fn()
    const group = {
      key: 'doing-key',
      state: 'value' as const,
      value: 'doing',
      label: 'Doing',
      count: 2,
    }

    const render = async (rows: Array<{ id: string; title: string; filePath: string }>) => {
      await act(async () =>
        root.render(
          createElement(BoardColumn, {
            group: { ...group, count: rows.length },
            rows,
            total: rows.length,
            loading: false,
            error: null,
            writable: true,
            dropWritable: true,
            onMove,
          }),
        ),
      )
    }

    await render([
      { id: 'task-a', title: 'Task A', filePath: 'work/a.md' },
      { id: 'task-b', title: 'Task B', filePath: 'work/b.md' },
    ])
    let card = host.querySelector<HTMLElement>('[data-note-id="task-a"]')!
    let list = card.parentElement!
    let transfer = new FakeDataTransfer()

    host.querySelector<HTMLElement>('[data-note-id="task-b"]')!.getBoundingClientRect = () =>
      ({ top: 100, height: 100 }) as unknown as DOMRect
    await act(async () => {
      card.dispatchEvent(dragEvent('dragstart', transfer))
      card.dispatchEvent(dragEvent('dragover', transfer, 0))
    })
    expect(host.querySelector('[data-testid="insertion-placeholder"]')).toBeNull()
    await act(async () => {
      list.dispatchEvent(dragEvent('drop', transfer))
    })
    expect(onMove).not.toHaveBeenCalled()

    await render([{ id: 'task-a', title: 'Task A', filePath: 'work/a.md' }])
    card = host.querySelector<HTMLElement>('[data-note-id="task-a"]')!
    list = card.parentElement!
    transfer = new FakeDataTransfer()
    await act(async () => {
      card.dispatchEvent(dragEvent('dragstart', transfer))
      list.dispatchEvent(dragEvent('dragover', transfer))
    })
    expect(host.querySelector('[data-testid="insertion-placeholder"]')).toBeNull()
    await act(async () => {
      list.dispatchEvent(dragEvent('drop', transfer))
    })
    expect(onMove).not.toHaveBeenCalled()
  })

  it('refuses a multi-note tree payload instead of partially moving it', async () => {
    const onMove = vi.fn()
    const group = {
      key: 'doing-key',
      state: 'value' as const,
      value: 'doing',
      label: 'Doing',
      count: 1,
    }

    await act(async () =>
      root.render(
        createElement(BoardColumn, {
          group,
          rows: [{ id: 'task-a', title: 'Task A', filePath: 'work/a.md' }],
          total: 1,
          loading: false,
          error: null,
          writable: true,
          dropWritable: true,
          onMove,
        }),
      ),
    )
    const transfer = new FakeDataTransfer()

    startDrag({ dataTransfer: transfer } as never, [
      { kind: 'note', id: 'task-a', fileName: 'a.md', srcFolder: 'work' },
      { kind: 'note', id: 'task-b', fileName: 'b.md', srcFolder: 'work' },
    ])
    const list = host.querySelector<HTMLElement>('[data-note-id="task-a"]')!.parentElement!

    await act(async () => {
      list.dispatchEvent(dragEvent('dragover', transfer))
      list.dispatchEvent(dragEvent('drop', transfer))
    })

    expect(transfer.dropEffect).toBe('none')
    expect(onMove).not.toHaveBeenCalled()
  })
})
