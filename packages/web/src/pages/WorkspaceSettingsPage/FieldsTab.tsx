import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { FieldDeclaration, FieldEnumOption, FieldType } from '@notarium/contract'
import {
  FIELD_COLOR,
  FIELD_SCHEMA_MAX_FIELDS,
  FIELD_SCHEMA_MAX_VALUES,
  FIELD_TYPE,
  PROTECTED_FIELD_KEYS,
} from '@notarium/contract/enums'
import { isWritableFieldKey, normalizeFieldDisplayName, slugify, uniqueSlug } from '@notarium/core'

import { useFeed } from '../../composers/FeedProvider'
import { useFieldSchema } from '../../composers/FieldSchemaProvider'
import { useSpace } from '../../composers/SpaceProvider'
import { Button } from '../../core/Button'
import { Checkbox } from '../../core/Checkbox'
import { Chip } from '../../core/Chips'
import { ContextMenu, type MenuItem } from '../../core/ContextMenu'
import { useDialog } from '../../core/Dialog'
import { DisclosureCard } from '../../core/DisclosureCard'
import { EmptyState } from '../../core/EmptyState'
import { IconGrip, IconMore, IconPlus, IconRefresh, IconTrash } from '../../core/Icons'
import { Notice } from '../../core/Notice'
import { Select } from '../../core/Select'
import { SettingsSection } from '../../core/SettingsSection'
import { Skeleton } from '../../core/Skeleton'
import { StickyBar } from '../../core/StickyBar'
import { useToast } from '../../core/Toast'
import { usePageFrameScroll } from '../../layouts/PageFrame'
import { type ReorderHandle, useReorder } from '../../libs/dnd/reorder'
import { fieldDisplayName, fieldEnumOptionDisplayName } from '../../libs/fields'
import type { ApiError } from '../../services/api'
import styles from './FieldsTab.module.scss'

type DraftEnumOption = FieldEnumOption & {
  id: string
  persisted: boolean
  labelTouched?: boolean
}

type DraftField = Omit<FieldDeclaration, 'values'> & {
  id: string
  persistedKey?: string
  persistedType?: FieldType
  labelTouched?: boolean
  values?: DraftEnumOption[]
}

type DraftState = {
  space: string
  revision: string
  fields: DraftField[]
  base: FieldDeclaration[]
}

type DraftValidation = {
  fieldErrors: ReadonlyMap<string, string>
  valueErrors: ReadonlyMap<string, string>
  valid: boolean
}

let draftId = 0
const nextDraftId = (kind: 'field' | 'value') => `${kind}-${++draftId}`
const protectedKeys = new Set<string>(PROTECTED_FIELD_KEYS)
const fieldColors = Object.values(FIELD_COLOR)

const TYPE_OPTIONS = [
  { value: FIELD_TYPE.text, label: 'Text' },
  { value: FIELD_TYPE.number, label: 'Number' },
  { value: FIELD_TYPE.date, label: 'Date' },
  { value: FIELD_TYPE.checkbox, label: 'Checkbox' },
  { value: FIELD_TYPE.list, label: 'List' },
  { value: FIELD_TYPE.enum, label: 'Enum' },
]

const TYPE_LABEL: Record<FieldType, string> = Object.fromEntries(
  TYPE_OPTIONS.map((option) => [option.value, option.label]),
) as Record<FieldType, string>

const generatedFieldKey = (
  name: string,
  fields: readonly DraftField[],
  fieldId: string,
): string => {
  const taken = new Set(
    fields.filter((field) => field.id !== fieldId).map((field) => field.key.toLocaleLowerCase()),
  )

  for (const key of protectedKeys) {
    taken.add(key.toLocaleLowerCase())
  }

  return uniqueSlug(slugify(name) || 'field', (candidate) => {
    return !taken.has(candidate.toLocaleLowerCase()) && isWritableFieldKey(candidate)
  })
}

const generatedEnumValueKey = (
  name: string,
  values: readonly DraftEnumOption[],
  valueId: string,
): string => {
  const taken = new Set(
    values.filter((value) => value.id !== valueId).map((value) => value.key.toLocaleLowerCase()),
  )

  return uniqueSlug(slugify(name) || 'value', (candidate) => {
    return !taken.has(candidate.toLocaleLowerCase())
  })
}

