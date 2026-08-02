import { useRef, useState } from 'react'
import { cx } from '../../libs/cx/cx'
import { ContextMenu } from '../ContextMenu'
import { IconChevron } from '../Icons'
import styles from './Select.module.scss'

type SelectOption<T extends string> = {
  value: T
  label: string
}

type SelectProps<T extends string> = {
  value: T
  onChange: (value: T) => void
  options: SelectOption<T>[]
  disabled?: boolean
  className?: string
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
  disabled = false,
  className,
  elevated = false,
  'data-testid': testId,
  'aria-label': ariaLabel,
}: SelectProps<T>) => {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; width: number } | null>(null)
  const selected = options.find((o) => o.value === value)

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
        className={cx(styles.trigger, disabled && styles.disabled, className)}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={menu != null}
        data-testid={testId}
        onClick={() => (menu ? setMenu(null) : open())}
      >
        <span className={styles.value}>{selected?.label ?? ''}</span>
        <IconChevron size={14} className={cx(styles.chevron, menu && styles.open)} />
      </button>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          minWidth={menu.width}
          elevated={elevated}
          ignoreRef={triggerRef}
          items={options.map((o) => ({
            label: o.label,
            active: o.value === value,
            onClick: () => onChange(o.value),
          }))}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  )
}
