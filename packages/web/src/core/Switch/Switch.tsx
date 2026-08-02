import { type ReactNode } from 'react'
import { cx } from '../../libs/cx/cx'
import styles from './Switch.module.scss'

// A toggle switch — the shared on/off control for binary modes (e.g. "all
// spaces" gating a sub-picker, an invite's admin flag). Reach for this over a
// Checkbox when the toggle reads as a *mode* (it changes what else is shown or
// how the form behaves), and over a Segmented when there are exactly two states
// with an obvious "on". Controlled: pass `checked` + `onChange`.
type SwitchProps = {
  checked: boolean
  onChange: (checked: boolean) => void
  /** Optional label sitting to the right of the track; the whole control is clickable. */
  label?: ReactNode
  disabled?: boolean
  className?: string
  /** Lets an external `<label htmlFor>` target the switch — clicking that label
   *  toggles it (a button is a labelable element). For a label baked into the
   *  track use the `label` prop instead. */
  id?: string
  'data-testid'?: string
  'aria-label'?: string
}

export const Switch = ({
  checked,
  onChange,
  label,
  disabled = false,
  className,
  id,
  'data-testid': testId,
  'aria-label': ariaLabel,
}: SwitchProps) => (
  <button
    type="button"
    role="switch"
    id={id}
    aria-checked={checked}
    aria-label={ariaLabel}
    disabled={disabled}
    data-testid={testId}
    className={cx(styles.switch, label != null && styles.withLabel, className)}
    onClick={() => onChange(!checked)}
  >
    <span className={cx(styles.track, checked && styles.on)}>
      <span className={styles.knob} />
    </span>
    {label != null && <span className={styles.label}>{label}</span>}
  </button>
)
