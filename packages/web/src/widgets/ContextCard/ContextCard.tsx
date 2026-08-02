import { type ReactNode, useRef, useState } from 'react'
import { ContextMenu, type MenuItem } from '../../core/ContextMenu'
import { DisclosureCard } from '../../core/DisclosureCard'
import { IconGrip, IconMore } from '../../core/Icons'
import { cx } from '../../libs/cx/cx'
import type { ReorderHandle } from '../../libs/dnd/reorder'
import styles from './ContextCard.module.scss'

// The shared context card (#165 UX r6): a compact ONE-LINE row by default — title on
// the left, a disclosure caret + a ⋮ menu on the right — that expands to reveal its
// detail (summary + provenance / meta). The card chrome + the disclosure toggle come
// from the shared `DisclosureCard` primitive (#243 unified it with the Audit log); this
// widget adds the note-card semantics: title / summary / details, the ⋮ action menu
// (the button OR a right-click anywhere on the card open the same one), and the muted
// fade.
//
//   • Click the row (or the caret) → expand / collapse.
//   • Click ⋮, or right-click the card → the action menu.
//
// Muting dims the title (a soft fade), never a different-colour fill.
export const ContextCard = ({
  title,
  summary,
  details,
  menu,
  muted = false,
  reorder,
  testId,
}: {
  title: ReactNode
  /** Revealed on expand: a one-line digest (memory summary / note snippet). */
  summary?: ReactNode
  /** Revealed on expand, below the summary: provenance, meta, etc. */
  details?: ReactNode
  /** The action menu — opened by the ⋮ button and by a right-click on the card. */
  menu?: MenuItem[]
  /** Dim the title (a muted memory category). */
  muted?: boolean
  /** Make the row a drag handle for list reordering (#210). Absent ⇒ a plain card. */
  reorder?: ReorderHandle
  testId?: string
}) => {
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null)
  const moreRef = useRef<HTMLButtonElement>(null)
  const canExpand = (summary != null && summary !== '') || (details != null && details !== false)
  const hasMenu = menu != null && menu.length > 0

  const aside = hasMenu ? (
    <button
      ref={moreRef}
      type="button"
      className={styles.more}
      onClick={() => {
        const r = moreRef.current?.getBoundingClientRect()

        if (r) {
          setMenuAt({ x: r.right, y: r.bottom + 4 })
        }
      }}
      aria-label="More actions"
      data-testid={testId ? `${testId}-menu` : undefined}
    >
      <IconMore size={16} />
    </button>
  ) : undefined

  return (
    <>
      <DisclosureCard
        className={cx(muted && styles.muted)}
        header={<span className={styles.title}>{title}</span>}
        expandable={canExpand}
        aside={aside}
        reorder={reorder}
        grip={reorder ? <IconGrip size={15} /> : undefined}
        onContextMenu={
          hasMenu
            ? (e) => {
                e.preventDefault()
                setMenuAt({ x: e.clientX, y: e.clientY })
              }
            : undefined
        }
        testId={testId}
        headerTestId={testId ? `${testId}-row` : undefined}
      >
        <div className={styles.body}>
          {summary != null && summary !== '' && <p className={styles.summary}>{summary}</p>}
          {details != null && details !== false && <div className={styles.details}>{details}</div>}
        </div>
      </DisclosureCard>

      {menuAt && hasMenu && (
        <ContextMenu
          x={menuAt.x}
          y={menuAt.y}
          items={menu}
          onClose={() => setMenuAt(null)}
          ignoreRef={moreRef}
        />
      )}
    </>
  )
}
