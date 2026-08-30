import { type MouseEvent as ReactMouseEvent, useRef, useState } from 'react'
import { cx } from '../../libs/cx/cx'
import { absoluteDate } from '../../libs/datetime'
import { IconCalendar, IconX } from '../Icons'
import { CalendarPopover } from './CalendarPopover'
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
  /** Explicit removal capability. Omit for required/system dates. */
  onClear?: () => void
  /** Earliest selectable day as `YYYY-MM-DD`; invalid/absent = unbounded. */
  min?: string
  /** Latest selectable day as `YYYY-MM-DD`; invalid/absent = unbounded. */
  max?: string
  placeholder?: string
  disabled?: boolean
  className?: string
  icon?: boolean
  appearance?: 'default' | 'quiet'
  'aria-label'?: string
  'data-testid'?: string
}

export const DatePicker = ({
  value,
  onChange,
  onClear,
  min,
  max,
  placeholder = 'Pick a date',
  disabled = false,
  className,
  icon = true,
  appearance = 'default',
  'aria-label': ariaLabel,
  'data-testid': testId,
}: DatePickerProps) => {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const label = absoluteDate(value) || null

  const openMenu = () => {
    if (!disabled) {
      setOpen(true)
    }
  }

  const clear = (e: ReactMouseEvent) => {
    e.stopPropagation()
    onClear?.()
  }
  const clearLabel = `Clear ${ariaLabel ?? 'date'}`

  return (
    <>
      <div
        className={cx(
          styles.picker,
          onClear && styles.hasValue,
          appearance === 'quiet' && styles.quiet,
          disabled && styles.disabled,
          className,
        )}
      >
        <button
          ref={triggerRef}
          type="button"
          className={styles.trigger}
          disabled={disabled}
          aria-label={ariaLabel}
          aria-haspopup="dialog"
          aria-expanded={open}
          data-testid={testId}
          onClick={() => (open ? setOpen(false) : openMenu())}
        >
          {icon && (
            <span className={styles.triggerIcon}>
              <IconCalendar size={14} />
            </span>
          )}
          <span className={cx(styles.triggerLabel, !label && styles.placeholder)}>
            {label ?? placeholder}
          </span>
        </button>
        {onClear && !disabled && (
          <button
            type="button"
            className={styles.clear}
            aria-label={clearLabel}
            onMouseDown={(e) => e.preventDefault()}
            onClick={clear}
          >
            <IconX size={13} />
          </button>
        )}
      </div>
      {open && (
        <CalendarPopover
          value={value}
          min={min}
          max={max}
          anchor={triggerRef}
          onPick={(v) => {
            onChange(v)
            setOpen(false)
            queueMicrotask(() => triggerRef.current?.focus())
          }}
          onClose={(restoreFocus) => {
            setOpen(false)
            if (restoreFocus) {
              queueMicrotask(() => triggerRef.current?.focus())
            }
          }}
        />
      )}
    </>
  )
}
