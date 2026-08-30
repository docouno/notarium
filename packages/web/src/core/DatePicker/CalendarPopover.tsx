import {
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { cx } from '../../libs/cx/cx'
import { absoluteDate } from '../../libs/datetime'
import { useDismiss } from '../../libs/hooks/useDismiss'
import { IconChevronLeft, IconChevronRight } from '../Icons'
import { MONTHS, MONTHS_SHORT, WEEKDAYS, YEARS_PER_PAGE } from './consts'
import { dayCells, daysInMonthOf, fromKey, toKey, yearsStart } from './helpers/calendarGrid'
import {
  boundsOf,
  canStep,
  clampKey,
  dayAllowed,
  monthAllowed,
  yearAllowed,
  yearPageAllowed,
} from './helpers/dateBounds'
import styles from './DatePicker.module.scss'

export const CalendarPopover = ({
  value,
  min,
  max,
  anchor,
  onPick,
  onClose,
}: {
  value: string
  min?: string
  max?: string
  anchor: RefObject<HTMLButtonElement | null>
  onPick: (value: string) => void
  onClose: (restoreFocus?: boolean) => void
}) => {
  const ref = useRef<HTMLDivElement>(null)
  const bounds = boundsOf(min, max)
  const selected = fromKey(value)
  const today = new Date()
  const todayKey = toKey(today.getFullYear(), today.getMonth(), today.getDate())
  const seedKey = selected ? toKey(selected.y, selected.m, selected.d) : clampKey(todayKey, bounds)
  const seed = fromKey(seedKey) ?? {
    y: today.getFullYear(),
    m: today.getMonth(),
    d: today.getDate(),
  }

  // The month on screen, the keyboard-focused day, and which panel is showing.
  // Clicking the header label zooms OUT (days → months → years) so a far-off year is
  // two clicks away instead of paging month-by-month; picking zooms back in.
  const [view, setView] = useState(() => ({ y: seed.y, m: seed.m }))
  const [focus, setFocus] = useState(() => seed.d)
  const [mode, setMode] = useState<'days' | 'months' | 'years'>('days')
  // The keyboard-focus ring shows ONLY while navigating by keyboard — otherwise a
  // mouse user paging months would see a stray accent ring left on the focused day
  // (read as a second selection). Cleared on any pointer move so all three panels
  // read identically to the mouse: just the selected day + today.
  const [kbd, setKbd] = useState(false)

  const [pos, setPos] = useState<{ left: number; top: number }>({ left: 0, top: 0 })
  useLayoutEffect(() => {
    const a = anchor.current?.getBoundingClientRect()
    const el = ref.current

    if (!a || !el) {
      return
    }
    const gap = 6
    const { width, height } = el.getBoundingClientRect()
    const left = Math.max(8, Math.min(a.left, window.innerWidth - width - 8))
    // Below the trigger, flipping above when there's no room beneath.
    const below = a.bottom + gap
    const top = below + height + 8 <= window.innerHeight ? below : Math.max(8, a.top - gap - height)
    setPos({ left, top })
  }, [anchor, view, mode])

  useDismiss(true, () => onClose(false), { inside: [ref, anchor], viewport: true })

  // Focus the roving day itself so assistive technology announces every arrow move.
  useLayoutEffect(() => {
    if (mode !== 'days') {
      return
    }
    const key = toKey(view.y, view.m, focus)
    ref.current?.querySelector<HTMLButtonElement>(`[data-calendar-day="${key}"]`)?.focus()
  }, [focus, mode, view.m, view.y])

  useLayoutEffect(() => {
    if (mode === 'months') {
      const preferred = ref.current?.querySelector<HTMLButtonElement>(
        `[data-calendar-month="${view.m}"]`,
      )
      ;(preferred?.disabled
        ? ref.current?.querySelector<HTMLButtonElement>('[data-calendar-month]:not(:disabled)')
        : preferred
      )?.focus()
    } else if (mode === 'years') {
      const preferred = ref.current?.querySelector<HTMLButtonElement>(
        `[data-calendar-year="${view.y}"]`,
      )
      ;(preferred?.disabled
        ? ref.current?.querySelector<HTMLButtonElement>('[data-calendar-year]:not(:disabled)')
        : preferred
      )?.focus()
    }
  }, [mode, view.m, view.y])

  const shiftMonth = (delta: number) => {
    const d = new Date(view.y, view.m + delta, 1)
    const next = { y: d.getFullYear(), m: d.getMonth() }

    if (!monthAllowed(next.y, next.m, bounds)) {
      return
    }
    setView(next)
    setFocus((cur) => Math.min(cur, daysInMonthOf(next.y, next.m)))
  }

  // The header's prev/next steps the unit the current panel shows: a month, a year,
  // or a 12-year page.
  const step = (dir: number) => {
    if (mode === 'days') {
      shiftMonth(dir)
    } else if (mode === 'months') {
      setView((v) => (yearAllowed(v.y + dir, bounds) ? { ...v, y: v.y + dir } : v))
    } else {
      setView((v) =>
        yearPageAllowed(v.y + dir * YEARS_PER_PAGE, bounds)
          ? { ...v, y: v.y + dir * YEARS_PER_PAGE }
          : v,
      )
    }
  }

  // Keyboard (days panel only): arrows move the focused day (crossing months shifts
  // the view), Enter/Space picks it, PageUp/Down jump a month. Escape → useDismiss.
  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (mode !== 'days') {
      return
    }
    const move = (delta: number) => {
      e.preventDefault()
      const d = new Date(view.y, view.m, focus + delta)
      const key = toKey(d.getFullYear(), d.getMonth(), d.getDate())

      if (!dayAllowed(key, bounds)) {
        return
      }
      setKbd(true)
      setView({ y: d.getFullYear(), m: d.getMonth() })
      setFocus(d.getDate())
    }

    if (e.key === 'ArrowLeft') {
      move(-1)
    } else if (e.key === 'ArrowRight') {
      move(1)
    } else if (e.key === 'ArrowUp') {
      move(-7)
    } else if (e.key === 'ArrowDown') {
      move(7)
    } else if (e.key === 'PageUp') {
      e.preventDefault()
      shiftMonth(-1)
    } else if (e.key === 'PageDown') {
      e.preventDefault()
      shiftMonth(1)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose(true)
    } else if ((e.key === 'Enter' || e.key === ' ') && e.currentTarget === ref.current) {
      e.preventDefault()
      const key = toKey(view.y, view.m, focus)

      if (dayAllowed(key, bounds)) {
        onPick(key)
      }
    }
  }

  const headLabel =
    mode === 'days'
      ? `${MONTHS[view.m]} ${view.y}`
      : mode === 'months'
        ? `${view.y}`
        : `${yearsStart(view.y)} – ${yearsStart(view.y) + YEARS_PER_PAGE - 1}`
  const prevDisabled = !canStep(view, mode, -1, bounds)
  const nextDisabled = !canStep(view, mode, 1, bounds)
  // Clicking the label zooms out one level; from years it collapses back to days.
  const zoomOut = () =>
    setMode((m) => (m === 'days' ? 'months' : m === 'months' ? 'years' : 'days'))

  return createPortal(
    <div
      ref={ref}
      className={cx(styles.popover, 'glass', 'glass-float')}
      style={{ left: pos.left, top: pos.top }}
      role="dialog"
      aria-label="Choose date"
      tabIndex={-1}
      onKeyDownCapture={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          onClose(true)
        } else if (event.key === 'Tab') {
          const focusable = [
            ...(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled)') ?? []),
          ]
          const first = focusable[0]
          const last = focusable.at(-1)

          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault()
            last?.focus()
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first?.focus()
          }
        }
      }}
      onKeyDown={(event) => {
        if (event.target === event.currentTarget) {
          onKeyDown(event)
        }
      }}
      onMouseMove={() => {
        if (kbd) {
          setKbd(false)
        }
      }}
    >
      <div className={styles.head}>
        <button
          type="button"
          className={styles.navBtn}
          aria-label="Previous"
          disabled={prevDisabled}
          onClick={() => step(-1)}
        >
          <IconChevronLeft size={16} />
        </button>
        <button
          type="button"
          className={styles.monthLabel}
          onClick={zoomOut}
          aria-label="Switch view"
        >
          {headLabel}
        </button>
        <button
          type="button"
          className={styles.navBtn}
          aria-label="Next"
          disabled={nextDisabled}
          onClick={() => step(1)}
        >
          <IconChevronRight size={16} />
        </button>
      </div>

      {mode === 'days' && (
        <>
          <div className={styles.weekRow}>
            {WEEKDAYS.map((w) => (
              <span key={w} className={styles.weekday}>
                {w}
              </span>
            ))}
          </div>
          <div className={styles.grid} aria-label={`${MONTHS[view.m]} ${view.y}`}>
            {dayCells(view).map((c, i) => {
              const key = toKey(c.y, c.m, c.d)
              const blocked = !dayAllowed(key, bounds)
              return (
                <button
                  key={i}
                  type="button"
                  disabled={blocked}
                  tabIndex={c.inMonth && c.d === focus && !blocked ? 0 : -1}
                  data-calendar-day={key}
                  aria-label={absoluteDate(key)}
                  aria-pressed={key === value}
                  aria-current={key === todayKey ? 'date' : undefined}
                  className={cx(
                    styles.day,
                    !c.inMonth && styles.outside,
                    key === value && styles.selected,
                    key === todayKey && key !== value && styles.today,
                    kbd && c.inMonth && c.d === focus && styles.focused,
                    blocked && styles.blocked,
                  )}
                  onClick={() => {
                    if (!blocked) {
                      onPick(key)
                    }
                  }}
                  onKeyDown={onKeyDown}
                >
                  {c.d}
                </button>
              )
            })}
          </div>
        </>
      )}

      {mode === 'months' && (
        <div className={styles.panelGrid}>
          {MONTHS_SHORT.map((label, idx) => {
            const blocked = !monthAllowed(view.y, idx, bounds)
            return (
              <button
                key={label}
                type="button"
                disabled={blocked}
                tabIndex={blocked ? -1 : 0}
                data-calendar-month={idx}
                aria-pressed={selected?.y === view.y && selected?.m === idx}
                className={cx(
                  styles.cell,
                  selected?.y === view.y && selected?.m === idx && styles.selected,
                  today.getFullYear() === view.y &&
                    today.getMonth() === idx &&
                    !(selected?.y === view.y && selected?.m === idx) &&
                    styles.today,
                  blocked && styles.blocked,
                )}
                onClick={() => {
                  if (!blocked) {
                    setView((v) => ({ ...v, m: idx }))
                    setFocus((cur) => Math.min(cur, daysInMonthOf(view.y, idx)))
                    setMode('days')
                  }
                }}
              >
                {label}
              </button>
            )
          })}
        </div>
      )}

      {mode === 'years' && (
        <div className={styles.panelGrid}>
          {Array.from({ length: YEARS_PER_PAGE }, (_, i) => yearsStart(view.y) + i).map((yr) => {
            const blocked = !yearAllowed(yr, bounds)
            return (
              <button
                key={yr}
                type="button"
                disabled={blocked}
                tabIndex={blocked ? -1 : 0}
                data-calendar-year={yr}
                aria-pressed={selected?.y === yr}
                className={cx(
                  styles.cell,
                  selected?.y === yr && styles.selected,
                  today.getFullYear() === yr && selected?.y !== yr && styles.today,
                  blocked && styles.blocked,
                )}
                onClick={() => {
                  if (!blocked) {
                    setView((v) => ({ ...v, y: yr }))
                    setFocus((cur) => Math.min(cur, daysInMonthOf(yr, view.m)))
                    setMode('months')
                  }
                }}
              >
                {yr}
              </button>
            )
          })}
        </div>
      )}

      <div className={styles.footer}>
        <button
          type="button"
          className={styles.footBtn}
          disabled={!dayAllowed(todayKey, bounds)}
          onClick={() => {
            if (dayAllowed(todayKey, bounds)) {
              onPick(todayKey)
            }
          }}
        >
          Today
        </button>
      </div>
    </div>,
    document.body,
  )
}
