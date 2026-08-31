import { type KeyboardEvent, type ReactNode, useRef } from 'react'
import { cx } from '../../libs/cx/cx'
import styles from './Tabs.module.scss'

export type TabOption<T extends string> = {
  value: T
  label: string
  disabled?: boolean
  badge?: ReactNode
  id?: string
  panelId?: string
  testId?: string
}

export const Tabs = <T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  panelId,
  variant = 'content',
  className,
}: {
  value: T
  options: readonly TabOption<T>[]
  onChange: (value: T) => void
  ariaLabel: string
  panelId?: string
  variant?: 'content' | 'header'
  className?: string
}) => {
  const refs = useRef(new Map<T, HTMLButtonElement>())
  const enabled = options.filter((option) => !option.disabled)

  const move = (current: T, event: KeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || enabled.length === 0) {
      return
    }
    event.preventDefault()
    const currentIndex = Math.max(
      0,
      enabled.findIndex((option) => option.value === current),
    )
    const next =
      event.key === 'Home'
        ? enabled[0]
        : event.key === 'End'
          ? enabled.at(-1)
          : enabled[
              (currentIndex + (event.key === 'ArrowLeft' ? -1 : 1) + enabled.length) %
                enabled.length
            ]

    if (next) {
      onChange(next.value)
      refs.current.get(next.value)?.focus()
    }
  }

  return (
    <div
      className={cx(styles.tabs, variant === 'header' && styles.header, className)}
      role="tablist"
      aria-label={ariaLabel}
      aria-orientation="horizontal"
    >
      {options.map((option) => {
        const active = option.value === value

        return (
          <button
            key={option.value}
            ref={(element) => {
              if (element) {
                refs.current.set(option.value, element)
              } else {
                refs.current.delete(option.value)
              }
            }}
            type="button"
            id={option.id}
            role="tab"
            aria-selected={active}
            aria-controls={option.panelId ?? panelId}
            tabIndex={active ? 0 : -1}
            disabled={option.disabled}
            className={styles.tab}
            data-testid={option.testId}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => move(option.value, event)}
          >
            {option.label}
            {option.badge != null ? <span className={styles.badge}>{option.badge}</span> : null}
          </button>
        )
      })}
    </div>
  )
}
