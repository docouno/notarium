// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'

import { DatePicker } from './DatePicker'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('DatePicker clear action', () => {
  it('uses a keyboard-reachable button outside the calendar trigger', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    const onChange = vi.fn()
    const onClear = vi.fn()

    await act(async () => {
      root.render(
        createElement(DatePicker, {
          value: '2026-08-24',
          onChange,
          onClear,
          'aria-label': 'Due value',
        }),
      )
    })
    const trigger = container.querySelector('button[aria-haspopup="dialog"]')!
    const clear = container.querySelector('button[aria-label="Clear Due value"]')

    expect(clear).not.toBeNull()
    expect(trigger.contains(clear)).toBe(false)
    await act(async () => (clear as HTMLButtonElement).click())
    expect(onClear).toHaveBeenCalledOnce()
    expect(onChange).not.toHaveBeenCalled()
    await act(async () => root.unmount())
    container.remove()
  })

  it('renders removal only when the consumer provides the capability', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)

    await act(async () => {
      root.render(
        createElement(DatePicker, {
          value: '2026-08-24',
          onChange: () => undefined,
          'aria-label': 'Created',
        }),
      )
    })
    expect(container.querySelector('button[aria-label="Clear Created"]')).toBeNull()

    await act(async () => {
      root.render(
        createElement(DatePicker, {
          value: '',
          onChange: () => undefined,
          onClear: () => undefined,
          'aria-label': 'Due value',
        }),
      )
    })
    expect(container.querySelector('button[aria-label="Clear Due value"]')).not.toBeNull()
    await act(async () => root.unmount())
    container.remove()
  })

  it('does not let calendar keyboard handling hijack its navigation buttons', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    const onChange = vi.fn()

    await act(async () => {
      root.render(createElement(DatePicker, { value: '2026-08-24', onChange }))
    })
    const trigger = container.querySelector('button[aria-haspopup="dialog"]') as HTMLButtonElement
    await act(async () => trigger.click())
    const next = document.body.querySelector('button[aria-label="Next"]') as HTMLButtonElement

    next.focus()
    await act(async () => {
      next.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      )
    })
    expect(onChange).not.toHaveBeenCalled()
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull()

    await act(async () => next.click())
    expect(onChange).not.toHaveBeenCalled()
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull()
    await act(async () => root.unmount())
    container.remove()
  })

  it('keeps DOM focus on the roving day and restores it after pick and Escape', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    const onChange = vi.fn()

    await act(async () => {
      root.render(createElement(DatePicker, { value: '2026-08-24', onChange }))
    })
    const trigger = container.querySelector('button[aria-haspopup="dialog"]') as HTMLButtonElement
    await act(async () => trigger.click())
    const activeDay = document.activeElement as HTMLButtonElement

    expect(activeDay.tagName).toBe('BUTTON')
    expect(activeDay.dataset.calendarDay).toBe('2026-08-24')
    expect(activeDay.getAttribute('aria-label')).toContain('Aug')
    await act(async () => activeDay.click())
    await act(async () => Promise.resolve())
    expect(document.activeElement).toBe(trigger)

    await act(async () => trigger.click())
    const reopenedDay = document.activeElement as HTMLButtonElement
    await act(async () => {
      reopenedDay.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      )
    })
    await act(async () => Promise.resolve())
    expect(document.activeElement).toBe(trigger)
    await act(async () => root.unmount())
    container.remove()
  })

  it('moves focus through year/month panels and lets Escape close from either panel', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)

    await act(async () => {
      root.render(createElement(DatePicker, { value: '2026-08-24', onChange: vi.fn() }))
    })
    const trigger = container.querySelector('button[aria-haspopup="dialog"]') as HTMLButtonElement
    await act(async () => trigger.click())
    const switchView = () =>
      document.body.querySelector('button[aria-label="Switch view"]') as HTMLButtonElement

    await act(async () => switchView().click())
    expect((document.activeElement as HTMLElement).dataset.calendarMonth).toBe('7')
    await act(async () => switchView().click())
    const focusedYear = document.activeElement as HTMLButtonElement
    expect(focusedYear.dataset.calendarYear).toBe('2026')
    await act(async () => focusedYear.click())
    expect((document.activeElement as HTMLElement).dataset.calendarMonth).toBe('7')

    await act(async () => {
      ;(document.activeElement as HTMLElement).dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      )
    })
    await act(async () => Promise.resolve())
    expect(document.activeElement).toBe(trigger)
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()

    await act(async () => trigger.click())
    await act(async () => switchView().click())
    await act(async () => {
      ;(document.activeElement as HTMLElement).dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      )
    })
    await act(async () => Promise.resolve())
    expect(document.activeElement).toBe(trigger)
    await act(async () => root.unmount())
    container.remove()
  })

  it('keeps Tab focus inside the open calendar dialog', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)

    await act(async () => {
      root.render(createElement(DatePicker, { value: '2026-08-24', onChange: vi.fn() }))
    })
    const trigger = container.querySelector('button[aria-haspopup="dialog"]') as HTMLButtonElement
    await act(async () => trigger.click())
    const today = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'Today',
    )!

    today.focus()
    await act(async () => {
      today.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }),
      )
    })
    expect(document.body.querySelector('[role="dialog"]')?.contains(document.activeElement)).toBe(
      true,
    )
    await act(async () => root.unmount())
    container.remove()
  })
})
