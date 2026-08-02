import { forwardRef, type InputHTMLAttributes, type KeyboardEvent } from 'react'
import { cx } from '../../libs/cx/cx'
import { IconSearch, IconX } from '../Icons'
import styles from './SearchField.module.scss'

// The shared search-input SHELL (#190): a bordered field with the leading search
// glyph and a trailing clear button. Presentational only — it owns no state and
// no behaviour, so the same chrome serves the topbar OmniSearch (global search +
// quick-jump) AND the Trash's local filter, which look identical by construction
// (the #190 brief: Trash must match the cross-cutting search exactly, while its
// function stays local). Width/placement come from the caller's `className`.

type SearchFieldProps = {
  value: string
  onChange: (value: string) => void
  /** Render the clear (×) button when there's a value; omit to hide it. */
  onClear?: () => void
  placeholder?: string
  className?: string
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void
  onFocus?: () => void
  /** Escape hatch for a11y/test wiring (aria-label, data-testid, role…). The
   *  `data-*` keys are admitted explicitly — a plain object literal doesn't get
   *  JSX's data-attribute special-case. */
  inputProps?: InputHTMLAttributes<HTMLInputElement> & { [k: `data-${string}`]: string | undefined }
}

export const SearchField = forwardRef<HTMLInputElement, SearchFieldProps>(
  ({ value, onChange, onClear, placeholder, className, onKeyDown, onFocus, inputProps }, ref) => (
    <div className={cx(styles.field, className)}>
      <IconSearch size={15} className={styles.icon} />
      <input
        ref={ref}
        className={styles.input}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onFocus={onFocus}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        {...inputProps}
      />
      {value && onClear && (
        <button type="button" className={styles.clear} onClick={onClear} aria-label="Clear search">
          <IconX size={13} />
        </button>
      )}
    </div>
  ),
)
