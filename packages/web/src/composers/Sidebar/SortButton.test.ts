// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SortButton } from './SortButton'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('SortButton accessibility', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('opens two named radio groups and moves focus with arrow keys', async () => {
    await act(async () =>
      root.render(
        createElement(SortButton, {
          sort: 'title',
          dir: 'asc',
          onSort: vi.fn(),
          onDir: vi.fn(),
        }),
      ),
    )
    const trigger = container.querySelector<HTMLButtonElement>('[data-testid="explorer-sort"]')!

    await act(async () => trigger.click())
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu')
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(document.querySelector('[role="group"][aria-label="Sort field"]')).not.toBeNull()
    expect(document.querySelector('[role="group"][aria-label="Sort direction"]')).not.toBeNull()

    const name = document.querySelector<HTMLButtonElement>('[role="menuitemradio"]')!
    expect(document.activeElement).toBe(name)
    await act(async () =>
      name.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })),
    )
    expect((document.activeElement as HTMLElement).textContent).toContain('Modified')
  })
})
