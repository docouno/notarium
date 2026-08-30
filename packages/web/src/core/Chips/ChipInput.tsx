import { type KeyboardEvent as ReactKeyboardEvent, useState } from 'react'
import { cx } from '../../libs/cx/cx'
import { IconX } from '../Icons'
import { RemovableChip } from './Chips'
import styles from './Chips.module.scss'

export const ChipInput = ({
  values,
  onChange,
  inputId,
  inputAriaLabel,
  placeholder = 'Add value…',
  populatedPlaceholder = placeholder,
  disabled = false,
  dedupe = false,
  tag = false,
  onClear,
  onPendingChange,
  commitOnComma = true,
  trimValues = true,
  clearLabel = 'Remove value',
  removeAriaLabel,
  className,
  appearance = 'default',
  testId,
}: {
  values: readonly string[]
  onChange: (values: string[]) => void
  inputId?: string
  inputAriaLabel?: string
  placeholder?: string
  populatedPlaceholder?: string
  disabled?: boolean
  dedupe?: boolean
  tag?: boolean
  onClear?: () => void
  /** Reports the normalized value still being typed but not yet committed as a chip. */
  onPendingChange?: (value: string) => void
  commitOnComma?: boolean
  trimValues?: boolean
  clearLabel?: string
  removeAriaLabel?: (value: string, index: number) => string
  className?: string
  appearance?: 'default' | 'quiet'
  testId?: string
}) => {
  const [text, setText] = useState('')
  const normalized = (value: string) => (trimValues ? value.trim().replace(/,$/, '').trim() : value)

  const setPendingText = (value: string) => {
    setText(value)
    onPendingChange?.(normalized(value))
  }

  const add = (raw: string) => {
    const value = normalized(raw)

    if (!value || (dedupe && values.includes(value))) {
      setPendingText('')
      return
    }
    onChange([...values, value])
    setPendingText('')
  }

  const removeAt = (index: number) => {
    if (!disabled) {
      onChange(values.filter((_, current) => current !== index))
    }
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' || (commitOnComma && event.key === ',')) {
      event.preventDefault()
      add(text)
    } else if (event.key === 'Backspace' && text === '' && values.length) {
      removeAt(values.length - 1)
    }
  }

  return (
    <div
      className={cx(
        styles.chipInput,
        appearance === 'quiet' && styles.quiet,
        disabled && styles.disabled,
        className,
      )}
      data-testid={testId}
      data-empty={values.length === 0 || undefined}
      onClick={(event) => {
        if (!disabled) {
          event.currentTarget.querySelector('input')?.focus()
        }
      }}
    >
      {values.map((value, index) => (
        <RemovableChip
          key={`${value}:${index}`}
          value={value}
          prefix={tag ? '#' : undefined}
          tag={tag}
          disabled={disabled}
          removeAriaLabel={removeAriaLabel?.(value, index)}
          onRemove={() => removeAt(index)}
        />
      ))}
      <input
        id={inputId}
        aria-label={inputAriaLabel}
        value={text}
        disabled={disabled}
        onChange={(event) => setPendingText(event.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => add(text)}
        placeholder={values.length ? populatedPlaceholder : placeholder}
        spellCheck={false}
      />
      {onClear && (
        <button
          type="button"
          className={styles.inputClear}
          disabled={disabled}
          aria-label={clearLabel}
          onMouseDown={(event) => event.preventDefault()}
          onClick={(event) => {
            event.stopPropagation()
            setPendingText('')
            onClear()
          }}
        >
          <IconX size={13} />
        </button>
      )}
    </div>
  )
}
