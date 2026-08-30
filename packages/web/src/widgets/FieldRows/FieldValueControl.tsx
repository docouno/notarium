import { useEffect, useRef, useState } from 'react'
import type { FieldDeclaration } from '@notarium/contract'
import { FIELD_TYPE } from '@notarium/contract/enums'
import { fieldValueMatchesType } from '@notarium/core'
import { Chip, ChipInput } from '../../core/Chips'
import { DatePicker } from '../../core/DatePicker'
import { IconX } from '../../core/Icons'
import { Select } from '../../core/Select'
import { Switch } from '../../core/Switch'
import { cx } from '../../libs/cx/cx'
import { exactDateTime, fieldDate, replaceCalendarDay } from '../../libs/datetime'
import { fieldEnumOptionDisplayName } from '../../libs/fields'
import styles from './FieldRows.module.scss'

export type EditableFieldValue = string | string[]

export const formatFieldValue = (value: unknown): string => {
  if (value == null) {
    return ''
  }
  if (Array.isArray(value)) {
    return value.map(formatFieldValue).join(', ')
  }
  if (typeof value === 'object') {
    return JSON.stringify(value)
  }

  return String(value)
}

const displayFieldValue = (declaration: FieldDeclaration | undefined, value: unknown): string => {
  if (declaration?.type === FIELD_TYPE.enum && typeof value === 'string') {
    const option = declaration.values?.find((candidate) => candidate.key === value)

    if (option) {
      return fieldEnumOptionDisplayName(option)
    }
  }

  return formatFieldValue(value)
}

const TextValue = ({
  value,
  present,
  disabled,
  appearance,
  displayValue,
  title,
  ariaLabel,
  onRemove,
  removeLabel,
  onCommit,
  liveDraft,
  ariaDescribedBy,
  ariaInvalid,
}: {
  value: string
  present: boolean
  disabled: boolean
  appearance: 'inline' | 'form'
  displayValue?: string
  title?: string
  ariaLabel: string
  onRemove?: () => void
  removeLabel: string
  onCommit: (value: string) => void
  liveDraft: boolean
  ariaDescribedBy?: string
  ariaInvalid?: boolean
}) => {
  const [draft, setDraft] = useState(value)
  const [focused, setFocused] = useState(false)
  const cancelled = useRef(false)
  const focusSeed = useRef(value)

  useEffect(() => setDraft(value), [value])
  const commit = () => {
    if (cancelled.current) {
      cancelled.current = false
      return
    }
    if (draft !== value) {
      onCommit(draft)
    }
  }

  return (
    <div
      className={cx(styles.inputShell, appearance === 'inline' && styles.inlineInputShell)}
      data-testid="field-control-shell"
    >
      <input
        className={styles.input}
        value={
          appearance === 'inline' && !focused && displayValue !== undefined ? displayValue : draft
        }
        disabled={disabled}
        placeholder={appearance === 'inline' ? '—' : present ? 'Empty value' : 'Not set'}
        title={title}
        aria-label={ariaLabel}
        aria-describedby={ariaDescribedBy}
        aria-invalid={ariaInvalid || undefined}
        onFocus={() => {
          focusSeed.current = value
          setFocused(true)
        }}
        onChange={(event) => {
          const next = event.target.value
          setDraft(next)
          if (liveDraft) {
            onCommit(next)
          }
        }}
        onBlur={() => {
          setFocused(false)
          commit()
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.currentTarget.blur()
          } else if (event.key === 'Escape') {
            event.preventDefault()
            cancelled.current = true
            setDraft(focusSeed.current)
            if (liveDraft) {
              onCommit(focusSeed.current)
            }
            event.currentTarget.blur()
          }
        }}
      />
      {onRemove && (
        <button
          type="button"
          className={styles.valueClear}
          disabled={disabled}
          aria-label={removeLabel}
          onMouseDown={(event) => event.preventDefault()}
          onClick={onRemove}
        >
          <IconX size={13} />
        </button>
      )}
    </div>
  )
}

