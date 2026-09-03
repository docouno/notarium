import { type CSSProperties, type ReactNode, useLayoutEffect, useRef, useState } from 'react'
import { cx } from '../../libs/cx/cx'
import { IconChevron } from '../Icons'
import type { NoticeVariant } from '../Notice'
import styles from './ActivityTimeline.module.scss'

type TimelineElement = 'div' | 'ul'
type RowElement = 'div' | 'li'

export const ActivityTimeline = ({
  as: Tag = 'div',
  children,
  className,
  testId,
  ariaHidden,
  spine = true,
  skeleton,
}: {
  as?: TimelineElement
  children: ReactNode
  className?: string
  testId?: string
  ariaHidden?: boolean
  /** Nested rows may share the parent timeline's continuous spine. */
  spine?: boolean
  /** A placeholder timeline drawn before data exists: marked `data-skeleton`, the
   *  same attribute the heatmap's skeleton cells carry, so one selector finds
   *  every skeleton on a surface. */
  skeleton?: boolean
}) => (
  <Tag
    className={cx(
      styles.timeline,
      !spine && styles.spineLess,
      Tag === 'ul' && styles.list,
      className,
    )}
    data-testid={testId}
    data-skeleton={skeleton || undefined}
    aria-hidden={ariaHidden}
  >
    {children}
  </Tag>
)

export const ActivityTimelineRow = ({
  as: Tag = 'div',
  icon,
  variant,
  primary,
  time,
  action,
  actor,
  context,
  attributes,
  outcome,
  detail,
  disclosureLabel = 'Toggle details',
  defaultExpanded = false,
  expanded: expandedProp,
  onExpandedChange,
  reserveDisclosure = false,
  trailing,
  className,
  detailClassName,
  testId,
}: {
  as?: RowElement
  icon: ReactNode
  variant?: NoticeVariant
  /** Stable row grammar shared by every feed: subject + time, then ordered metadata. */
  primary: ReactNode
  time?: ReactNode
  action?: ReactNode
  actor?: ReactNode
  context?: ReactNode
  attributes?: ReactNode
  outcome?: ReactNode
  detail?: ReactNode
  disclosureLabel?: string
  defaultExpanded?: boolean
  /** Controlled expansion for rows whose selection belongs to their parent surface. */
  expanded?: boolean
  onExpandedChange?: (expanded: boolean) => void
  /** Keep the trailing disclosure column even when this row has no detail. */
  reserveDisclosure?: boolean
  /** Additional row actions after the disclosure slot (for example an overflow menu). */
  trailing?: ReactNode
  className?: string
  detailClassName?: string
  testId?: string
}) => {
  const [expandedState, setExpandedState] = useState(defaultExpanded)
  const actionsRef = useRef<HTMLDivElement>(null)
  const contentPointerStartRef = useRef<{ x: number; y: number } | null>(null)
  const [actionsWidth, setActionsWidth] = useState(0)
  const expandable = detail != null
  const expanded = expandable && (expandedProp ?? expandedState)
  const meta = [
    ['action', action],
    ['actor', actor],
    ['context', context],
    ['attributes', attributes],
    ['outcome', outcome],
  ] as const
  const hasMeta = meta.some(([, value]) => value != null)

  useLayoutEffect(() => {
    const node = actionsRef.current

    if (!expandable || !node) {
      return
    }

    const sync = () => {
      const next = node.getBoundingClientRect().width
      setActionsWidth((current) => (Math.abs(current - next) < 0.01 ? current : next))
    }
    sync()
    const observer = new ResizeObserver(sync)
    observer.observe(node)
    return () => observer.disconnect()
  }, [expandable])

  const toggle = () => {
    const next = !expanded

    if (expandedProp === undefined) {
      setExpandedState(next)
    }
    onExpandedChange?.(next)
  }

  return (
    <Tag
      className={cx(styles.row, className)}
      style={
        expandable
          ? ({ '--activity-timeline-actions-width': `${actionsWidth}px` } as CSSProperties)
          : undefined
      }
      data-expanded={expandable && expanded ? true : undefined}
      data-testid={testId}
    >
      <div className={styles.head} data-expandable={expandable || undefined} data-timeline-head>
        {expandable && (
          <button
            type="button"
            className={styles.rowTrigger}
            aria-label={disclosureLabel}
            aria-expanded={expanded}
            onClick={toggle}
          />
        )}
        <span className={styles.marker} data-variant={variant} data-timeline-marker aria-hidden>
          {icon}
        </span>
        <div
          className={styles.content}
          onPointerDown={
            expandable
              ? (event) => {
                  contentPointerStartRef.current = { x: event.clientX, y: event.clientY }
                }
              : undefined
          }
          onClick={
            expandable
              ? (event) => {
                  const start = contentPointerStartRef.current
                  contentPointerStartRef.current = null
                  const target = event.target as Element

                  if (
                    target.closest(
                      'a, button, input, select, textarea, [role="button"], [contenteditable="true"]',
                    )
                  ) {
                    return
                  }
                  if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 3) {
                    return
                  }
                  toggle()
                }
              : undefined
          }
        >
          <div className={styles.primaryLine}>
            <div className={styles.primary}>{primary}</div>
            {time != null && (
              <div className={styles.time} data-timeline-time>
                {time}
              </div>
            )}
          </div>
          {hasMeta && (
            <div className={styles.metaLine} data-timeline-meta>
              {meta.map(
                ([slot, value]) =>
                  value != null && (
                    <span key={slot} className={styles.metaSlot} data-timeline-slot={slot}>
                      {value}
                    </span>
                  ),
              )}
            </div>
          )}
        </div>
        {(expandable || reserveDisclosure || trailing != null) && (
          <div ref={actionsRef} className={styles.actions}>
            {expandable ? (
              <span
                className={styles.disclosure}
                data-testid="activity-disclosure-caret"
                aria-hidden
              >
                <IconChevron size={13} className={cx(expanded && styles.caretOpen)} />
              </span>
            ) : reserveDisclosure ? (
              <span className={styles.disclosureSlot} aria-hidden />
            ) : null}
            {trailing}
          </div>
        )}
      </div>
      {expandable && expanded && (
        <div className={cx(styles.detail, detailClassName)} data-timeline-detail>
          {detail}
        </div>
      )}
    </Tag>
  )
}
