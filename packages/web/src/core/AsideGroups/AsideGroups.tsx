import { type MouseEvent as ReactMouseEvent, type ReactNode, useEffect, useRef } from 'react'
import { cx } from '../../libs/cx/cx'
import { useKeyboardLayer } from '../../libs/hooks/useKeyboardLayer'
import { ASIDE_PANEL, usePanelWidth } from '../../libs/hooks/usePanelWidth'
import { KEYBOARD_LAYER } from '../../libs/keyboardLayers'
import {
  type GroupState,
  type LayoutSpec,
  MIN_GROUP_HEIGHT,
  useAsideLayout,
} from './useAsideLayout'
import styles from './AsideGroups.module.scss'

// One panel the aside can host: an id, a tab label, an optional count badge and a
// render thunk. The caller owns the content (and any cross-cutting effects, e.g.
// History's selection bubbling up) — AsideGroups only places it in a tabbed group.
export type AsidePanelDef = {
  id: string
  label: string
  badge?: number
  render: () => ReactNode
}

type AsideGroupsProps = {
  panels: AsidePanelDef[]
  defaultLayout: LayoutSpec
  /** localStorage key for the active-tab + heights, or null to keep them ephemeral
   *  (the single-group edit/feed asides have nothing to persist). */
  storageKey: string | null
  /** The panel toggle (collapse the whole aside) — shown in the first group's head. */
  headerAction?: ReactNode
  /** Activity uses the same aside shell as a full-width drawer at <=720px. */
  overlayOnNarrow?: boolean
  /** Apply modal dialog semantics and keyboard containment while the narrow
   *  full-screen variant is actually active. */
  modal?: boolean
  /** Close the modal shell from shared keyboard behavior such as Escape. */
  onRequestClose?: () => void
  /** Move focus into the active tab when this aside is mounted as an opened drawer. */
  autoFocus?: boolean
  /** Accessible name for the narrow modal variant. */
  modalLabel?: string
}