const canonicalField = (field: FieldDeclaration): FieldDeclaration => ({
  key: field.key,
  type: field.type,
  ...(field.label?.trim() ? { label: field.label.trim() } : {}),
  ...(field.card ? { card: true } : {}),
  ...(field.type === FIELD_TYPE.enum && field.values !== undefined
    ? {
        values: field.values.map((value) => ({
          key: value.key,
          ...(value.label?.trim() ? { label: value.label.trim() } : {}),
          ...(value.color ? { color: value.color } : {}),
        })),
      }
    : {}),
})

const canonicalFields = (fields: readonly FieldDeclaration[]): FieldDeclaration[] =>
  fields.map(canonicalField)

const draftFields = (fields: readonly FieldDeclaration[]): DraftField[] =>
  canonicalFields(fields).map((field) => {
    const { values, ...declaration } = field

    return {
      ...declaration,
      id: nextDraftId('field'),
      persistedKey: field.key,
      persistedType: field.type,
      ...(values !== undefined
        ? {
            values: values.map((value) => ({
              ...value,
              id: nextDraftId('value'),
              persisted: true,
            })),
          }
        : {}),
    }
  })

const acknowledgeSavedIdentities = (
  current: readonly DraftField[],
  submitted: readonly DraftField[],
  saved: readonly FieldDeclaration[],
): DraftField[] => {
  const submittedById = new Map(submitted.map((field) => [field.id, field]))
  const savedByKey = new Map(saved.map((field) => [field.key, field]))

  return current.map((field) => {
    const sent = submittedById.get(field.id)
    const acknowledged = sent ? savedByKey.get(sent.key) : undefined

    if (!sent || !acknowledged) {
      return field
    }
    const sentValuesById = new Map((sent.values ?? []).map((value) => [value.id, value]))
    const acknowledgedValueKeys = new Set((acknowledged.values ?? []).map((value) => value.key))

    return {
      ...field,
      key: acknowledged.key,
      persistedKey: acknowledged.key,
      persistedType: acknowledged.type,
      ...(field.values
        ? {
            values: field.values.map((value) => {
              const sentValue = sentValuesById.get(value.id)

              return sentValue && acknowledgedValueKeys.has(sentValue.key)
                ? { ...value, key: sentValue.key, persisted: true }
                : value
            }),
          }
        : {}),
    }
  })
}

const wireFields = (fields: readonly DraftField[]): FieldDeclaration[] =>
  canonicalFields(
    fields.map((field) => ({
      key: field.key,
      type: field.type,
      label: field.label,
      card: field.card,
      ...(field.values !== undefined
        ? {
            values: field.values.map(({ key, label, color }) => ({
              key,
              label,
              color,
            })),
          }
        : {}),
    })),
  )

const fieldSignature = (fields: readonly FieldDeclaration[]) =>
  JSON.stringify(canonicalFields(fields))

