// @vitest-environment jsdom

import { act, createElement, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { BoardCard } from './BoardCard'

const renderProbe = vi.hoisted(() => vi.fn())

vi.mock('../../core/CardLink', () => ({
  CardLink: ({ children }: { children?: ReactNode }) => {
    renderProbe()
    return children ?? null
  },
}))

describe('BoardCard memo boundary', () => {
  let host: HTMLDivElement

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    renderProbe.mockClear()
    host = document.createElement('div')
    document.body.append(host)
  })

  afterEach(() => host.remove())

  it('does not rerender card content when a parent placement update keeps card props stable', async () => {
    const root = createRoot(host)
    const row = { id: 'task-a', title: 'Task A', filePath: 'work/a.md' }
    const onKeyboardCommand = vi.fn()
    const props = {
      row,
      writable: true,
      busy: false,
      keyboardMoving: false,
      keyboardMode: false,
      onKeyboardCommand,
    }

    await act(async () => root.render(createElement(BoardCard, props)))
    expect(renderProbe).toHaveBeenCalledTimes(1)

    await act(async () => root.render(createElement(BoardCard, props)))
    expect(renderProbe).toHaveBeenCalledTimes(1)

    await act(async () => root.render(createElement(BoardCard, { ...props, keyboardMoving: true })))
    expect(renderProbe).toHaveBeenCalledTimes(2)
    await act(async () => root.unmount())
  })
})
