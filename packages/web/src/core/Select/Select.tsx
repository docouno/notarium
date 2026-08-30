import { type CSSProperties, useRef, useState } from 'react'
import type { FieldColor } from '@notarium/contract'
import { cx } from '../../libs/cx/cx'
import { ContextMenu, type MenuItem } from '../ContextMenu'
import { IconChevron } from '../Icons'
import styles from './Select.module.scss'

export type SelectOption<T extends string> = {
  value: T
  label: string
  color?: FieldColor
  /** Options carrying the same group are listed together under its caption, so the
   *  group name is stated once instead of being suffixed onto every label. */
  group?: string
}

type SelectProps<T extends string> = {
  value?: T
  onChange: (value: T) => void
  options: readonly SelectOption<T>[]
  placeholder?: string
  clearLabel?: string
  onClear?: () => void
  disabled?: boolean
  className?: string
  appearance?: 'default' | 'quiet'
  showSelectedSwatch?: boolean
  /** Raise the option list above modals — set when the Select lives inside a dialog
   *  (its ContextMenu list would otherwise portal below the modal). */
  elevated?: boolean
  'data-testid'?: string
  'aria-label'?: string
}

// A custom dropdown (#28). NOT a native <select>: `appearance:none` only strips
// the box arrow — the option list a native select pops up is drawn by the OS and
// can't be themed. So the trigger wears the app's input chrome and the list is a
// real popover (ContextMenu: portal, viewport-flip, outside-click/Esc dismiss,
// check-mark on the current value). Use it where a value is picked from a short,
// fixed enum inline in a form (e.g. a new member's role). For changing a value
// already shown in a table row, prefer a kebab menu so weighty changes can route
// through a confirm. Controlled.
export const Select = <T extends string = string>({
  value,
  onChange,
  options,
  placeholder = '',
  clearLabel,
  onClear,
  disabled = false,
  className,
  appearance = 'default',
  showSelectedSwatch = true,
  elevated = false,
  'data-testid': testId,
  'aria-label': ariaLabel,
}: SelectProps<T>) => {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; width: number } | null>(null)
  const selected = options.find((o) => o.value === value)
  const swatch = (color?: FieldColor) =>
    color ? (
      <span
        className={styles.swatch}
        style={{ '--select-solid': `var(--field-color-${color})` } as CSSProperties}
      />
    ) : undefined
  const items: MenuItem[] = []

  if (onClear) {
    items.push({
      label: clearLabel ?? placeholder,
      radioGroup: ariaLabel ?? 'Select option',
      active: value === undefined,
      onClick: onClear,
    })
  }
  options.forEach((option, index) => {
    if (option.group && option.group !== options[index - 1]?.group) {
      items.push({ heading: option.group })
    }
    items.push({
      label: option.label,
      icon: swatch(option.color),
      radioGroup: option.group ?? ariaLabel ?? 'Select option',
      active: option.value === value,
      onClick: () => onChange(option.value),
    })
  })

  const open = () => {
    if (disabled) {
      return
    }
    const r = triggerRef.current?.getBoundingClientRect()

    if (r) {
      setMenu({ x: r.left, y: r.bottom + 4, width: r.width })
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={cx(
          styles.trigger,
          appearance === 'quiet' && styles.quiet,
          disabled && styles.disabled,
          className,
        )}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={menu != null}
        data-testid={testId}
        style={
          selected?.color
            ? ({
                '--select-solid': `var(--field-color-${selected.color})`,
                '--select-fg': `var(--field-color-${selected.color}-fg)`,
                '--select-surface': `var(--field-color-${selected.color}-surface)`,
                '--select-border': `var(--field-color-${selected.color}-border)`,
              } as CSSProperties)
            : undefined
        }
        onClick={() => (menu ? setMenu(null) : open())}
      >
        <span className={styles.value}>
          {showSelectedSwatch && swatch(selected?.color)}
          <span>{selected?.label ?? placeholder}</span>
        </span>
        <IconChevron size={14} className={cx(styles.chevron, menu && styles.open)} />
      </button>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          minWidth={menu.width}
          elevated={elevated}
          ignoreRef={triggerRef}
          items={items}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  )
}
