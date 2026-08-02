import { type MouseEvent as ReactMouseEvent, useRef, useState } from 'react'
import { cx } from '../../libs/cx/cx'
import { IconCalendar, IconX } from '../Icons'
import { CalendarPopover } from './CalendarPopover'
import { displayLabel } from './helpers/calendarGrid'
import styles from './DatePicker.module.scss'

// A calendar date picker — a calendar-day value chosen from a popover month grid.
// NOT a native `<input type="date">`: the native control's chrome (the spinner, the
// OS calendar dropdown) can't be themed and looks foreign in the app. So the trigger
// wears the app's input chrome and the calendar is a real popover (portal into
// <body>, fixed-positioned at the trigger, `glass-float` material, outside-click/Esc
// dismiss — same machinery as ContextMenu/Select). Dependency-free.
//
// The value is a calendar day as `YYYY-MM-DD` (local), '' = unset. Decoupled from any
// instant on purpose: callers that store a timestamp convert at their own edge (e.g.
// EditorMeta builds local-midnight ISO from this, #186). Controlled.

type DatePickerProps = {
  /** The selected day as `YYYY-MM-DD`; '' = unset. */
  value: string
  onChange: (value: string) => void
  /** Earliest selectable day as `YYYY-MM-DD`; invalid/absent = unbounded. */
  min?: string
  /** Latest selectable day as `YYYY-MM-DD`; invalid/absent = unbounded. */
  max?: string
  placeholder?: string
  disabled?: boolean
  className?: string
  'aria-label'?: string
  'data-testid'?: string
}

export const DatePicker = ({
  value,
  onChange,
  min,
  max,
  placeholder = 'Pick a date',
  disabled = false,
  className,
  'aria-label': ariaLabel,
  'data-testid': testId,
}: DatePickerProps) => {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const label = displayLabel(value)

  const openMenu = () => {
    if (!disabled) {
      setOpen(true)
    }
  }

  const clear = (e: ReactMouseEvent) => {
    e.stopPropagation()
    onChange('')
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={cx(styles.trigger, disabled && styles.disabled, className)}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid={testId}
        onClick={() => (open ? setOpen(false) : openMenu())}
      >
        <span className={styles.triggerIcon}>
          <IconCalendar size={14} />
        </span>
        <span className={cx(styles.triggerLabel, !label && styles.placeholder)}>
          {label ?? placeholder}
        </span>
        {label && !disabled && (
          <span
            className={styles.clear}
            role="button"
            tabIndex={-1}
            aria-label="Clear date"
            onMouseDown={(e) => e.preventDefault()}
            onClick={clear}
          >
            <IconX size={13} />
          </span>
        )}
      </button>
      {open && (
        <CalendarPopover
          value={value}
          min={min}
          max={max}
          anchor={triggerRef}
          onPick={(v) => {
            onChange(v)
            setOpen(false)
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}
