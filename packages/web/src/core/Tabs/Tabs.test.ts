// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Tabs } from './Tabs'

describe('Tabs', () => {
  let host: HTMLDivElement
  let root: Root

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    host.remove()
  })

  it('publishes one selected tab and activates clicks', async () => {
    const onChange = vi.fn()

    await act(async () =>
      root.render(
        createElement(Tabs, {
          value: 'tasks',
          options: [
            { value: 'tasks', label: 'Tasks' },
            { value: 'later', label: 'Later' },
          ],
          onChange,
          ariaLabel: 'Views',
          panelId: 'panel',
        }),
      ),
    )
    const tabs = host.querySelectorAll('[role="tab"]')

    expect(tabs[0]?.getAttribute('aria-selected')).toBe('true')
    expect(tabs[0]?.getAttribute('aria-controls')).toBe('panel')
    await act(async () => (tabs[1] as HTMLButtonElement).click())
    expect(onChange).toHaveBeenCalledWith('later')
  })

  it('wraps arrow navigation across enabled tabs', async () => {
    const onChange = vi.fn()

    await act(async () =>
      root.render(
        createElement(Tabs, {
          value: 'tasks',
          options: [
            { value: 'tasks', label: 'Tasks' },
            { value: 'blocked', label: 'Blocked', disabled: true },
            { value: 'later', label: 'Later' },
          ],
          onChange,
          ariaLabel: 'Views',
        }),
      ),
    )
    const active = host.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')!

    await act(async () =>
      active.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })),
    )
    expect(onChange).toHaveBeenCalledWith('later')
  })
})