// The right aside as a vertical stack of tabbed groups (#35). The group COMPOSITION
// is fixed by `defaultLayout` (graph on top, the rest tabbed below) — it doesn't
// change per page, and there's no add/remove-group UI; user rearrangement (DnD,
// split/merge) is #36. What this owns is the shell: width (+ left-edge resize,
// persisted under the historical bm-aside-w key) and per-group height resize,
// including the CORNER grip that drives width and a group's height in one gesture.
// What persists is the active tab per group and the heights (useAsideLayout).
export const AsideGroups = ({
  panels,
  defaultLayout,
  storageKey,
  headerAction,
  overlayOnNarrow = false,
  modal = false,
  onRequestClose,
  autoFocus = false,
  modalLabel = 'Panels',
}: AsideGroupsProps) => {
  const [width, startWidthResize, setWidth] = usePanelWidth(ASIDE_PANEL)
  const { groups, setActiveTab, setGroupHeight } = useAsideLayout(
    panels.map((p) => p.id),
    defaultLayout,
    storageKey,
  )
  const asideRef = useRef<HTMLElement>(null)
  const stackRef = useRef<HTMLDivElement>(null)
  const byId = new Map(panels.map((p) => [p.id, p]))
  // The drawer is one of several surfaces that answer Escape; the shared arbiter
  // hands it the key only while nothing is stacked over it, and answers separately
  // for the focus trap, which a popover over the drawer must not take.
  const ownsFocus = useKeyboardLayer(modal, KEYBOARD_LAYER.modal, onRequestClose)

  useEffect(() => {
    if (!autoFocus) {
      return
    }
    const frame = requestAnimationFrame(() => {
      const active = asideRef.current?.querySelector<HTMLElement>('[role="tab"][tabindex="0"]')
      active?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [autoFocus])

  useEffect(() => {
    if (!modal) {
      return
    }
    const containFocus = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || !ownsFocus()) {
        return
      }
      const aside = asideRef.current

      if (!aside) {
        return
      }
      const focusable = [
        ...aside.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]',
        ),
      ].filter((element) => element.tabIndex >= 0)

      if (focusable.length === 0) {
        event.preventDefault()
        aside.focus()
        return
      }
      const first = focusable[0]!
      const last = focusable.at(-1)!
      const active = document.activeElement

      if (event.shiftKey && (active === first || active === aside)) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && active === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', containFocus)
    return () => {
      window.removeEventListener('keydown', containFocus)
    }
  }, [modal, ownsFocus])

  // Height ceiling for one group: leave at least MIN for every OTHER group so a
  // drag can't collapse its neighbours. Measured live off the stack.
  const clampHeight = (h: number) => {
    const stackH = stackRef.current?.clientHeight ?? 0
    const max = Math.max(
      MIN_GROUP_HEIGHT,
      stackH - MIN_GROUP_HEIGHT * Math.max(1, groups.length - 1),
    )
    return Math.min(max, Math.max(MIN_GROUP_HEIGHT, h))
  }

  // Drag a group's bottom edge to set its height (the group below — ultimately the
  // last, flexing group — gives or takes the space). Optionally drives width too
  // (the corner grip), so one diagonal gesture resizes both axes.
  const startGroupResize = (group: GroupState, e: ReactMouseEvent, withWidth: boolean) => {
    e.preventDefault()
    e.stopPropagation()
    const section = (e.currentTarget as HTMLElement).closest(
      `.${styles.group}`,
    ) as HTMLElement | null
    const startH = section?.offsetHeight ?? group.height ?? MIN_GROUP_HEIGHT
    const startY = e.clientY
    const startX = e.clientX
    const startW = width

    const onMove = (ev: MouseEvent) => {
      setGroupHeight(group.id, clampHeight(startH + (ev.clientY - startY)))
      // Left-edge aside: dragging left (negative dx) widens it.
      if (withWidth) {
        setWidth(startW - (ev.clientX - startX))
      }
    }

    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
    }
    document.body.style.cursor = withWidth ? 'nwse-resize' : 'row-resize'
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  return (
    <aside
      ref={asideRef}
      className={cx(styles.aside, overlayOnNarrow && styles.overlayOnNarrow)}
      style={{ width }}
      data-testid="aside-groups"
      role={modal ? 'dialog' : undefined}
      aria-modal={modal || undefined}
      aria-label={modal ? modalLabel : undefined}
      tabIndex={modal ? -1 : undefined}
    >
      <div className={styles.widthResize} onMouseDown={startWidthResize} />
      <div className={styles.stack} ref={stackRef}>
        {groups.map((group, i) => {
          const last = i === groups.length - 1
          const active = byId.get(group.activeTab)
          return (
            <section
              key={group.id}
              className={styles.group}
              style={
                last
                  ? { flex: 1, minHeight: MIN_GROUP_HEIGHT }
                  : { height: group.height ?? 240, flex: '0 0 auto' }
              }
              data-testid="aside-group"
            >
              <div className={cx(styles.groupHead, 'glass', 'glass-edge-bottom')}>
                <div className={styles.tabs} role="tablist" aria-orientation="horizontal">
                  {group.panels.map((pid, panelIndex) => {
                    const def = byId.get(pid)

                    if (!def) {
                      return null
                    }

                    return (
                      <button
                        key={pid}
                        id={`aside-${group.id}-${pid}-tab`}
                        role="tab"
                        aria-selected={pid === group.activeTab}
                        aria-controls={`aside-${group.id}-${pid}-panel`}
                        tabIndex={pid === group.activeTab ? 0 : -1}
                        className={cx(styles.tab, pid === group.activeTab && styles.active)}
                        onClick={() => setActiveTab(group.id, pid)}
                        onKeyDown={(event) => {
                          const lastIndex = group.panels.length - 1
                          const nextIndex =
                            event.key === 'ArrowRight'
                              ? (panelIndex + 1) % group.panels.length
                              : event.key === 'ArrowLeft'
                                ? (panelIndex - 1 + group.panels.length) % group.panels.length
                                : event.key === 'Home'
                                  ? 0
                                  : event.key === 'End'
                                    ? lastIndex
                                    : null

                          if (nextIndex == null) {
                            return
                          }
                          event.preventDefault()
                          const nextId = group.panels[nextIndex]!
                          setActiveTab(group.id, nextId)
                          requestAnimationFrame(() =>
                            document.getElementById(`aside-${group.id}-${nextId}-tab`)?.focus(),
                          )
                        }}
                        data-testid={`aside-tab-${pid}`}
                      >
                        {def.label}
                        {def.badge != null && def.badge > 0 && (
                          <span className={styles.badge}>{def.badge}</span>
                        )}
                      </button>
                    )
                  })}
                </div>
                {i === 0 && headerAction && (
                  <div className={styles.groupActions}>{headerAction}</div>
                )}
              </div>
              <div
                id={`aside-${group.id}-${group.activeTab}-panel`}
                className={styles.groupBody}
                role="tabpanel"
                aria-labelledby={`aside-${group.id}-${group.activeTab}-tab`}
                tabIndex={0}
              >
                {active?.render()}
              </div>
              {group.panels
                .filter((pid) => pid !== group.activeTab && byId.has(pid))
                .map((pid) => (
                  <div
                    key={pid}
                    id={`aside-${group.id}-${pid}-panel`}
                    role="tabpanel"
                    aria-labelledby={`aside-${group.id}-${pid}-tab`}
                    hidden
                  />
                ))}
              {!last && (
                <>
                  {/* Corner grip: width + this group's height in one diagonal drag.
                      Ordered before the divider so hovering it can light the divider
                      line too (sibling selector) — both axes read at once. */}
                  <div
                    className={styles.groupCorner}
                    onMouseDown={(e) => startGroupResize(group, e, true)}
                    data-testid="aside-corner"
                  />
                  <div
                    className={styles.groupResize}
                    onMouseDown={(e) => startGroupResize(group, e, false)}
                  />
                </>
              )}
            </section>
          )
        })}
      </div>
    </aside>
  )
}
