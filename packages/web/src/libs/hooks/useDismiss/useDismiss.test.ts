// @vitest-environment jsdom

import { act, createElement, type ReactNode, StrictMode, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Modal } from '../../../core/Modal'
import { useDismiss } from './useDismiss'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const Popover = ({ onDismiss }: { onDismiss: () => void }) => {
  const ref = useRef<HTMLDivElement>(null)

  useDismiss(true, onDismiss, { inside: [ref] })

  return createElement('div', { ref, 'data-testid': 'popover' }, 'menu')
}

/** Everything the page can hear Escape with, below the surfaces that arbitrate it:
 *  the editor's Cancel hotkey, the tree's clear-selection, an inline field. */
const pageEscape = vi.fn()

const escape = () =>
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

describe('useDismiss and the shared Escape arbiter', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    pageEscape.mockReset()
    window.addEventListener('keydown', pageEscape)
  })

  afterEach(async () => {
    window.removeEventListener('keydown', pageEscape)
    await act(async () => root.unmount())
    container.remove()
  })

  // Under StrictMode, as the app runs: every layer is opened, closed and re-opened
  // on mount, so the order has to survive that and not just a single pass.
  const render = (children: ReactNode) =>
    act(async () => root.render(createElement(StrictMode, null, children)))

  it('hands Escape to a dialog opened over an already-open popover', async () => {
    const onDismiss = vi.fn()
    const onClose = vi.fn()

    await render(createElement(Popover, { onDismiss }))
    // The dialog opens while the popover is still mounted behind it — a dropdown is
    // not unmounted by ⌘K raising Spotlight over it.
    await render([
      createElement(Popover, { key: 'popover', onDismiss }),
      createElement(Modal, { key: 'modal', onClose }, 'dialog'),
    ])

    await act(async () => {
      escape()
    })

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onDismiss).not.toHaveBeenCalled()
  })

  it('hands Escape back to the popover once the dialog is gone', async () => {
    const onDismiss = vi.fn()
    const onClose = vi.fn()

    await render([
      createElement(Popover, { key: 'popover', onDismiss }),
      createElement(Modal, { key: 'modal', onClose }, 'dialog'),
    ])
    await render(createElement(Popover, { onDismiss }))

    await act(async () => {
      escape()
    })

    expect(onDismiss).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()
  })

  // The arbitration decides who ACTS. A popover that also stopped the key silenced
  // the editor's Cancel, the tree's clear-selection and every inline field at once.
  it('lets the page keep hearing Escape while a popover answers it', async () => {
    const onDismiss = vi.fn()

    await render(createElement(Popover, { onDismiss }))

    await act(async () => {
      escape()
    })

    expect(onDismiss).toHaveBeenCalledTimes(1)
    expect(pageEscape).toHaveBeenCalledTimes(1)
  })
})
