import { type ReactNode, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { cx } from '../../libs/cx/cx'
import { useKeyboardLayer } from '../../libs/hooks/useKeyboardLayer'
import { KEYBOARD_LAYER } from '../../libs/keyboardLayers'
import styles from './Modal.module.scss'

// Base modal primitive: a dimmed overlay with a centered panel. Presentational
// only — it owns dismissal mechanics (backdrop click, Escape, body scroll lock,
// focus management) but not what's inside. Build concrete dialogs (confirm,
// forms, pickers) on top of it; the imperative confirm() lives in core/Dialog.
//
// Rendered through a portal into <body> so it's never clipped by an ancestor's
// overflow and its fixed positioning can't be broken by an ancestor transform.
/** Panel width preset. The panel is ALWAYS viewport-capped (overlay padding +
 *  max-height) and lays out as a column whose content scrolls — children can
 *  never stretch the panel, only fill up to the preset. */
export type ModalSize = 'sm' | 'md' | 'lg' | 'xl'

type ModalProps = {
  children?: ReactNode
  onClose?: () => void // called on backdrop click / Escape (omit to make it sticky)
  closeOnBackdrop?: boolean // default true
  labelledBy?: string // id of the panel's heading, for aria-labelledby
  size?: ModalSize // width preset, default 'sm' (420px)
  className?: string // extra class on the panel (escape hatch beyond size presets)
  // Extra class on the OVERLAY (the backdrop's parent) — set --modal-backdrop-dim
  // / --modal-backdrop-blur here to tune how much the page shows through behind a
  // surface that wants to read as glass OVER content (e.g. the Spotlight switcher).
  overlayClassName?: string
  testId?: string
  overlayTestId?: string
}

export const Modal = ({
  children,
  onClose,
  closeOnBackdrop = true,
  labelledBy,
  size = 'sm',
  className = '',
  overlayClassName = '',
  testId,
  overlayTestId,
}: ModalProps) => {
  const panelRef = useRef<HTMLDivElement>(null)

  // Latest onClose without re-running the setup effect: the effect must run
  // once on mount (locking scroll, taking focus), not on every parent render —
  // otherwise it would keep stealing focus back to the panel from inputs inside.
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  // Escape comes from the shared arbiter, which knows about the popover this panel
  // may have over it and about the drawer it may sit on. Omitting `onClose` still
  // registers the layer: a sticky dialog swallows the key rather than letting the
  // surface underneath answer for it.
  const ownsFocus = useKeyboardLayer(true, KEYBOARD_LAYER.modal, () => onCloseRef.current?.())

  useEffect(() => {
    const prevFocus = document.activeElement
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    // Pull focus inside so Escape/Tab land in the dialog, not the page behind —
    // but only if content didn't already autoFocus a control (don't steal it).
    if (panelRef.current && !panelRef.current.contains(document.activeElement)) {
      panelRef.current.focus()
    }

    const onKey = (e: KeyboardEvent) => {
      // Focus trap: keep Tab cycling within the panel — but only while this panel is
      // the live modal. A popover over it owns Escape without owning the trap.
      if (e.key !== 'Tab' || !ownsFocus()) {
        return
      }
      const panel = panelRef.current

      if (!panel) {
        return
      }
      const focusables = panel.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )

      if (!focusables.length) {
        e.preventDefault()
        panel.focus()
        return
      }
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      const active = document.activeElement

      if (e.shiftKey && (active === first || active === panel)) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && active === last) {
        e.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
      if (prevFocus instanceof HTMLElement) {
        prevFocus.focus()
      }
    }
    // `ownsFocus` is referentially stable, so this still runs once on mount — the
    // effect locks scroll and takes focus, and must not do either twice.
  }, [ownsFocus])

  return createPortal(
    <div
      className={cx(styles.modalOverlay, overlayClassName)}
      data-testid={overlayTestId}
      onMouseDown={(e) => {
        if (closeOnBackdrop && onClose && e.target === e.currentTarget) {
          onClose()
        }
      }}
    >
      {/* The dim + blur live on a dedicated layer BEHIND the panel, not on the
          overlay that contains it. If backdrop-filter sits on the panel's
          ancestor, the panel's box-shadow gets folded into that filter's
          reduced-precision compositing group and visibly bands (stair-steps)
          over the dark backdrop. Isolating the blur here keeps the shadow smooth.
          pointer-events:none lets backdrop clicks fall through to the overlay. */}
      <div className={styles.modalBackdrop} aria-hidden="true" />
      <div
        ref={panelRef}
        className={cx(styles.modalPanel, 'glass', styles[`size-${size}`], className)}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        data-testid={testId}
        tabIndex={-1}
      >
        {children}
      </div>
    </div>,
    document.body,
  )
}
