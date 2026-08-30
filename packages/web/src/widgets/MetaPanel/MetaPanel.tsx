import { type ReactNode, useMemo } from 'react'
import type { FieldDeclaration } from '@notarium/contract'
import { DEFAULT_NOTE_TYPE } from '@notarium/core'
import { TagChips } from '../../core/Chips'
import { absoluteDate, exactDateTime } from '../../libs/datetime'
import { feedTagRoute } from '../../libs/routing/routePaths'
import type { NoteDetailView } from '../../libs/wire'
import { FieldRows } from '../FieldRows'
import type { EditableFieldValue } from '../FieldRows/FieldValueControl'
import { FieldSchemaWarning } from '../FieldSchemaWarning'
import styles from './MetaPanel.module.scss'

type MetaNote = Pick<
  NoteDetailView,
  'frontmatter' | 'fields' | 'class' | 'agentKind' | 'createdAt' | 'modifiedAt'
>

const Field = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className={styles.field} data-field={label}>
    <span className={styles.label}>{label}</span>
    <div className={styles.value}>{children}</div>
  </div>
)

export const MetaPanel = ({
  note,
  space,
  schema = [],
  fieldValues,
  canWrite = false,
  busyKey,
  onSetField,
  onOpenTag,
  schemaError = null,
  schemaErrorMessage,
  onRetrySchema,
}: {
  note: MetaNote
  space?: string
  schema?: readonly FieldDeclaration[]
  fieldValues?: Record<string, string | string[]>
  canWrite?: boolean
  busyKey?: string | null
  onSetField?: (key: string, value: EditableFieldValue | null) => void
  onOpenTag?: (foldedTag: string) => void
  schemaError?: string | null
  schemaErrorMessage?: string
  onRetrySchema?: () => void
}) => {
  const frontmatter = useMemo(() => note.frontmatter || {}, [note.frontmatter])
  const type =
    typeof frontmatter.type === 'string' && frontmatter.type ? frontmatter.type : DEFAULT_NOTE_TYPE
  const created = absoluteDate(note.createdAt)
  const modified = absoluteDate(note.modifiedAt)
  const tags = useMemo<string[]>(
    () =>
      Array.isArray(frontmatter.tags)
        ? frontmatter.tags.map(String)
        : frontmatter.tags
          ? [String(frontmatter.tags)]
          : [],
    [frontmatter.tags],
  )

  return (
    <div className={styles.metaPanel} data-testid="meta-panel">
      <FieldSchemaWarning
        error={schemaError}
        message={schemaErrorMessage}
        onRetry={onRetrySchema}
      />
      <Field label="Type">
        {type ? (
          <span className={styles.pill}>{type}</span>
        ) : (
          <span className={styles.muted}>—</span>
        )}
      </Field>
      <FieldRows
        frontmatter={frontmatter}
        details={note.fields}
        values={fieldValues}
        schema={schema}
        readOnly={!canWrite || note.fields === undefined}
        appearance="inline"
        showDateIcon={false}
        agentKind={note.agentKind}
        busyKey={busyKey}
        onSetField={note.fields === undefined ? undefined : onSetField}
      />
      {note.class && (
        <Field label="Class">
          <span className={styles.pill} title="Storage class">
            {note.class}
          </span>
        </Field>
      )}
      {!note.class && (
        <Field label="Class">
          <span className={styles.muted}>—</span>
        </Field>
      )}
      <Field label="Created">
        {created ? (
          <span title={exactDateTime(note.createdAt)}>{created}</span>
        ) : (
          <span className={styles.muted}>—</span>
        )}
      </Field>
      <Field label="Modified">
        {modified ? (
          <span title={exactDateTime(note.modifiedAt)}>{modified}</span>
        ) : (
          <span className={styles.muted}>—</span>
        )}
      </Field>
      <Field label="Tags">
        {tags.length ? (
          <span className={styles.tags}>
            <TagChips
              tags={tags}
              hrefForTag={space ? (_tag, folded) => feedTagRoute(space, folded) : undefined}
              onOpenTag={onOpenTag}
            />
          </span>
        ) : (
          <span className={styles.muted}>—</span>
        )}
      </Field>
    </div>
  )
}