const validateDraft = (fields: readonly DraftField[]): DraftValidation => {
  const fieldErrors = new Map<string, string>()
  const valueErrors = new Map<string, string>()
  const exact = new Map<string, DraftField[]>()
  const names = new Map<string, DraftField[]>()
  let valid = true

  for (const field of fields) {
    exact.set(field.key, [...(exact.get(field.key) ?? []), field])
    const displayName = field.label?.trim() || (field.persistedKey ? fieldDisplayName(field) : '')

    if (displayName) {
      const identity = normalizeFieldDisplayName(displayName)
      names.set(identity, [...(names.get(identity) ?? []), field])
    }
  }
  for (const field of fields) {
    if (!field.persistedKey && !field.label?.trim()) {
      fieldErrors.set(field.id, 'Enter a field name.')
    } else if (!field.key) {
      fieldErrors.set(field.id, 'A safe internal field name could not be generated.')
    } else if (protectedKeys.has(field.key)) {
      fieldErrors.set(field.id, 'A safe internal field name could not be generated.')
    } else if (!isWritableFieldKey(field.key)) {
      fieldErrors.set(field.id, 'A safe internal field name could not be generated.')
    } else if ((exact.get(field.key)?.length ?? 0) > 1) {
      fieldErrors.set(field.id, 'A unique internal field name could not be generated.')
    } else {
      const displayName = field.label?.trim() || (field.persistedKey ? fieldDisplayName(field) : '')

      if (displayName && (names.get(normalizeFieldDisplayName(displayName))?.length ?? 0) > 1) {
        fieldErrors.set(field.id, 'Field name already exists.')
      }
    }
    if (field.type === FIELD_TYPE.enum && field.values) {
      const values = new Map<string, DraftEnumOption[]>()
      const valueNames = new Map<string, DraftEnumOption[]>()

      for (const value of field.values) {
        values.set(value.key, [...(values.get(value.key) ?? []), value])
        const displayName =
          value.label?.trim() || (value.persisted ? fieldEnumOptionDisplayName(value) : '')

        if (displayName) {
          const identity = normalizeFieldDisplayName(displayName)
          valueNames.set(identity, [...(valueNames.get(identity) ?? []), value])
        }
      }
      for (const value of field.values) {
        if (!value.persisted && !value.label?.trim()) {
          valid = false
          if (value.labelTouched) {
            valueErrors.set(value.id, 'Enter a value name.')
          }
        } else if (!value.key) {
          valid = false
          valueErrors.set(value.id, 'A stable enum key could not be generated.')
        } else if ((values.get(value.key)?.length ?? 0) > 1) {
          valueErrors.set(
            value.id,
            `The generated enum key for “${fieldEnumOptionDisplayName(value)}” is already present.`,
          )
        } else {
          const displayName =
            value.label?.trim() || (value.persisted ? fieldEnumOptionDisplayName(value) : '')

          if (
            displayName &&
            (valueNames.get(normalizeFieldDisplayName(displayName))?.length ?? 0) > 1
          ) {
            valueErrors.set(value.id, 'Value name already exists in this field.')
          }
        }
      }
    }
  }

  return {
    fieldErrors,
    valueErrors,
    valid: valid && fieldErrors.size === 0 && valueErrors.size === 0,
  }
}

const FieldSummary = ({ field }: { field: FieldDeclaration }) => (
  <article className={styles.summary} data-testid="field-summary">
    <div className={styles.summaryHead}>
      <span className={styles.fieldName} data-testid="field-name">
        {fieldDisplayName(field)}
      </span>
      <div className={styles.badges}>
        <Chip>{TYPE_LABEL[field.type]}</Chip>
        {field.card && <Chip variant="accent">Shown on cards</Chip>}
      </div>
    </div>
    {field.type === FIELD_TYPE.enum && field.values?.length ? (
      <div className={styles.summaryValues}>
        {field.values.map((value) => (
          <Chip key={value.key} color={value.color}>
            {fieldEnumOptionDisplayName(value)}
          </Chip>
        ))}
      </div>
    ) : null}
  </article>
)

