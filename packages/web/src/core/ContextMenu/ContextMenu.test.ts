// @vitest-environment jsdom

import { act, createElement, Fragment, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ContextMenu } from './ContextMenu'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const Harness = () => {
  const trigger = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)

  return createElement(
    Fragment,
    null,
    createElement(
      'button',
      {
        ref: trigger,
        'aria-haspopup': 'menu',
        'aria-expanded': open,
        onClick: () => setOpen((current) => !current),
      },
      'Open',
    ),
    open &&
      createElement(ContextMenu, {
        x: 0,
        y: 0,
        ignoreRef: trigger,
        items: [
          { label: 'First' },
          { label: 'Last' },
          { label: 'Compact', radioGroup: 'Density', active: true },
          { label: 'Comfortable', radioGroup: 'Density', active: false },
        ],
        onClose: () => setOpen(false),
      }),
    createElement('button', { 'data-testid': 'after-trigger' }, 'After'),
  )
}

describe('ContextMenu keyboard focus lifecycle', () => {
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

  const openMenu = async () => {
    const trigger = container.querySelector<HTMLButtonElement>('button')!
    trigger.focus()
    await act(async () => trigger.click())
    const first = document.querySelector<HTMLButtonElement>('[role="menuitem"]')!

    expect(document.activeElement).toBe(first)
    return { trigger, first }
  }

  const flushFocusFrame = async () => {
    await act(
      async () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => resolve())
        }),
    )
  }

  it('returns focus to the trigger when Escape closes the menu', async () => {
    await act(async () => root.render(createElement(Harness)))
    const { trigger, first } = await openMenu()

    await act(async () =>
      first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    )
    await flushFocusFrame()

    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(trigger)
  })

  it('moves focus to the next page control when Tab closes the menu', async () => {
    await act(async () => root.render(createElement(Harness)))
    const { trigger, first } = await openMenu()
    const after = container.querySelector<HTMLButtonElement>('[data-testid="after-trigger"]')!
    const visibleRect = [new DOMRect()] as unknown as DOMRectList

    trigger.getClientRects = () => visibleRect
    after.getClientRects = () => visibleRect
    const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })

    let dispatched = false

    await act(async () => {
      dispatched = first.dispatchEvent(event)
    })
    await flushFocusFrame()

    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(dispatched).toBe(false)
    expect(document.activeElement).toBe(after)
  })

  it('returns focus to the trigger after a keyboard-activated action closes the menu', async () => {
    await act(async () => root.render(createElement(Harness)))
    const { trigger, first } = await openMenu()

    await act(async () =>
      first.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 })),
    )
    await flushFocusFrame()

    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(trigger)
  })

  it('reserves radio semantics for named single-select groups', async () => {
    await act(async () => root.render(createElement(Harness)))
    const { first } = await openMenu()
    const group = document.querySelector('[role="group"][aria-label="Density"]')!
    const radios = group.querySelectorAll('[role="menuitemradio"]')

    expect(first.hasAttribute('aria-checked')).toBe(false)
    expect(radios).toHaveLength(2)
    expect(radios[0]?.getAttribute('aria-checked')).toBe('true')
    expect(radios[1]?.getAttribute('aria-checked')).toBe('false')
  })
})
