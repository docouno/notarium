import { type ReactNode, useEffect, useRef } from 'react'
import { cx } from '../../libs/cx/cx'
import { IconCheck, IconMinus } from '../Icons'
import styles from './Checkbox.module.scss'

// A styled checkbox (#28) — the shared multi-select tick for lists where several
// items can be on at once (e.g. picking spaces for a token). For a binary *mode*
// toggle, reach for Switch instead. A real <input> stays under the hood (keyboard
// + form semantics); the box is a painted overlay. Controlled: `checked` +
// `onChange`. `indeterminate` paints the "partial" dash (a select-all that covers
// only some rows) — a property of the live DOM node, set via the ref.
type CheckboxProps = {
  checked: boolean
  onChange: (checked: boolean) => void
  indeterminate?: boolean
  label?: ReactNode
  disabled?: boolean
  className?: string
  'data-testid'?: string
  'aria-label'?: string
}

export const Checkbox = ({
  checked,
  onChange,
  indeterminate = false,
  label,
  disabled = false,
  className,
  'data-testid': testId,
  'aria-label': ariaLabel,
}: CheckboxProps) => {
  const ref = useRef<HTMLInputElement>(null)
  // `indeterminate` is DOM-only (no HTML attribute) — mirror it onto the node.
  useEffect(() => {
    if (ref.current) {
      ref.current.indeterminate = indeterminate
    }
  }, [indeterminate])
  return (
    <label className={cx(styles.checkbox, disabled && styles.disabled, className)}>
      <input
        ref={ref}
        type="checkbox"
        className={styles.input}
        checked={checked}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-checked={indeterminate ? 'mixed' : checked}
        data-testid={testId}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className={styles.box} aria-hidden="true">
        {indeterminate ? <IconMinus size={12} /> : <IconCheck size={12} />}
      </span>
      {label != null && <span className={styles.label}>{label}</span>}
    </label>
  )
}