const EnumValuesEditor = ({
  field,
  disabled,
  errors,
  onChange,
  onRemove,
}: {
  field: DraftField
  disabled: boolean
  errors: ReadonlyMap<string, string>
  onChange: (values: DraftEnumOption[]) => void
  onRemove: (value: DraftEnumOption) => void
}) => {
  const errorIdPrefix = useId()
  const values = field.values ?? []
  const ids = values.map((value) => value.id)
  const { handleFor, listProps } = useReorder(
    ids,
    (next) => {
      const byId = new Map(values.map((value) => [value.id, value]))
      onChange(next.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : [])))
    },
    disabled || values.length < 2,
  )
  const update = (id: string, patch: Partial<DraftEnumOption>) =>
    onChange(
      values.map((value) => {
        if (value.id !== id) {
          return value
        }
        const next = { ...value, ...patch }

        return !value.persisted && patch.label !== undefined
          ? { ...next, key: generatedEnumValueKey(patch.label, values, id) }
          : next
      }),
    )

  return (
    <div className={styles.values}>
      <div className={styles.valuesHead}>
        <div>
          <h4>Values</h4>
          <p>Order is the enum order shown throughout the product.</p>
        </div>
        {!disabled && (
          <Button
            variant="ghost"
            icon
            aria-label="Add value"
            title="Add value"
            onClick={() =>
              onChange([
                ...values,
                { id: nextDraftId('value'), key: '', label: '', persisted: false },
              ])
            }
            disabled={values.length >= FIELD_SCHEMA_MAX_VALUES}
            data-testid="enum-add-value"
          >
            <IconPlus size={14} />
          </Button>
        )}
      </div>
      {values.length === 0 ? (
        <EmptyState
          title="No values yet"
          hint="An empty catalog is valid."
          testId="enum-values-empty"
        />
      ) : (
        <div className={styles.valueList} {...listProps}>
          {values.map((value) => (
            <DisclosureCard
              key={value.id}
              header={
                <span className={styles.valueHeader}>
                  <span data-testid="field-value-label">{fieldEnumOptionDisplayName(value)}</span>
                  {value.color && <Chip color={value.color}>{value.color}</Chip>}
                </span>
              }
              defaultOpen={!value.persisted}
              reorder={handleFor(value.id)}
              grip={!disabled && values.length > 1 ? <IconGrip size={14} /> : undefined}
              aside={
                !disabled ? (
                  <Button
                    variant="ghost"
                    icon
                    className={styles.headerAction}
                    aria-label={`Remove enum value ${fieldEnumOptionDisplayName(value)}`}
                    title="Remove enum value"
                    onClick={() => onRemove(value)}
                    data-testid="enum-value-remove"
                  >
                    <IconTrash size={14} />
                  </Button>
                ) : undefined
              }
              testId="field-value"
            >
              <div className={styles.valueBody}>
                <label className={styles.control}>
                  <span>Value name</span>
                  <input
                    value={value.label ?? ''}
                    onChange={(event) => update(value.id, { label: event.target.value })}
                    onBlur={() => update(value.id, { labelTouched: true })}
                    placeholder={value.persisted ? fieldEnumOptionDisplayName(value) : ''}
                    disabled={disabled}
                    autoFocus={!value.persisted}
                    data-testid="field-value-label-input"
                    aria-invalid={errors.has(value.id) || undefined}
                    aria-describedby={
                      errors.has(value.id) ? `${errorIdPrefix}-${value.id}` : undefined
                    }
                  />
                </label>
                {value.persisted && (
                  <p className={styles.hint}>
                    Renaming changes the display label only. The stored key and note files stay
                    unchanged.
                  </p>
                )}
                {errors.get(value.id) && (
                  <p className={styles.error} id={`${errorIdPrefix}-${value.id}`} role="alert">
                    {errors.get(value.id)}
                  </p>
                )}
                <div className={styles.colorControl} role="group" aria-label="Semantic color">
                  <span>Color</span>
                  <div className={styles.palette}>
                    <button
                      type="button"
                      className={styles.colorChoice}
                      data-selected={!value.color || undefined}
                      aria-pressed={!value.color}
                      onClick={() => update(value.id, { color: undefined })}
                      disabled={disabled}
                      data-testid="field-value-color-none"
                    >
                      <span className={styles.noColor}>—</span>
                      None
                    </button>
                    {fieldColors.map((color) => (
                      <button
                        key={color}
                        type="button"
                        className={styles.colorChoice}
                        data-selected={value.color === color || undefined}
                        aria-pressed={value.color === color}
                        onClick={() => update(value.id, { color })}
                        disabled={disabled}
                        data-testid={`field-value-color-${color}`}
                      >
                        <span
                          className={styles.swatch}
                          style={{ background: `var(--field-color-${color})` }}
                        />
                        {color}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </DisclosureCard>
          ))}
        </div>
      )}
    </div>
  )
}

const FieldActionsMenu = ({
  name,
  persisted,
  onRemove,
}: {
  name: string
  persisted: boolean
  onRemove: () => void
}) => {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null)
  const items: MenuItem[] = [
    {
      label: persisted ? 'Delete field' : 'Discard field',
      icon: <IconTrash size={15} />,
      danger: persisted,
      onClick: onRemove,
    },
  ]

  return (
    <>
      <Button
        ref={triggerRef}
        variant="ghost"
        icon
        className={styles.headerAction}
        active={menuAt != null}
        aria-label={`More actions for ${name}`}
        aria-haspopup="menu"
        aria-expanded={menuAt != null}
        data-testid="field-actions-menu"
        onClick={() => {
          if (menuAt) {
            setMenuAt(null)
            return
          }
          const rect = triggerRef.current?.getBoundingClientRect()

          if (rect) {
            setMenuAt({ x: rect.right, y: rect.bottom + 4 })
          }
        }}
      >
        <IconMore size={16} />
      </Button>
      {menuAt && (
        <ContextMenu
          x={menuAt.x}
          y={menuAt.y}
          items={items}
          onClose={() => setMenuAt(null)}
          ignoreRef={triggerRef}
        />
      )}
    </>
  )
}

const FieldEditor = ({
  field,
  notes,
  validation,
  reorder,
  onChange,
  onRemove,
  onRemoveValue,
}: {
  field: DraftField
  notes: number | null
  validation: DraftValidation
  reorder?: ReorderHandle
  onChange: (next: DraftField) => void
  onRemove: () => void
  onRemoveValue: (value: DraftEnumOption) => void
}) => {
  const fieldErrorId = useId()
  const displayName = field.persistedKey
    ? fieldDisplayName(field)
    : field.label?.trim() || 'New field'
  const visibleError =
    field.persistedKey || field.labelTouched ? validation.fieldErrors.get(field.id) : undefined

  return (
    <DisclosureCard
      header={
        <span className={styles.fieldHeader}>
          <span className={styles.fieldName} data-testid="field-name">
            {displayName}
          </span>
          <span className={styles.fieldMeta}>
            <Chip>{TYPE_LABEL[field.type]}</Chip>
            {field.card && <Chip variant="accent">Shown on cards</Chip>}
            <span>
              {notes === null ? 'Usage unavailable' : `${notes} note${notes === 1 ? '' : 's'}`}
            </span>
          </span>
        </span>
      }
      aside={
        <FieldActionsMenu
          name={displayName}
          persisted={Boolean(field.persistedKey)}
          onRemove={onRemove}
        />
      }
      defaultOpen={!field.persistedKey}
      reorder={reorder}
      grip={reorder ? <IconGrip size={15} /> : undefined}
      testId="field-row"
      headerTestId="field-row-toggle"
    >
      <div className={styles.fieldBody}>
        <div className={styles.formGrid}>
          <label className={styles.control}>
            <span>Field name</span>
            <input
              value={field.label ?? ''}
              onChange={(event) =>
                onChange({
                  ...field,
                  label: event.target.value,
                  labelTouched: true,
                })
              }
              onBlur={() => onChange({ ...field, labelTouched: true })}
              placeholder={field.persistedKey ? fieldDisplayName(field) : 'Status'}
              autoFocus={!field.persistedKey}
              data-testid="field-label-input"
              aria-invalid={visibleError ? true : undefined}
              aria-describedby={visibleError ? fieldErrorId : undefined}
            />
          </label>
          <label className={styles.control}>
            <span>Type</span>
            <Select
              value={field.type}
              options={TYPE_OPTIONS}
              onChange={(type) => onChange({ ...field, type })}
              aria-label={`Type for ${displayName}`}
              data-testid="field-type-select"
            />
          </label>
          <div className={styles.cardControl} data-testid="field-card-control">
            <Checkbox
              checked={field.card === true}
              onChange={(card) => onChange({ ...field, card })}
              label="Show on note cards"
              aria-label={`Show ${displayName} on note cards`}
              data-testid="field-card"
            />
          </div>
        </div>
        {visibleError && (
          <Notice id={fieldErrorId} variant="error" data-testid="field-name-error">
            {visibleError}
          </Notice>
        )}
        {field.persistedType && field.persistedType !== field.type && (
          <Notice variant="warning">
            {notes === null
              ? 'Usage count is unavailable. Saving this type change may affect existing notes.'
              : `Saving this type change affects ${notes} note${notes === 1 ? '' : 's'}.`}{' '}
            Some values may become incompatible; note files will not be changed.
          </Notice>
        )}
        {field.type === FIELD_TYPE.enum && (
          <EnumValuesEditor
            field={field}
            disabled={false}
            errors={validation.valueErrors}
            onChange={(values) => onChange({ ...field, values })}
            onRemove={onRemoveValue}
          />
        )}
      </div>
    </DisclosureCard>
  )
}

export const FieldsTab = () => {
  const pageScrollRef = usePageFrameScroll()
  const { canWrite } = useSpace()
  const schema = useFieldSchema()
  const { fieldFacet, fieldFacetReady } = useFeed()
  const { confirm } = useDialog()
  const toast = useToast()
  const [draft, setDraft] = useState<DraftState | null>(null)
  const [busy, setBusy] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [conflict, setConflict] = useState(false)
  const operationRef = useRef(0)
  const draftEpochRef = useRef(0)
  const activeSpaceRef = useRef(schema.space)
  activeSpaceRef.current = schema.space
  const activeDraft = draft?.space === schema.space ? draft : null
  const draftWire = activeDraft ? wireFields(activeDraft.fields) : []
  const dirty = activeDraft ? fieldSignature(draftWire) !== fieldSignature(activeDraft.base) : false
  const editable = canWrite && !schema.readOnly && !schema.error && schema.revision !== 'loading'
  const notesByKey = useMemo(
    () => new Map(fieldFacet.map((field) => [field.key, field.notes])),
    [fieldFacet],
  )
  const validation = useMemo(() => validateDraft(activeDraft?.fields ?? []), [activeDraft?.fields])
  const fieldIds = activeDraft?.fields.map((field) => field.id) ?? []

  const updateDraft = (update: (current: DraftState) => DraftState) => {
    draftEpochRef.current += 1
    setDraft((current) => (current?.space === schema.space ? update(current) : current))
  }
  const { handleFor: fieldHandle, listProps: fieldListProps } = useReorder(
    fieldIds,
    (nextIds) =>
      updateDraft((current) => {
        const byId = new Map(current.fields.map((field) => [field.id, field]))
        return {
          ...current,
          fields: nextIds.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : [])),
        }
      }),
    !editable || fieldIds.length < 2,
  )

  const adopt = (fields: readonly FieldDeclaration[], revision: string) => {
    const base = canonicalFields(fields)
    setDraft({ space: schema.space, revision, fields: draftFields(base), base })
    setSaveError(null)
    setConflict(false)
  }

  useEffect(() => {
    if (schema.loading || (activeDraft && (dirty || activeDraft.revision === schema.revision))) {
      return
    }
    adopt(schema.fields, schema.revision)
    // `adopt` intentionally stays local: only the provider revision and dirty draft
    // decide whether server truth may replace the form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schema.fields, schema.loading, schema.revision, schema.space, dirty])

  useEffect(() => {
    operationRef.current += 1
    setBusy(false)
    setSaveError(null)
    setConflict(false)
  }, [schema.space])

  const notesFor = (key: string | undefined): number | null =>
    fieldFacetReady && key ? (notesByKey.get(key) ?? 0) : null
  const updateField = (next: DraftField) =>
    updateDraft((current) => ({
      ...current,
      fields: current.fields.map((field) => {
        if (field.id !== next.id) {
          return field
        }
        if (!field.persistedKey && field.label !== next.label) {
          return {
            ...next,
            key: generatedFieldKey(next.label ?? '', current.fields, next.id),
          }
        }

        return next
      }),
    }))

  const removeField = async (field: DraftField) => {
    if (field.persistedKey) {
      const notes = notesFor(field.persistedKey)
      const displayName = fieldDisplayName(field)
      const accepted = await confirm({
        title: `Delete field “${displayName}”?`,
        message:
          notes === null
            ? 'This removes only the declaration. Usage count is unavailable; existing values stay in note files and the key becomes undeclared.'
            : `This removes only the declaration. Values in ${notes} note${notes === 1 ? '' : 's'} stay in their files and the key becomes undeclared.`,
        confirmLabel: 'Delete field',
        danger: true,
      })

      if (!accepted) {
        return
      }
    }
    updateDraft((current) => ({
      ...current,
      fields: current.fields.filter((item) => item.id !== field.id),
    }))
  }

  const removeValue = async (field: DraftField, value: DraftEnumOption) => {
    if (value.persisted) {
      const accepted = await confirm({
        title: `Remove enum value “${fieldEnumOptionDisplayName(value)}”?`,
        message:
          'This removes only the catalog entry. Existing note values stay untouched and may be shown as incompatible.',
        confirmLabel: 'Remove value',
        danger: true,
      })

      if (!accepted) {
        return
      }
    }
    updateField({
      ...field,
      values: (field.values ?? []).filter((candidate) => candidate.id !== value.id),
    })
  }

  const addField = () => {
    if (!activeDraft || activeDraft.fields.length >= FIELD_SCHEMA_MAX_FIELDS) {
      return
    }
    updateDraft((current) => ({
      ...current,
      fields: [...current.fields, { id: nextDraftId('field'), key: '', type: FIELD_TYPE.text }],
    }))
  }

  const save = async () => {
    if (!activeDraft || !dirty || !validation.valid || busy || !editable || conflict) {
      return
    }
    const changedTypes = activeDraft.fields.filter(
      (field) => field.persistedType && field.persistedType !== field.type,
    )
    const submittedSpace = activeDraft.space
    const operation = ++operationRef.current
    const submittedDraft = activeDraft.fields
    const submittedSignature = fieldSignature(draftWire)

    if (changedTypes.length) {
      const affected = changedTypes
        .map((field) => {
          const notes = notesFor(field.persistedKey)
          return `${fieldDisplayName(field)} (${notes === null ? 'count unavailable' : `${notes} note${notes === 1 ? '' : 's'}`})`
        })
        .join(', ')
      const accepted = await confirm({
        title: 'Save field type changes?',
        message: `Affected fields: ${affected}. A note may appear in more than one field count. Some values may become incompatible; no note files will be rewritten.`,
        confirmLabel: 'Save schema',
      })

      if (!accepted) {
        return
      }
    }

    if (operation !== operationRef.current || activeSpaceRef.current !== submittedSpace) {
      return
    }
    setBusy(true)
    setSaveError(null)
    setConflict(false)
    try {
      const saved = await schema.update(draftWire, activeDraft.revision)
      const savedBase = canonicalFields(saved.fields)

      if (operation !== operationRef.current || activeSpaceRef.current !== submittedSpace) {
        return
      }
      setDraft((current) => {
        if (current?.space !== submittedSpace) {
          return current
        }
        const currentSignature = fieldSignature(wireFields(current.fields))

        return currentSignature === submittedSignature
          ? {
              space: submittedSpace,
              revision: saved.versionToken,
              fields: draftFields(savedBase),
              base: savedBase,
            }
          : {
              ...current,
              revision: saved.versionToken,
              fields: acknowledgeSavedIdentities(current.fields, submittedDraft, savedBase),
              base: savedBase,
            }
      })
      setSaveError(null)
      setConflict(false)
      toast.success('Field schema saved.')
    } catch (cause) {
      const error = cause as ApiError

      if (operation !== operationRef.current || activeSpaceRef.current !== submittedSpace) {
        return
      }

      if (error.reason === 'field_schema_conflict' || error.reason === 'field_schema_read_only') {
        setConflict(true)
      } else {
        setSaveError(error.message || 'Could not save the field schema')
      }
    } finally {
      if (operation === operationRef.current && activeSpaceRef.current === submittedSpace) {
        setBusy(false)
      }
    }
  }

  const reloadDraft = async (discardConfirmed = false) => {
    const operation = ++operationRef.current
    const submittedSpace = schema.space
    const submittedDraftEpoch = draftEpochRef.current

    if (dirty && !discardConfirmed) {
      const accepted = await confirm({
        title: 'Discard unsaved field changes?',
        message: 'Reloading replaces this draft with the current server schema.',
        confirmLabel: 'Discard and reload',
        danger: true,
      })

      if (!accepted) {
        return
      }
    }
    if (
      operation !== operationRef.current ||
      activeSpaceRef.current !== submittedSpace ||
      draftEpochRef.current !== submittedDraftEpoch
    ) {
      return
    }
    setBusy(true)

    try {
      const latest = await schema.reload()

      if (
        latest &&
        operation === operationRef.current &&
        activeSpaceRef.current === submittedSpace &&
        draftEpochRef.current === submittedDraftEpoch
      ) {
        adopt(latest.fields, latest.versionToken)
      }
    } finally {
      if (operation === operationRef.current && activeSpaceRef.current === submittedSpace) {
        setBusy(false)
      }
    }
  }

  return (
    <SettingsSection
      title="Fields"
      description="Declare presentation and validation metadata for open-world frontmatter keys. Values remain in note files; this screen edits only the space schema."
      testId="fields-section"
    >
      <div className={styles.stack}>
        {!canWrite && (
          <Notice variant="info" data-testid="fields-reader-notice">
            You have read-only access to this space. The schema is visible, but only writers can
            change it.
          </Notice>
        )}
        {schema.error && (
          <Notice variant="error" data-testid="fields-schema-error">
            <div className={styles.noticeBody}>
              <span>{schema.error}</span>
              <Button variant="ghost" onClick={() => void reloadDraft()} disabled={busy}>
                <IconRefresh size={14} /> Retry
              </Button>
            </div>
          </Notice>
        )}
        {schema.readOnly && (
          <Notice variant="warning" data-testid="fields-readonly">
            schema.yaml is read-only until the file is repaired. Valid declarations below remain
            visible; ignored declarations and their reasons are listed above.
          </Notice>
        )}
        {conflict && (
          <Notice variant="warning" data-testid="fields-conflict">
            <div className={styles.noticeBody}>
              <span>The schema changed elsewhere. Your draft is still here.</span>
              <Button
                variant="ghost"
                onClick={() => void reloadDraft(true)}
                disabled={busy}
                data-testid="fields-conflict-reload"
              >
                <IconRefresh size={14} /> Reload server version
              </Button>
            </div>
          </Notice>
        )}
        {saveError && <Notice variant="error">{saveError}</Notice>}

        {schema.loading && !activeDraft ? (
          <div className={styles.loading} data-testid="fields-loading" aria-hidden="true">
            {Array.from({ length: 3 }, (_, index) => (
              <div key={index} className={styles.loadingRow}>
                <Skeleton w={`${35 + index * 8}%`} h={16} radius="var(--radius-xs)" />
                <Skeleton w="100%" h={42} radius="var(--radius-sm)" />
              </div>
            ))}
          </div>
        ) : activeDraft && activeDraft.fields.length === 0 ? (
          <EmptyState
            title="No declared fields"
            hint="Frontmatter keys already work without declarations. Declare one to add a type, label, enum order and semantic color."
            action={
              editable ? (
                <Button onClick={addField} data-testid="fields-add">
                  <IconPlus size={14} /> Add field
                </Button>
              ) : undefined
            }
            testId="fields-empty"
          />
        ) : editable && activeDraft ? (
          <div className={styles.fieldList} {...fieldListProps}>
            {activeDraft.fields.map((field) => (
              <FieldEditor
                key={field.id}
                field={field}
                notes={notesFor(field.persistedKey ?? field.key)}
                validation={validation}
                reorder={fieldHandle(field.id)}
                onChange={updateField}
                onRemove={() => void removeField(field)}
                onRemoveValue={(value) => void removeValue(field, value)}
              />
            ))}
          </div>
        ) : (
          <div className={styles.fieldList}>
            {(draftWire.length ? draftWire : schema.fields).map((field) => (
              <FieldSummary key={field.key} field={field} />
            ))}
          </div>
        )}

        {editable && activeDraft && (activeDraft.fields.length > 0 || dirty) && (
          <StickyBar
            edge="bottom"
            surface="panel"
            scrollRef={pageScrollRef}
            className={styles.actions}
            data-testid="fields-actions"
          >
            {activeDraft.fields.length > 0 && (
              <Button
                variant="ghost"
                onClick={addField}
                disabled={activeDraft.fields.length >= FIELD_SCHEMA_MAX_FIELDS || busy}
                data-testid="fields-add"
              >
                <IconPlus size={14} /> Add field
              </Button>
            )}
            <span className={styles.actionSpacer} />
            {dirty && (
              <Button
                variant="ghost"
                onClick={() => adopt(activeDraft.base, activeDraft.revision)}
                disabled={busy}
                data-testid="fields-reset"
              >
                Reset
              </Button>
            )}
            <Button
              variant="primary"
              onClick={() => void save()}
              disabled={!dirty || !validation.valid || busy || conflict}
              data-testid="fields-save"
            >
              {busy ? 'Saving…' : 'Save schema'}
            </Button>
          </StickyBar>
        )}
      </div>
    </SettingsSection>
  )
}
