import { type MouseEvent, type ReactNode, useState } from 'react'
import { cx } from '../../libs/cx/cx'
import type { ReorderHandle } from '../../libs/dnd/reorder'
import { IconChevron } from '../Icons'
import styles from './DisclosureCard.module.scss'

// The shared disclosure card (#165/#243): a bordered, slightly-raised surface whose
// always-visible HEADER is the toggle — click it to reveal the BODY below. Extracted
// from the context constructor's card (#165) so the agent Audit log (#243) reads the
// SAME way: the explicit card separation + the expanded-state colour shift (the border
// firms, the hover tint freezes) are the disclosure affordance tuned for that surface.
//
//   • Click the header row → expand / collapse (the caret mirrors the state).
//   • `caret` puts the chevron at the row's `start` (Audit) or `end` (Context).
//   • `aside` is a trailing zone OUTSIDE the toggle button — e.g. a ⋮ menu — so the
//     whole header still reads as one surface (its own button, not part of the toggle).
//
// The BODY is caller-owned (rendered as children when open): each surface styles its
// reveal differently (Context: a padded summary/provenance; Audit: a bordered hit list),
// so the primitive stays out of it and only owns the chrome + the toggle. Uncontrolled
// by default; pass `open` + `onToggle` to drive it.
export const DisclosureCard = ({
  header,
  children,
  expandable = true,
  caret = 'end',
  aside,
  open: openProp,
  defaultOpen = false,
  onToggle,
  onContextMenu,
  className,
  headerClassName,
  reorder,
  grip,
  testId,
  headerTestId,
}: {
  /** The always-visible header — a FLAT fragment of flex children; the primitive lays
   *  them out in one row with the caret. */
  header: ReactNode
  /** Revealed below the header when open. Absent / non-expandable ⇒ header only. */
  children?: ReactNode
  /** A header with nothing to reveal is inert (no caret, no pointer). Default true. */
  expandable?: boolean
  caret?: 'start' | 'end'
  /** A trailing zone rendered OUTSIDE the toggle button (e.g. a ⋮ menu button). */
  aside?: ReactNode
  /** Controlled open state; omit to let the card manage its own. */
  open?: boolean
  defaultOpen?: boolean
  onToggle?: (open: boolean) => void
  onContextMenu?: (e: MouseEvent) => void
  /** Extra class on the card surface (e.g. a muted fade, a density variant). */
  className?: string
  /** Extra class on the toggle button (e.g. a per-surface header layout). */
  headerClassName?: string
  /** Make the card a REORDER handle (#210): drag props + the drop indicator / dragging
   *  state from `useReorder`. The whole card is the drag surface (like a tree row); `grip`
   *  is the affordance. Absent ⇒ a plain, non-draggable card. */
  reorder?: ReorderHandle
  /** A leading drag-handle affordance (a grip glyph), shown before the toggle when the card
   *  is reorderable. Purely visual — the whole card drags. */
  grip?: ReactNode
  testId?: string
  headerTestId?: string
}) => {
  const [openState, setOpenState] = useState(defaultOpen)
  const open = (openProp ?? openState) && expandable

  const toggle = () => {
    if (!expandable) {
      return
    }
    const next = !open

    if (openProp === undefined) {
      setOpenState(next)
    }
    onToggle?.(next)
  }
  const chevron = expandable ? (
    <IconChevron size={13} className={cx(styles.caret, open && styles.caretOpen)} />
  ) : null

  return (
    <div
      className={cx(
        styles.card,
        reorder && styles.reorderable,
        reorder?.dragging && styles.dragging,
        className,
      )}
      data-testid={testId}
      data-expanded={open || undefined}
      data-drop={reorder?.dropIndicator ?? undefined}
      draggable={reorder ? reorder.draggable : undefined}
      onDragStart={reorder?.onDragStart}
      onDragOver={reorder?.onDragOver}
      onDragEnd={reorder?.onDragEnd}
      onContextMenu={onContextMenu}
    >
      <div className={styles.header}>
        {grip != null && (
          <span
            className={styles.grip}
            role={reorder ? 'button' : undefined}
            tabIndex={reorder ? 0 : undefined}
            aria-label={reorder ? 'Reorder item' : undefined}
            aria-hidden={reorder ? undefined : true}
            title={reorder ? 'Move with Arrow Up or Arrow Down' : undefined}
            onKeyDown={reorder?.onKeyDown}
          >
            {grip}
          </span>
        )}
        <button
          type="button"
          className={cx(styles.trigger, aside != null && styles.triggerAside, headerClassName)}
          onClick={toggle}
          aria-expanded={expandable ? open : undefined}
          data-testid={headerTestId}
        >
          {caret === 'start' && chevron}
          {header}
          {caret === 'end' && chevron}
        </button>
        {aside}
      </div>
      {open && children}
    </div>
  )
}

// A loading placeholder that reserves a collapsed DisclosureCard's EXACT box — it reuses
// the same card + header + trigger chrome, so a skeleton row is pixel-for-pixel the height
// of the real row (no shift when content lands). `children` are the inner shimmer blocks;
// the trigger lays them out with the same gap/padding a real header uses.
export const DisclosureCardSkeleton = ({
  children,
  className,
}: {
  children?: ReactNode
  className?: string
}) => (
  <div className={cx(styles.card, className)} aria-hidden>
    <div className={styles.header}>
      <div className={styles.trigger}>{children}</div>
    </div>
  </div>
)
