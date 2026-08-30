// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'

import { ChipInput } from './ChipInput'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('ChipInput field semantics', () => {
  it('clears local text with the whole-field action and names each item by field', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    const onChange = vi.fn()
    const onClear = vi.fn()

    await act(async () => {
      root.render(
        createElement(ChipInput, {
          values: ['ann'],
          onChange,
          onClear,
          clearLabel: 'Remove Reviewers',
          removeAriaLabel: (value: string) => `Remove ${value} from Reviewers`,
        }),
      )
    })
    const input = container.querySelector('input') as HTMLInputElement
    await act(async () => {
      input.focus()
      input.value = 'bob'
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(container.querySelector('button[aria-label="Remove ann from Reviewers"]')).not.toBeNull()
    await act(async () => {
      ;(
        container.querySelector('button[aria-label="Remove Reviewers"]') as HTMLButtonElement
      ).click()
      input.blur()
    })

    expect(onClear).toHaveBeenCalledOnce()
    expect(onChange).not.toHaveBeenCalled()
    await act(async () => root.unmount())
    container.remove()
  })

  it('blocks item removal and exposes the quiet empty placeholder at rest when disabled', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    const onChange = vi.fn()

    await act(async () => {
      root.render(createElement(ChipInput, { values: ['ann'], onChange, disabled: true }))
    })
    expect(
      (container.querySelector('button[aria-label="Remove ann"]') as HTMLButtonElement).disabled,
    ).toBe(true)

    await act(async () => {
      root.render(
        createElement(ChipInput, {
          values: [],
          onChange,
          appearance: 'quiet',
          placeholder: '—',
        }),
      )
    })
    const shell = container.querySelector('[data-empty="true"]')
    expect(shell).not.toBeNull()
    expect(container.querySelector('input')?.placeholder).toBe('—')
    await act(async () => root.unmount())
    container.remove()
  })

  it('reports normalized pending text before blur so a parent draft can own it', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    const onPendingChange = vi.fn()

    await act(async () => {
      root.render(
        createElement(ChipInput, {
          values: [],
          onChange: vi.fn(),
          onPendingChange,
        }),
      )
    })
    const input = container.querySelector('input') as HTMLInputElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        input,
        '  alpha  ',
      )
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(onPendingChange).toHaveBeenLastCalledWith('alpha')

    await act(async () => root.unmount())
    container.remove()
  })

  it('can preserve commas and edge spaces for exact custom-list values', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    const onChange = vi.fn()

    await act(async () => {
      root.render(
        createElement(ChipInput, {
          values: [],
          onChange,
          commitOnComma: false,
          trimValues: false,
        }),
      )
    })
    const input = container.querySelector('input') as HTMLInputElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        input,
        ' Doe, Jane ',
      )
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: ',', bubbles: true, cancelable: true }),
      )
    })
    expect(onChange).not.toHaveBeenCalled()
    await act(async () => {
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      )
    })
    expect(onChange).toHaveBeenCalledWith([' Doe, Jane '])
    await act(async () => root.unmount())
    container.remove()
  })
})
