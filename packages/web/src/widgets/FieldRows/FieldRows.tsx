import { useEffect, useId, useMemo, useState } from 'react'
import type { FieldDeclaration, NoteDetail } from '@notarium/contract'
import { PROJECTED_FIELD_KEYS, PROTECTED_FIELD_KEYS } from '@notarium/contract/enums'
import { isWritableFieldKey } from '@notarium/core'
import { Button } from '../../core/Button'
import { cx } from '../../libs/cx/cx'
import { fieldDisplayName } from '../../libs/fields'
import { type EditableFieldValue, FieldValueControl, fieldValueMismatch } from './FieldValueControl'
import { orderedFieldKeys } from './orderedFieldKeys'
import styles from './FieldRows.module.scss'

export const BASE_FIELD_HIDDEN_KEYS = new Set([...PROJECTED_FIELD_KEYS, 'type', 'permalink', 'id'])
const protectedKeys = new Set<string>(PROTECTED_FIELD_KEYS)
const own = (value: object, key: string) => Object.hasOwn(value, key)
const EXTRA_FIELDS_PAGE = 64

export const FieldRows = ({
  frontmatter,
  details,
  values = details?.keys ?? Object.create(null),
  schema = [],
  structured = details !== undefined,
  hiddenKeys = BASE_FIELD_HIDDEN_KEYS,
  readOnly,
  appearance = 'form',
  showDateIcon = true,
  agentKind,
  disabled = false,
  busyKey,
  onSetField,
  liveDraft = false,
  onPendingFieldChange,
}: {
  frontmatter: Record<string, unknown>
  details?: NoteDetail['fields']
  values?: Record<string, string | string[]>
  schema?: readonly FieldDeclaration[]
  structured?: boolean
  hiddenKeys?: ReadonlySet<string>
  readOnly: boolean
  appearance?: 'inline' | 'form'
  showDateIcon?: boolean
  agentKind?: NoteDetail['agentKind']
  disabled?: boolean
  busyKey?: string | null
  onSetField?: (key: string, value: EditableFieldValue | null) => void
  liveDraft?: boolean
  onPendingFieldChange?: (key: string, value: string) => void
}) => {
  const markerPrefix = useId()
  const [extraLimit, setExtraLimit] = useState(EXTRA_FIELDS_PAGE)
  const unreadable = useMemo(() => new Set(details?.unreadable ?? []), [details?.unreadable])
  const truncated = useMemo(() => new Set(details?.truncated ?? []), [details?.truncated])
  const structuralNames = useMemo(
    () =>
      new Set([...Object.getOwnPropertyNames(details?.keys ?? {}), ...unreadable, ...truncated]),
    [details?.keys, truncated, unreadable],
  )
  const declarations = useMemo(() => (structured ? schema : []), [schema, structured])
  const declaredKeys = useMemo(
    () => new Set(declarations.map((declaration) => declaration.key)),
    [declarations],
  )
  const extraKeys = useMemo(() => {
    const present = new Set([
      ...Object.keys(frontmatter).filter((key) => !structured || !structuralNames.has(key)),
      ...Object.getOwnPropertyNames(values),
      ...unreadable,
      ...truncated,
    ])
    const ordered = details?.order ?? Object.keys(frontmatter)

    return orderedFieldKeys(ordered, present).filter((key) => {
      if (hiddenKeys.has(key) || declaredKeys.has(key)) {
        return false
      }
      if (!structured) {
        const value = frontmatter[key]
        return value != null && value !== ''
      }

      return present.has(key)
    })
  }, [
    declaredKeys,
    details?.order,
    frontmatter,
    hiddenKeys,
    structuralNames,
    structured,
    truncated,
    unreadable,
    values,
  ])
  const notIndexed =
    (details?.truncated?.length ?? 0) +
    (details?.truncatedMore ?? 0) +
    (details?.unreadableMore ?? 0)
  const extraIdentity = useMemo(
    () => (details?.order ?? Object.keys(frontmatter)).join('\u0000'),
    [details?.order, frontmatter],
  )

  useEffect(() => setExtraLimit(EXTRA_FIELDS_PAGE), [extraIdentity])

  const row = (key: string, label: string, declaration?: FieldDeclaration) => {
    const authoredField = Boolean(declaration) || structuralNames.has(key) || own(values, key)
    const projectedValue = authoredField ? values[key] : frontmatter[key]
    const present = authoredField ? own(values, key) || unreadable.has(key) : own(frontmatter, key)
    const mismatch = fieldValueMismatch(declaration, projectedValue, present)
    const mismatchId = `${markerPrefix}-${encodeURIComponent(key)}-mismatch`
    const editable =
      structured &&
      !readOnly &&
      Boolean(onSetField) &&
      isWritableFieldKey(key) &&
      key !== '__proto__' &&
      !protectedKeys.has(key) &&
      !(agentKind && (key === 'name' || key === 'description')) &&
      !unreadable.has(key)
    const inline = editable && appearance === 'inline'
    const controlDisabled = disabled || busyKey != null

    return (
      <div
        className={cx(styles.field, inline && styles.inlineField, busyKey === key && styles.busy)}
        data-field={label}
        aria-busy={busyKey === key || undefined}
        key={key}
      >
        <span className={styles.label}>{label}</span>
        <div className={styles.value}>
          <div className={styles.fieldControl}>
            <div className={styles.controlMain}>
              <FieldValueControl
                declaration={declaration}
                fieldLabel={label}
                value={projectedValue}
                present={present}
                unreadable={unreadable.has(key)}
                readOnly={!editable}
                appearance={inline ? 'inline' : editable ? 'form' : 'read'}
                showDateIcon={showDateIcon}
                disabled={controlDisabled}
                onChange={(value) => onSetField?.(key, value)}
                liveDraft={liveDraft}
                onPendingChange={(value) => onPendingFieldChange?.(key, value)}
                ariaInvalid={mismatch}
                ariaDescribedBy={mismatch ? mismatchId : undefined}
              />
            </div>
          </div>
          <div className={styles.markers}>
            {mismatch && (
              <span id={mismatchId} title={`Declared as ${declaration?.type}`}>
                Does not match declared type
              </span>
            )}
            {truncated.has(key) && (
              <span>Not indexed — field filters and facets cannot match this value</span>
            )}
          </div>
        </div>
      </div>
    )
  }

  return (
    <>
      {declarations.length > 0 && (
        <div className={styles.declared} data-testid="declared-fields">
          {declarations.map((declaration) =>
            row(declaration.key, fieldDisplayName(declaration), declaration),
          )}
        </div>
      )}
      {extraKeys.length > 0 && (
        <div className={styles.extra} data-testid="undeclared-fields">
          {extraKeys.slice(0, extraLimit).map((key) => row(key, key))}
          {extraLimit < extraKeys.length && (
            <Button
              variant="ghost"
              onClick={() => setExtraLimit((current) => current + EXTRA_FIELDS_PAGE)}
              data-testid="show-more-undeclared-fields"
            >
              Show {Math.min(EXTRA_FIELDS_PAGE, extraKeys.length - extraLimit)} more
            </Button>
          )}
        </div>
      )}
      {notIndexed > 0 && (
        <p className={styles.indexWarning} data-testid="unindexed-fields">
          {notIndexed} field{notIndexed === 1 ? '' : 's'} not fully indexed; field filters and
          facets may not match them.
        </p>
      )}
    </>
  )
}
