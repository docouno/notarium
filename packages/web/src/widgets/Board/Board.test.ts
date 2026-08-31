// @vitest-environment jsdom

import { act, createElement, Fragment } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { currentDragItems, endDrag } from '../../libs/dnd/dnd'
import { Board } from './Board'
import { BoardColumn } from './BoardColumn'

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

describe('Board document drag owner', () => {
  let host: HTMLDivElement

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    host = document.createElement('div')
    document.body.append(host)
  })

  afterEach(() => {
    endDrag()
    host.remove()
    vi.restoreAllMocks()
  })

  it('keeps the remaining board dragend cleanup after another board unmounts', async () => {
    const root = createRoot(host)
    const rows = [
      { id: 'task-a', title: 'Task A', filePath: 'work/a.md' },
      { id: 'task-b', title: 'Task B', filePath: 'work/b.md' },
    ]

    const renderBoard = (key: string, groupKey: string, withCards: boolean) => {
      const group = {
        key: groupKey,
        state: 'value' as const,
        value: groupKey,
        label: groupKey,
        count: withCards ? rows.length : 0,
      }

      return createElement(Board, {
        key,
        groups: [group],
        onVisible: vi.fn(),
        renderColumn: (candidate, ref) =>
          createElement(BoardColumn, {
            key: candidate.key,
            group: candidate,
            rows: withCards ? rows : [],
            total: withCards ? rows.length : 0,
            loading: false,
            error: null,
            hostRef: ref,
            writable: true,
            dropWritable: true,
            onMove: vi.fn(),
          }),
      })
    }

    const render = async (first: boolean) => {
      await act(async () =>
        root.render(
          createElement(
            Fragment,
            null,
            first ? renderBoard('first', 'first-group', false) : null,
            renderBoard('second', 'second-group', true),
          ),
        ),
      )
    }

    await render(true)
    const firstCard = host.querySelector<HTMLElement>('[data-note-id="task-a"]')!
    const secondCard = host.querySelector<HTMLElement>('[data-note-id="task-b"]')!
    const list = firstCard.parentElement!
    const transfer = new FakeDataTransfer()

    firstCard.getBoundingClientRect = () => ({ height: 72 }) as DOMRect
    secondCard.getBoundingClientRect = () => ({ top: 0, height: 100 }) as DOMRect
    await act(async () => {
      firstCard.dispatchEvent(dragEvent('dragstart', transfer))
      list.dispatchEvent(dragEvent('dragover', transfer, 90))
    })
    expect(host.querySelectorAll('[data-testid="insertion-placeholder"]')).toHaveLength(1)
    expect(currentDragItems()).toHaveLength(1)

    await render(false)
    expect(host.querySelectorAll('[data-testid="insertion-placeholder"]')).toHaveLength(1)
    await act(async () => document.dispatchEvent(new Event('dragend', { bubbles: true })))

    expect(host.querySelectorAll('[data-testid="insertion-placeholder"]')).toHaveLength(0)
    expect(currentDragItems()).toHaveLength(0)
    await act(async () => root.unmount())
  })
})
