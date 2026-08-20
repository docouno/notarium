import { type RefObject, useEffect } from 'react'
import { useKeyboardLayer } from '../../../../libs/hooks/useKeyboardLayer'
import { KEYBOARD_LAYER } from '../../../../libs/keyboardLayers'

/** The narrow explorer drawer's keyboard. The drawer declares itself a modal dialog
 *  (it holds the page behind it inert), so it takes the focus with it, contains Tab
 *  and closes on Escape — but it is not the only surface that does, and a confirm
 *  dialog raised FROM it sits over it. Escape therefore comes from the shared
 *  arbiter, which gives it to the topmost surface alone: a drawer that answered on
 *  its own closed itself along with the dialog it opened, in one key. */
export const useDrawerKeyboard = (
  active: boolean,
  panelRef: RefObject<HTMLElement | null>,
  onClose: () => void,
): void => {
  const ownsFocus = useKeyboardLayer(active, KEYBOARD_LAYER.modal, onClose)

  useEffect(() => {
    if (!active) {
      return undefined
    }
    const panel = panelRef.current
    const focusFrame = requestAnimationFrame(() => {
      panel?.querySelector<HTMLElement>('button, a[href], [tabindex="0"]')?.focus()
    })

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || !panel || !ownsFocus()) {
        return
      }
      const focusable = [
        ...panel.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), [tabindex]'),
      ].filter((element) => element.tabIndex >= 0)

      if (!focusable.length) {
        return
      }
      const first = focusable[0]!
      const last = focusable.at(-1)!

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => {
      cancelAnimationFrame(focusFrame)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [active, ownsFocus, panelRef])
}
