import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import { Link } from 'react-router'
import { cx } from '../../libs/cx/cx'
import styles from './PillTabs.module.scss'

// A pill tab-bar: a permanent row of outline plates switching between the sub-surfaces
// of one place, the active one accent-lit. Each pill is a real <Link> (middle/ctrl-click
// opens the surface in a new tab). Two layouts: `fill` stretches the pills to equal
// columns (the dashboard's full-width metric plates, #216); the default is content-width,
// left-aligned — section tabs for a surface with a few named parts (the Agents sections,
// #243). One implementation so every "sections of a surface" nav reads the same.

export type PillTab = {
  key: string
  /** Where the pill navigates (a routed sub-surface). */
  to: string
  label: string
  icon?: ReactNode
  /** An optional second line under the label — a metric/status (e.g. "3 to fix"). */
  metric?: ReactNode
  /** A danger dot on the label (e.g. the dashboard Health pill when links are broken). */
  danger?: boolean
  /** A softer attention dot (amber) — a signal that's a hint, not an error. */
  warn?: boolean
  testId?: string
  onClick?: (event: ReactMouseEvent<HTMLAnchorElement>) => void
}

export const PillTabs = ({
  tabs,
  activeKey,
  ariaLabel,
  fill = false,
  className,
}: {
  tabs: PillTab[]
  activeKey: string
  ariaLabel: string
  /** Stretch pills to equal columns (the dashboard's full-width plates); default is
   *  content-width, left-aligned (section-nav tabs). */
  fill?: boolean
  className?: string
}) => (
  <nav className={cx(styles.tabs, fill && styles.fill, className)} aria-label={ariaLabel}>
    {tabs.map((t) => {
      const isActive = t.key === activeKey
      return (
        <Link
          key={t.key}
          to={t.to}
          className={cx(styles.pill, isActive && styles.pillActive)}
          aria-current={isActive ? 'page' : undefined}
          data-testid={t.testId}
          onClick={t.onClick}
        >
          {t.icon && (
            <span className={styles.pillIcon} aria-hidden>
              {t.icon}
            </span>
          )}
          <span className={styles.pillBody}>
            <span className={styles.pillLabel}>
              {t.label}
              {t.danger ? (
                <span className={styles.pillDot} data-severity="danger" aria-hidden />
              ) : (
                t.warn && <span className={styles.pillDot} data-severity="warn" aria-hidden />
              )}
            </span>
            {t.metric != null && <span className={styles.pillMetric}>{t.metric}</span>}
          </span>
        </Link>
      )
    })}
  </nav>
)
