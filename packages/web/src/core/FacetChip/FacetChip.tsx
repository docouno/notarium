import { type CSSProperties, type MouseEventHandler, type ReactNode } from 'react'
import type { FieldColor } from '@notarium/contract'

import { cx } from '../../libs/cx/cx'
import styles from './FacetChip.module.scss'

type FacetChipTrailingAction = {
  icon: ReactNode
  ariaLabel: string
  expanded?: boolean
  onClick: MouseEventHandler<HTMLButtonElement>
}

export const FacetChip = ({
  label,
  count,
  icon,
  color,
  selected = false,
  title,
  ariaLabel,
  onClick,
  trailingAction,
  testId,
}: {
  label: ReactNode
  count?: number
  icon?: ReactNode
  color?: FieldColor
  selected?: boolean
  title?: string
  ariaLabel?: string
  onClick: MouseEventHandler<HTMLButtonElement>
  trailingAction?: FacetChipTrailingAction
  testId?: string
}) => (
  <span
    className={cx(
      styles.facetChip,
      color && styles.colored,
      selected && styles.selected,
      trailingAction && styles.hasTrailing,
    )}
    style={
      color
        ? ({
            '--facet-solid': `var(--field-color-${color})`,
            '--facet-fg': `var(--field-color-${color}-fg)`,
            '--facet-surface': `var(--field-color-${color}-surface)`,
            '--facet-border': `var(--field-color-${color}-border)`,
          } as CSSProperties)
        : undefined
    }
  >
    <button
      type="button"
      className={styles.main}
      onClick={onClick}
      aria-pressed={selected}
      aria-label={ariaLabel}
      title={title}
      data-testid={testId}
    >
      {icon !== undefined && (
        <span className={styles.icon} aria-hidden="true">
          {icon}
        </span>
      )}
      <span className={styles.label}>{label}</span>
      {count !== undefined && <span className={styles.count}>{count}</span>}
    </button>
    {trailingAction && (
      <button
        type="button"
        className={cx(styles.trailing, trailingAction.expanded && styles.trailingExpanded)}
        onClick={trailingAction.onClick}
        aria-label={trailingAction.ariaLabel}
        aria-expanded={trailingAction.expanded}
      >
        <span aria-hidden="true">{trailingAction.icon}</span>
      </button>
    )}
  </span>
)
