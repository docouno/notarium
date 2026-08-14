import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { cx } from '../../libs/cx/cx'
import { useDismiss } from '../../libs/hooks/useDismiss'
import { IconCheck, IconChevron } from '../Icons'
import styles from './ContextMenu.module.scss'

// A lightweight popover menu. Rendered through a portal into <body> and
// positioned fixed at an anchor point, so it's never clipped by a scroll
// container and an ancestor transform can't break its fixed positioning. It
// closes on outside click, Escape, scroll, resize, or selecting a leaf item.
//
// Items are a flat list; an entry may be:
//   { label, icon, onClick, danger, active }  — a leaf (active → check mark)
//   { divider: true }                         — a separator
//   { label, icon, children: [...] }          — a submenu (flyout on hover)
//
// We deliberately avoid a menu library to keep the bundle dep-free.
export type MenuItem = {
  label?: string
  icon?: ReactNode
  onClick?: () => void
  danger?: boolean
  active?: boolean
  divider?: boolean
  children?: MenuItem[]
}

const MenuRow = ({ item, onClose }: { item: MenuItem; onClose: () => void }) => {
  const ref = useRef<HTMLDivElement>(null)
  const [openSub, setOpenSub] = useState(false)
  const [subRight, setSubRight] = useState(true) // submenu opens to the right by default
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => () => clearTimeout(closeTimer.current), [])

  if (item.divider) {
    return <div className={styles.contextMenuSep} />
  }

  if (item.children) {
    // Hover-intent: open immediately, but defer closing so the pointer can cross
    // the small gap from the row to the flyout without it snapping shut.
    const open = () => {
      clearTimeout(closeTimer.current)
      setOpenSub(true)
      const el = ref.current

      if (el) {
        const r = el.getBoundingClientRect()
        setSubRight(r.right + 200 <= window.innerWidth) // flip left near the edge
      }
    }

    const scheduleClose = () => {
      clearTimeout(closeTimer.current)
      closeTimer.current = setTimeout(() => setOpenSub(false), 160)
    }

    return (
      <div
        ref={ref}
        className={cx(styles.contextMenuItem, styles.hasSubmenu)}
        role="menuitem"
        tabIndex={-1}
        aria-haspopup="menu"
        onMouseEnter={open}
        onMouseLeave={scheduleClose}
      >
        {item.icon && <span className={styles.contextMenuIcon}>{item.icon}</span>}
        <span className={styles.contextMenuLabel}>{item.label}</span>
        <span className={styles.contextMenuCaret}>
          <IconChevron size={13} />
        </span>
        {openSub && (
          <div
            className={cx(
              styles.contextSubmenu,
              'glass',
              'glass-float',
              subRight ? styles.right : styles.left,
            )}
            role="menu"
            onMouseEnter={open}
            onMouseLeave={scheduleClose}
          >
            {item.children.map((child, i) => (
              <MenuRow key={child.label || `d${i}`} item={child} onClose={onClose} />
            ))}
          </div>
        )}
      </div>
    )
  }

  return (
    <button
      className={cx(styles.contextMenuItem, item.danger && styles.danger)}
      role={item.active !== undefined ? 'menuitemradio' : 'menuitem'}
      aria-checked={item.active !== undefined ? item.active : undefined}
      tabIndex={-1}
      onClick={() => {
        onClose()
        item.onClick?.()
      }}
    >
      {item.icon && <span className={styles.contextMenuIcon}>{item.icon}</span>}
      <span className={styles.contextMenuLabel}>{item.label}</span>
      {item.active && (
        <span className={styles.contextMenuCheck}>
          <IconCheck size={14} />
        </span>
      )}
    </button>
  )
}

type ContextMenuProps = {
  x: number
  y: number
  items: MenuItem[]
  onClose: () => void
  ignoreRef?: RefObject<HTMLElement | null>
  placement?: 'down' | 'up'
  /** Floor the menu width to this (px) — lets a Select's list match its trigger. */
  minWidth?: number
  /** Rich content rendered above the items, set off by a separator — e.g. the
   *  sync status block atop the rail's profile dropdown (#112). Display only; the
   *  actions stay in `items`. */
  header?: ReactNode
  /** Raise the menu above modals — for a menu opened from WITHIN a dialog (e.g. a
   *  Select's list in a picker), which otherwise portals below the modal it belongs
   *  to. Off by default (page menus stay under modals). */
  elevated?: boolean
}

