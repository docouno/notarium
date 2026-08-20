/** ONE arbiter for the keyboard of stacked surfaces. Every dismissible answers
 *  Escape — a modal dialog, the narrow drawer, a popover, a context menu — so with
 *  two of them open both answer one key. A surface that keeps its own order is a
 *  second stack that agrees with neither: mount order and DOM order part company as
 *  soon as a popover (never portalled, never `aria-modal`) sits over a dialog, and
 *  the surface each stack cannot see is exactly the one it wrongly answers for.
 *
 *  So the order is kept in ONE place and every surface opens a layer here: Escape
 *  belongs to the layer opened LAST, whatever kind it is. The focus trap is a
 *  different question with a different answer — a popover over a dialog takes the
 *  key but must not take the dialog's Tab containment — so it goes to the last MODAL
 *  layer instead.
 *
 *  The key is dispatched by ONE listener owned here rather than by each surface,
 *  because "who happened to bind first" is precisely the ordering this replaces. It
 *  listens on window in BUBBLE, the last stop of the path: every element- and
 *  document-level handler has already seen the key, so arbitrating who ACTS costs
 *  nobody the chance to HEAR — a capture-phase listener that stops the event would
 *  silence the editor's Cancel, the tree's clear-selection and every inline field at
 *  once, for a decision that concerns only the surfaces stacked here. */

export const KEYBOARD_LAYER = { modal: 'modal', transient: 'transient' } as const
export type KeyboardLayer = (typeof KEYBOARD_LAYER)[keyof typeof KEYBOARD_LAYER]

export type KeyboardLayerHandle = { readonly kind: KeyboardLayer }

type OpenLayer = KeyboardLayerHandle & { readonly escape: () => void }

/** Escape belongs to the last surface opened, modal or not. */
export const escapeOwner = <T extends KeyboardLayerHandle>(layers: readonly T[]): T | null =>
  layers.at(-1) ?? null

/** Tab containment belongs to the last MODAL surface, even with a popover over it. */
export const modalFocusOwner = <T extends KeyboardLayerHandle>(layers: readonly T[]): T | null =>
  layers.reduce<T | null>(
    (found, layer) => (layer.kind === KEYBOARD_LAYER.modal ? layer : found),
    null,
  )

const open: OpenLayer[] = []
let listening = false

const onKeyDown = (event: KeyboardEvent) => {
  if (event.key !== 'Escape') {
    return
  }
  const owner = escapeOwner(open)

  if (!owner) {
    return
  }
  event.preventDefault()
  owner.escape()
}

/** Declare a surface open. The returned handle is its identity in the order — pass
 *  it back to `closeKeyboardLayer` when the surface goes away. */
export const openKeyboardLayer = (kind: KeyboardLayer, escape: () => void): KeyboardLayerHandle => {
  const layer: OpenLayer = { kind, escape }

  open.push(layer)
  if (!listening) {
    window.addEventListener('keydown', onKeyDown)
    listening = true
  }

  return layer
}

export const closeKeyboardLayer = (handle: KeyboardLayerHandle | null): void => {
  const index = open.indexOf(handle as OpenLayer)

  if (index >= 0) {
    open.splice(index, 1)
  }
  if (listening && open.length === 0) {
    window.removeEventListener('keydown', onKeyDown)
    listening = false
  }
}

/** Whether `handle` still holds the focus trap, read off the live order. */
export const ownsModalFocus = (handle: KeyboardLayerHandle | null): boolean =>
  handle != null && modalFocusOwner(open) === handle
