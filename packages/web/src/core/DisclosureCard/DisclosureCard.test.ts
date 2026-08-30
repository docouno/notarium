// @vitest-environment jsdom

import { act, createElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { useReorder } from '../../libs/dnd/reorder'
import { IconGrip } from '../Icons'
import { DisclosureCard } from './DisclosureCard'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ReorderHarness = () => {
  const [keys, setKeys] = useState(['alpha', 'beta', 'gamma'])
  const { handleFor, listProps } = useReorder(keys, setKeys)

  return createElement(
    'div',
    { 'data-testid': 'list', ...listProps },
    keys.map((key) =>
      createElement(DisclosureCard, {
        key,
        header: key,
        defaultOpen: true,
        reorder: handleFor(key),
        grip: createElement(IconGrip, { size: 14 }),
        testId: `row-${key}`,
        children: createElement('input', { 'aria-label': `Value for ${key}` }),
      }),
    ),
  )
}

describe('DisclosureCard reorder binding', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(async () => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root.render(createElement(ReorderHarness)))
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('moves the focused row with ArrowDown through the shared handle', async () => {
    const first = container.querySelector<HTMLElement>('[data-testid="row-alpha"]')
    const grip = first?.querySelector<HTMLElement>('[role="button"][aria-label="Reorder item"]')
    const input = first?.querySelector<HTMLInputElement>('input')

    expect(grip).not.toBeNull()
    expect(grip?.tabIndex).toBe(0)

    await act(async () => {
      input?.focus()
      input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    })
    expect(
      [...container.querySelectorAll<HTMLElement>('[data-testid^="row-"]')].map(
        (row) => row.dataset.testid,
      ),
    ).toEqual(['row-alpha', 'row-beta', 'row-gamma'])

    await act(async () => {
      grip?.focus()
      grip?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    })

    expect(
      [...container.querySelectorAll<HTMLElement>('[data-testid^="row-"]')].map(
        (row) => row.dataset.testid,
      ),
    ).toEqual(['row-beta', 'row-alpha', 'row-gamma'])
  })
})
