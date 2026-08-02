import { type MouseEvent as ReactMouseEvent, type ReactNode, useRef } from 'react'
import { cx } from '../../libs/cx/cx'
import { ASIDE_PANEL, usePanelWidth } from '../../libs/hooks/usePanelWidth'
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
}: AsideGroupsProps) => {
  const [width, startWidthResize, setWidth] = usePanelWidth(ASIDE_PANEL)
  const { groups, setActiveTab, setGroupHeight } = useAsideLayout(
    panels.map((p) => p.id),
    defaultLayout,
    storageKey,
  )
  const stackRef = useRef<HTMLDivElement>(null)
  const byId = new Map(panels.map((p) => [p.id, p]))

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
    <aside className={styles.aside} style={{ width }} data-testid="aside-groups">
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
                <div className={styles.tabs} role="tablist">
                  {group.panels.map((pid) => {
                    const def = byId.get(pid)

                    if (!def) {
                      return null
                    }

                    return (
                      <button
                        key={pid}
                        role="tab"
                        aria-selected={pid === group.activeTab}
                        className={cx(styles.tab, pid === group.activeTab && styles.active)}
                        onClick={() => setActiveTab(group.id, pid)}
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
              <div className={styles.groupBody}>{active?.render()}</div>
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
