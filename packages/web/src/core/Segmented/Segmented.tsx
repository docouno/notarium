import { type ReactNode } from 'react'
import { cx } from '../../libs/cx/cx'
import styles from './Segmented.module.scss'

type SegmentedOption<T extends string> = {
  value: T
  label?: string
  icon?: ReactNode
  title?: string
}

type SegmentedProps<T extends string> = {
  value: T
  onChange: (value: T) => void
  options: SegmentedOption<T>[]
  ariaLabel?: string
  block?: boolean
  /** Disable the whole control (every segment) — e.g. a form busy with a running
   *  operation. Symmetric with Switch's `disabled`. */
  disabled?: boolean
  /** Extra class on the root — lets a host restyle the control (e.g. stretch it
   *  full-width inside a container query) without widening the component. */
  className?: string
}

// Universal segmented control (a row of mutually-exclusive pill buttons). Shared
// by the Feed controls and the Graph view so toggles look and behave identically.
// Each option: { value, label?, icon?, title? }. Pass `value` + `onChange`.
// `block` stretches the control full-width with equal segments (for filter facets).
// Generic over the value union so callers keep their literal types (e.g. FeedSort)
// through value/onChange/options instead of widening to string.
export const Segmented = <T extends string = string>({
  value,
  onChange,
  options,
  ariaLabel,
  block,
  disabled,
  className,
}: SegmentedProps<T>) => (
  <div
    className={cx(styles.seg, block && styles.block, className)}
    role="group"
    aria-label={ariaLabel}
  >
    {options.map((o) => (
      <button
        key={o.value}
        type="button"
        className={cx(styles.segBtn, value === o.value && styles.on)}
        onClick={() => onChange(o.value)}
        disabled={disabled}
        title={o.title || o.label}
      >
        {o.icon}
        {o.label && <span>{o.label}</span>}
      </button>
    ))}
  </div>
)