export const FieldValueControl = ({
  declaration,
  fieldLabel,
  value,
  present,
  unreadable,
  readOnly,
  appearance = 'read',
  showDateIcon = true,
  disabled,
  onChange,
  liveDraft = false,
  onPendingChange,
  ariaDescribedBy,
  ariaInvalid,
}: {
  declaration?: FieldDeclaration
  fieldLabel: string
  value?: unknown
  present: boolean
  unreadable: boolean
  readOnly: boolean
  appearance?: 'read' | 'inline' | 'form'
  showDateIcon?: boolean
  disabled: boolean
  onChange: (value: EditableFieldValue | null) => void
  liveDraft?: boolean
  onPendingChange?: (value: string) => void
  ariaDescribedBy?: string
  ariaInvalid?: boolean
}) => {
  if (unreadable) {
    return <span className={cx(styles.unreadable, styles.alignedText)}>Unreadable value</span>
  }
  const editable = typeof value === 'string' || Array.isArray(value) || !present
  const projected = Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : typeof value === 'string'
      ? value
      : ''
  const empty =
    present &&
    ((typeof projected === 'string' && projected === '') ||
      (Array.isArray(projected) && projected.length === 0))
  const matches =
    !declaration ||
    !present ||
    empty ||
    (editable && fieldValueMatchesType(declaration.type, projected, declaration))
  const mismatch = declaration && present && !matches
  const controlAppearance = appearance === 'inline' ? 'inline' : 'form'
  const inline = appearance === 'inline'
  const removeLabel = `Remove ${fieldLabel}`
  const accessibleValue = present ? displayFieldValue(declaration, projected) : ''

  if (readOnly && (!present || empty)) {
    return <span className={cx(styles.muted, styles.alignedText)}>—</span>
  }

  if (readOnly || !editable) {
    const option =
      declaration?.type === FIELD_TYPE.enum && typeof value === 'string'
        ? declaration.values?.find((candidate) => candidate.key === value)
        : undefined

    if (option) {
      return (
        <Chip color={option.color} className={styles.alignedPlate} testId="field-enum-chip">
          {fieldEnumOptionDisplayName(option)}
        </Chip>
      )
    }
    if (declaration?.type === FIELD_TYPE.checkbox && !mismatch && typeof value === 'string') {
      return (
        <Switch
          checked={value === 'true'}
          onChange={() => undefined}
          disabled
          className={cx(styles.inlineSwitch, styles.alignedPlate)}
          aria-label={`${declaration.label ?? declaration.key} value`}
        />
      )
    }
    if (declaration?.type === FIELD_TYPE.date && !mismatch && typeof value === 'string') {
      return (
        <span
          className={cx(styles.extraValue, styles.alignedText)}
          title={value.includes('T') ? exactDateTime(value) : undefined}
        >
          {fieldDate(value) || value}
        </span>
      )
    }

    return (
      <span className={cx(styles.extraValue, styles.alignedText)}>
        {!present ? '—' : displayFieldValue(declaration, value) || '—'}
      </span>
    )
  }
  if (mismatch) {
    return (
      <TextValue
        value={formatFieldValue(value)}
        present
        disabled={disabled}
        appearance={controlAppearance}
        onRemove={present ? () => onChange(null) : undefined}
        removeLabel={removeLabel}
        ariaLabel={`${fieldLabel} value`}
        onCommit={onChange}
        liveDraft={liveDraft}
        ariaDescribedBy={ariaDescribedBy}
        ariaInvalid={ariaInvalid}
      />
    )
  }
  if (!declaration) {
    return Array.isArray(projected) ? (
      <ChipInput
        values={projected}
        onChange={onChange}
        disabled={disabled}
        placeholder={inline ? '—' : 'Add values…'}
        populatedPlaceholder={inline ? '' : 'Add values…'}
        appearance={inline ? 'quiet' : 'default'}
        onClear={present ? () => onChange(null) : undefined}
        clearLabel={removeLabel}
        removeAriaLabel={(item) => `Remove ${item} from ${fieldLabel}`}
        inputAriaLabel={`${fieldLabel} value`}
        onPendingChange={onPendingChange}
        commitOnComma={false}
        trimValues={false}
      />
    ) : (
      <TextValue
        value={projected}
        present={present}
        disabled={disabled}
        appearance={controlAppearance}
        onRemove={present ? () => onChange(null) : undefined}
        removeLabel={removeLabel}
        ariaLabel={`${fieldLabel} value`}
        onCommit={onChange}
        liveDraft={liveDraft}
      />
    )
  }

  switch (declaration.type) {
    case FIELD_TYPE.list:
      return (
        <ChipInput
          values={Array.isArray(projected) ? projected : present ? [projected] : []}
          onChange={onChange}
          disabled={disabled}
          placeholder={inline ? '—' : 'Add values…'}
          populatedPlaceholder={inline ? '' : 'Add values…'}
          appearance={inline ? 'quiet' : 'default'}
          onClear={present ? () => onChange(null) : undefined}
          clearLabel={removeLabel}
          removeAriaLabel={(item) => `Remove ${item} from ${fieldLabel}`}
          inputAriaLabel={`${fieldLabel} value`}
          onPendingChange={onPendingChange}
          commitOnComma={false}
          trimValues={false}
        />
      )
    case FIELD_TYPE.enum:
      return (
        <Select
          value={present && typeof projected === 'string' ? projected : undefined}
          options={(declaration.values ?? []).map((candidate) => ({
            value: candidate.key,
            label: fieldEnumOptionDisplayName(candidate),
            color: candidate.color,
          }))}
          placeholder={inline ? '—' : 'Not set'}
          clearLabel="None"
          onClear={present ? () => onChange(null) : undefined}
          onChange={onChange}
          disabled={disabled}
          className={inline ? styles.alignedPlate : undefined}
          appearance={inline ? 'quiet' : 'default'}
          aria-label={`${fieldLabel} value${accessibleValue ? `: ${accessibleValue}` : ''}`}
          showSelectedSwatch={!inline}
        />
      )
    case FIELD_TYPE.checkbox:
      return (
        <span className={cx(styles.switchShell, inline && styles.alignedPlate)}>
          <Switch
            checked={projected === 'true'}
            onChange={(checked) => onChange(checked ? 'true' : 'false')}
            disabled={disabled}
            className={inline ? styles.inlineSwitch : undefined}
            aria-label={`${declaration.label ?? declaration.key} value: ${projected === 'true' ? 'On' : 'Off'}`}
          />
          {present && (
            <button
              type="button"
              className={cx(styles.valueClear, inline && styles.quietClear)}
              disabled={disabled}
              aria-label={removeLabel}
              onClick={() => onChange(null)}
            >
              <IconX size={13} />
            </button>
          )}
        </span>
      )
    case FIELD_TYPE.date: {
      const authored = String(projected)
      const dateLabel = fieldDate(authored) || authored

      return (
        <DatePicker
          value={authored.slice(0, 10)}
          onChange={(day) => onChange(replaceCalendarDay(authored, day))}
          onClear={present ? () => onChange(null) : undefined}
          placeholder={inline ? '—' : present ? 'Empty value' : 'Not set'}
          disabled={disabled}
          icon={showDateIcon}
          appearance={inline ? 'quiet' : 'default'}
          aria-label={`${fieldLabel} value${dateLabel ? `: ${dateLabel}` : ''}`}
        />
      )
    }
    case FIELD_TYPE.text:
    case FIELD_TYPE.number:
      return (
        <TextValue
          value={String(projected)}
          present={present}
          disabled={disabled}
          appearance={controlAppearance}
          onRemove={present ? () => onChange(null) : undefined}
          removeLabel={removeLabel}
          ariaLabel={`${fieldLabel} value`}
          onCommit={onChange}
          liveDraft={liveDraft}
          ariaDescribedBy={ariaDescribedBy}
          ariaInvalid={ariaInvalid}
        />
      )
  }
}

export const fieldValueMismatch = (
  declaration: FieldDeclaration | undefined,
  value: unknown,
  present: boolean,
): boolean =>
  Boolean(
    declaration &&
    present &&
    value !== '' &&
    !(Array.isArray(value) && value.length === 0) &&
    !(
      (typeof value === 'string' ||
        (Array.isArray(value) && value.every((item) => typeof item === 'string'))) &&
      fieldValueMatchesType(declaration.type, value as string | string[], declaration)
    ),
  )