export const ContextMenu = ({
  x,
  y,
  items,
  onClose,
  ignoreRef,
  placement = 'down',
  minWidth,
  header,
  elevated,
}: ContextMenuProps) => {
  const ref = useRef<HTMLDivElement>(null)
  const restoreTarget = useRef<HTMLElement | null>(null)
  const suppressRestore = useRef(false)
  const [pos, setPos] = useState<{ left: number; top: number; maxHeight?: number }>({
    left: x,
    top: y,
  })
  // A flat menu (no flyout submenus) may scroll when it's taller than the screen.
  // Submenus open as absolutely-positioned children OUTSIDE the menu box, which an
  // overflow scroller would clip — so only flat menus get the cap + scroll. (No
  // menu currently uses submenus, but the feature exists, so gate it.)
  const scrollable = !items.some((i) => i.children)

  useEffect(() => {
    const active = document.activeElement
    restoreTarget.current =
      active instanceof HTMLElement && active !== document.body
        ? active
        : (ignoreRef?.current ?? null)
    ref.current?.querySelector<HTMLElement>('[role^="menuitem"]')?.focus()
    return () => {
      const target = restoreTarget.current
      requestAnimationFrame(() => {
        const current = document.activeElement

        if (
          suppressRestore.current ||
          !target?.isConnected ||
          (current instanceof HTMLElement && current !== document.body && current.isConnected)
        ) {
          return
        }
        target.focus()
      })
    }
  }, [ignoreRef])

  const moveFocus = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Tab') {
      event.preventDefault()
      const focusable = [
        ...document.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ].filter(
        (element) =>
          !ref.current?.contains(element) &&
          element.getClientRects().length > 0 &&
          element.getAttribute('aria-hidden') !== 'true',
      )
      const origin = restoreTarget.current
      const originIndex = origin ? focusable.indexOf(origin) : -1
      const nextIndex = event.shiftKey
        ? originIndex > 0
          ? originIndex - 1
          : focusable.length - 1
        : originIndex >= 0 && originIndex < focusable.length - 1
          ? originIndex + 1
          : 0
      const next = focusable[nextIndex]
      suppressRestore.current = true
      onClose()
      requestAnimationFrame(() => next?.focus())
      return
    }
    const rows = [
      ...event.currentTarget.querySelectorAll<HTMLElement>('[role^="menuitem"]'),
    ].filter((row) => row.closest('[role="menu"]') === event.currentTarget)

    if (rows.length === 0) {
      return
    }
    const current = rows.indexOf(document.activeElement as HTMLElement)
    const next =
      event.key === 'ArrowDown'
        ? (current + 1) % rows.length
        : event.key === 'ArrowUp'
          ? (current - 1 + rows.length) % rows.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? rows.length - 1
              : null

    if (next == null) {
      return
    }
    event.preventDefault()
    rows[next]?.focus()
  }

  // Flip the menu back inside the viewport. 'up' anchors the menu's bottom at y
  // (open above a bottom-docked trigger); 'down' anchors its top at y. A scrollable
  // menu is also capped to the viewport height so a long list (e.g. the 15-font
  // Select) never runs off-screen — it scrolls internally instead of overflowing.
  useLayoutEffect(() => {
    const el = ref.current

    if (!el) {
      return
    }
    const pad = 8
    const { width } = el.getBoundingClientRect()
    const maxH = window.innerHeight - pad * 2
    // scrollHeight = natural (pre-cap) content height; cap it for the flip math so
    // `top` uses the height the menu will actually render at once capped.
    const height = scrollable ? Math.min(el.scrollHeight, maxH) : el.scrollHeight
    const left = Math.min(x, window.innerWidth - width - pad)
    const rawTop = placement === 'up' ? y - height - 4 : y
    const top = Math.min(rawTop, window.innerHeight - height - pad)
    setPos({
      left: Math.max(pad, left),
      top: Math.max(pad, top),
      maxHeight: scrollable ? maxH : undefined,
    })
  }, [x, y, placement, scrollable])

  // Any interaction outside the menu (or its trigger) — pointerdown, Escape, scroll,
  // resize, contextmenu — closes it. The trigger (ignoreRef) is exempt so it can
  // toggle the menu itself, instead of this closing it and the click reopening it.
  useDismiss(true, onClose, { inside: [ref, ignoreRef], viewport: true })

  return createPortal(
    <div
      ref={ref}
      className={cx(
        styles.contextMenu,
        scrollable && styles.scrollable,
        elevated && styles.elevated,
        'glass',
        'glass-float',
      )}
      style={{ left: pos.left, top: pos.top, minWidth, maxHeight: pos.maxHeight }}
      role="menu"
      onKeyDown={moveFocus}
      onContextMenu={(e) => e.preventDefault()}
    >
      {header && (
        <>
          <div className={styles.contextMenuHeader}>{header}</div>
          <div className={styles.contextMenuSep} />
        </>
      )}
      {items.map((item, i) => (
        <MenuRow key={item.label || `d${i}`} item={item} onClose={onClose} />
      ))}
    </div>,
    document.body,
  )
}
