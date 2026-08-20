import { useCallback, useEffect, useRef } from 'react'
import {
  closeKeyboardLayer,
  type KeyboardLayer,
  type KeyboardLayerHandle,
  openKeyboardLayer,
  ownsModalFocus,
} from '../../keyboardLayers'

/** Declare this surface open while `active`, and hand it its Escape. The shared
 *  arbiter calls `onEscape` only while this is the TOPMOST layer, so a surface can
 *  no longer answer a key that belongs to the dialog over it — and no longer has to
 *  bind a listener of its own to find that out.
 *
 *  Returns the OTHER question a modal surface asks: whether its Tab containment is
 *  still the live one. Read it at key time, never at render — the answer changes
 *  when a neighbour opens, which is not a render of this one. */
export const useKeyboardLayer = (
  active: boolean,
  kind: KeyboardLayer,
  onEscape?: () => void,
): (() => boolean) => {
  // The handler is read through a ref so a surface whose close callback is minted
  // per render doesn't re-open its layer — re-opening would move it to the top of
  // the order on every parent render.
  const escapeRef = useRef(onEscape)
  escapeRef.current = onEscape
  const handle = useRef<KeyboardLayerHandle | null>(null)

  useEffect(() => {
    if (!active) {
      return undefined
    }
    const opened = openKeyboardLayer(kind, () => escapeRef.current?.())

    handle.current = opened

    return () => {
      handle.current = null
      closeKeyboardLayer(opened)
    }
  }, [active, kind])

  return useCallback(() => ownsModalFocus(handle.current), [])
}
