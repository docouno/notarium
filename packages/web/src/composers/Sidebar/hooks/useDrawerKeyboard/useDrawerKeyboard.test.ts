// @vitest-environment jsdom

import { act, createElement, type ReactNode, StrictMode, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Modal } from '../../../../core/Modal'
import { useDrawerKeyboard } from './useDrawerKeyboard'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const Drawer = ({ onClose }: { onClose: () => void }) => {
  const panelRef = useRef<HTMLDivElement>(null)

  useDrawerKeyboard(true, panelRef, onClose)

  return createElement(
    'div',
    { ref: panelRef, role: 'dialog', 'aria-modal': true, 'aria-label': 'Explorer' },
    createElement('button', { type: 'button' }, 'Note'),
  )
}

const escape = () =>
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

describe('the narrow explorer drawer and the shared Escape arbiter', () => {
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

  // Under StrictMode, as the app runs: every layer is opened, closed and re-opened
  // on mount, so the order has to survive that and not just a single pass.
  const render = (children: ReactNode) =>
    act(async () => root.render(createElement(StrictMode, null, children)))

  // Right-click a note in the drawer's tree → Delete → the confirm dialog opens OVER
  // the drawer. One Escape must dismiss the dialog and leave the drawer where it is.
  it('leaves Escape to a confirm dialog raised over the drawer', async () => {
    const onClose = vi.fn()
    const onConfirmClose = vi.fn()

    await render(createElement(Drawer, { onClose }))
    await render([
      createElement(Drawer, { key: 'drawer', onClose }),
      createElement(Modal, { key: 'confirm', onClose: onConfirmClose }, 'Delete?'),
    ])

    await act(async () => {
      escape()
    })

    expect(onConfirmClose).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('closes the drawer on Escape once nothing is stacked over it', async () => {
    const onClose = vi.fn()

    await render(createElement(Drawer, { onClose }))

    await act(async () => {
      escape()
    })

    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
