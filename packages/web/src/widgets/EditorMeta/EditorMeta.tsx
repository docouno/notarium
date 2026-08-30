import { useId } from 'react'
import type { FieldDeclaration, NoteDetail } from '@notarium/contract'
import { slugify } from '@notarium/core/slug'
import { ChipInput } from '../../core/Chips'
import { DatePicker } from '../../core/DatePicker'
import { absoluteDate, exactDateTime } from '../../libs/datetime'
import { BASE_FIELD_HIDDEN_KEYS, FieldRows } from '../FieldRows'
import { FieldSchemaWarning } from '../FieldSchemaWarning'
import styles from './EditorMeta.module.scss'

// The note's metadata, shown inside the right aside while editing. Bound to the
// shared useNoteDraft state so every editable value leaves through the one document Save.
type EditorMetaBinding = {
  title: string
  slug: string
  setSlug: (value: string) => void
  noteType: string
  setNoteType: (value: string) => void
  fields: Record<string, string | string[]>
  fieldDetails?: NoteDetail['fields']
  frontmatter: Record<string, unknown>
  fieldsStructured: boolean
  setField: (key: string, value: string | string[] | null) => void
  setPendingField: (key: string, value: string) => void
  tags: string[]
  setTags: (tags: string[]) => void
  createdDate: string
  setCreatedDate: (value: string) => void
}

export const EditorMeta = ({
  editor,
  schema = [],
  documentClass,
  agentKind,
  modifiedAt,
  fieldWritesAllowed = true,
  fieldWriteError,
  fieldSchemaError,
  onRetryFieldSchema,
}: {
  editor: EditorMetaBinding
  schema?: readonly FieldDeclaration[]
  documentClass?: NoteDetail['class']
  agentKind?: NoteDetail['agentKind']
  modifiedAt?: string | null
  fieldWritesAllowed?: boolean
  fieldWriteError?: string | null
  fieldSchemaError?: string | null
  onRetryFieldSchema?: () => Promise<unknown>
}) => {
  const tagsId = useId()
  const modified = absoluteDate(modifiedAt)

  return (
    <div className={styles.editorMeta} data-testid="editor-meta">
      <label className={styles.metaField} data-field="Type">
        <span className={styles.metaLabel}>Type</span>
        <input
          className={styles.metaType}
          value={editor.noteType}
          onChange={(event) => editor.setNoteType(event.target.value)}
          spellCheck={false}
        />
      </label>
      <FieldSchemaWarning
        error={fieldWriteError ?? null}
        message="Custom field editing is unavailable"
      />
      <FieldSchemaWarning
        error={fieldWriteError ? null : (fieldSchemaError ?? null)}
        onRetry={onRetryFieldSchema ? () => void onRetryFieldSchema() : undefined}
      />
      <FieldRows
        frontmatter={editor.frontmatter}
        details={editor.fieldDetails}
        values={editor.fields}
        schema={schema}
        structured={editor.fieldsStructured}
        hiddenKeys={BASE_FIELD_HIDDEN_KEYS}
        readOnly={!editor.fieldsStructured || !fieldWritesAllowed}
        appearance="inline"
        agentKind={agentKind}
        onSetField={editor.fieldsStructured && fieldWritesAllowed ? editor.setField : undefined}
        liveDraft
        onPendingFieldChange={
          editor.fieldsStructured && fieldWritesAllowed ? editor.setPendingField : undefined
        }
      />
      <div className={styles.metaField} data-field="Class">
        <span className={styles.metaLabel}>Class</span>
        {documentClass ? (
          <span className={styles.metaPill} title="Storage class">
            {documentClass}
          </span>
        ) : (
          <span className={styles.muted}>—</span>
        )}
      </div>
      <label className={styles.metaField} data-field="Slug">
        <span className={styles.metaLabel}>Slug</span>
        <input
          className={styles.metaType}
          value={editor.slug}
          onChange={(event) => editor.setSlug(event.target.value)}
          placeholder={slugify(editor.title) || 'note-url-slug'}
          spellCheck={false}
        />
      </label>
      <div className={styles.metaField} data-field="Created">
        <span className={styles.metaLabel}>Created</span>
        <DatePicker
          value={editor.createdDate}
          onChange={editor.setCreatedDate}
          placeholder="Set creation date"
          aria-label={`Creation date${editor.createdDate ? `: ${absoluteDate(editor.createdDate)}` : ''}`}
        />
      </div>
      <div className={styles.metaField} data-field="Modified">
        <span className={styles.metaLabel}>Modified</span>
        {modified ? (
          <span className={styles.metaValue} title={exactDateTime(modifiedAt)}>
            {modified}
          </span>
        ) : (
          <span className={styles.muted}>—</span>
        )}
      </div>
      <div className={styles.metaField} data-field="Tags">
        <label className={styles.metaLabel} htmlFor={tagsId}>
          Tags
        </label>
        <ChipInput
          values={editor.tags}
          onChange={editor.setTags}
          inputId={tagsId}
          placeholder="Add tags…"
          populatedPlaceholder="Add tag…"
          dedupe
          tag
        />
      </div>
    </div>
  )
}
