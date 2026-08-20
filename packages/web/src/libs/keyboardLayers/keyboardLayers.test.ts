import { describe, expect, it } from 'vitest'
import { escapeOwner, KEYBOARD_LAYER, modalFocusOwner } from './keyboardLayers'

const modal = (name: string) => ({ name, kind: KEYBOARD_LAYER.modal }) as const
const transient = (name: string) => ({ name, kind: KEYBOARD_LAYER.transient }) as const

describe('keyboard layer arbitration', () => {
  it('gives Escape to the last surface opened, whatever kind it is', () => {
    const drawer = modal('drawer')
    const dialog = modal('dialog')

    expect(escapeOwner([drawer, dialog])).toBe(dialog)
    expect(escapeOwner([dialog, drawer])).toBe(drawer)
  })

  // The hole a modals-only arbiter cannot see: a popover is neither portalled nor
  // aria-modal, so ordering read off modal dialogs alone leaves it out of the answer.
  it('gives Escape to a popover opened over a dialog', () => {
    const dialog = modal('dialog')
    const popover = transient('popover')

    expect(escapeOwner([dialog, popover])).toBe(popover)
  })

  // The other half of the same hole, and the one the Feed scenario hits: a popover
  // left open BEHIND a dialog must not answer the dialog's key.
  it('gives Escape to a dialog opened over a popover already open', () => {
    const popover = transient('popover')
    const dialog = modal('dialog')

    expect(escapeOwner([popover, dialog])).toBe(dialog)
  })

  it('keeps the focus trap with the last dialog even while a popover owns Escape', () => {
    const drawer = modal('drawer')
    const dialog = modal('dialog')
    const popover = transient('popover')

    expect(modalFocusOwner([drawer, dialog, popover])).toBe(dialog)
    expect(modalFocusOwner([drawer, popover])).toBe(drawer)
  })

  it('has no owner with nothing open, and no focus owner with only popovers', () => {
    expect(escapeOwner([])).toBeNull()
    expect(modalFocusOwner([transient('popover')])).toBeNull()
  })
})
