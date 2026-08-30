import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { NOTE_CLASS } from '@notarium/contract/enums'
import { useAuth } from '../../composers/AuthProvider'
import { useChrome } from '../../composers/ChromeProvider'
import { useEditing } from '../../composers/EditingProvider'
import { useFieldSchemaForSpace } from '../../composers/FieldSchemaProvider'
import { useHotkeys } from '../../composers/HotkeysProvider'
import { useInlineNoteFields } from '../../composers/NoteInspector/hooks/useInlineNoteFields'
import { useNotes } from '../../composers/NotesProvider'
import { useSpace } from '../../composers/SpaceProvider'
import { Button } from '../../core/Button'
import { IconEdit, IconEye } from '../../core/Icons'
import { useToast } from '../../core/Toast'
import { useEditorPreview } from '../../layouts/DocumentLayout/hooks/useEditorPreview'
import { canWriteSpace } from '../../libs/access'
import { editorBindings } from '../../libs/hotkeys'
import { api } from '../../services/api'
import { EditorBody } from '../../widgets/EditorBody'
import { EditorMeta } from '../../widgets/EditorMeta'
import { MetaPanel } from '../../widgets/MetaPanel'
import { NotePage } from '../NotePage'
import { AgentsPanel } from './AgentsPanel'
import { useAgentsShell } from './AgentsProvider'
import { AsidePlaceholder } from './AsidePlaceholder'
import styles from './MemoryNotePage.module.scss'

/** Agent-memory keeps the complete Agents shell while switching between reader
 * and the shared document editor. The selected Context scope rides in the URL,
 * so Save, Cancel, reload and canonical slug replacement cannot lose the rail. */
export const MemoryNotePage = () => {
  const { mode, note, navigating, noteError, reloadNote } = useNotes()
  const { space } = useSpace()
  const { me, mode: authMode } = useAuth()
  const toast = useToast()
  const editing = useEditing()
  const fieldSchema = useFieldSchemaForSpace(note?.space ?? space)
  const { actionsHost, setBreadcrumbTail } = useAgentsShell()
  const { editorMode, focusMode, setFocusMode, typewriter, toggleFocus, toggleTypewriter } =
    useChrome()
  const { resolved } = useHotkeys()
  const { editorPreview, setEditorPreview, editorKey } = useEditorPreview(editing.draft)
  const readableMemory =
    mode === 'read' && note?.class === NOTE_CLASS.agentMemory && !note.deleted ? note : null
  const noteSpace = note?.space ?? space
  const canWriteNote = Boolean(readableMemory?.id) && canWriteSpace(me, authMode, noteSpace)
  const canWriteFields =
    canWriteNote &&
    !fieldSchema.loading &&
    fieldSchema.valueWrites &&
    readableMemory?.fieldsWritable !== false
  const {
    values: fieldValues,
    busyKey: fieldBusyKey,
    setField,
  } = useInlineNoteFields({
    note: readableMemory,
    canWrite: canWriteFields,
    write: api.noteFieldsPut,
    reload: reloadNote,
    onError: (message) => toast.error(message),
  })

  useEffect(() => {
    setBreadcrumbTail(readableMemory?.title ? { label: readableMemory.title } : null)
    return () => setBreadcrumbTail(null)
  }, [readableMemory?.title, setBreadcrumbTail])

  const cancel = async () => {
    if (await editing.ensureCanLeaveDraft()) {
      editing.cancelEdit()
    }
  }
  const actions = editing.isEditing ? (
    <>
      <Button
        variant={editing.editor.dirty ? 'danger' : 'ghost'}
        disabled={editing.saving}
        onClick={() => void cancel()}
      >
        Cancel
      </Button>
      <Button
        variant="ghost"
        disabled={editing.saving}
        onClick={() => setEditorPreview((current) => !current)}
      >
        {editorPreview ? <IconEdit size={15} /> : <IconEye size={15} />}
        {editorPreview ? 'Edit' : 'Preview'}
      </Button>
      {canWriteNote && (
        <Button
          variant="primary"
          disabled={!editing.editor.canSave || editing.saving}
          onClick={() => void editing.saveDraft(editing.editor.buildPayload())}
        >
          {editing.saving ? 'Saving…' : 'Save'}
        </Button>
      )}
    </>
  ) : readableMemory && canWriteNote ? (
    <Button variant="ghost" onClick={editing.startEdit}>
      <IconEdit size={15} /> Edit
    </Button>
  ) : null
  const panels = editing.isEditing
    ? [
        {
          id: 'details',
          label: 'Details',
          render: () => (
            <EditorMeta
              editor={editing.editor}
              schema={fieldSchema.fields}
              documentClass={note?.class}
              agentKind={note?.agentKind}
              modifiedAt={note?.modifiedAt}
              fieldWritesAllowed={fieldSchema.valueWrites && note?.fieldsWritable !== false}
              fieldWriteError={
                note?.fieldsWriteError ?? (!fieldSchema.valueWrites ? fieldSchema.error : null)
              }
              fieldSchemaError={fieldSchema.error}
              onRetryFieldSchema={fieldSchema.error ? fieldSchema.reload : undefined}
            />
          ),
        },
      ]
    : readableMemory
      ? [
          {
            id: 'details',
            label: 'Details',
            render: () => (
              <MetaPanel
                note={readableMemory}
                space={noteSpace}
                schema={fieldSchema.fields}
                fieldValues={fieldValues}
                canWrite={canWriteFields}
                busyKey={fieldBusyKey}
                onSetField={(key, value) => void setField(key, value)}
                schemaError={
                  (canWriteNote ? readableMemory.fieldsWriteError : undefined) ?? fieldSchema.error
                }
                schemaErrorMessage={
                  canWriteNote && readableMemory.fieldsWriteError
                    ? 'Custom field editing is unavailable'
                    : undefined
                }
                onRetrySchema={
                  (!canWriteNote || !readableMemory.fieldsWriteError) && fieldSchema.error
                    ? () => void fieldSchema.reload()
                    : undefined
                }
              />
            ),
          },
        ]
      : // A note still arriving, a read that failed, a note of another class and a
        // deleted one all land here — and none of them is a reason for the route to lose
        // its aside. `panels` never goes empty, so the toggle stays and the content
        // column keeps its width through every one of them (#393).
        //
        // `navigating` alone is not "still loading": the reader raises it from a passive
        // effect, so the first commit under a new URL has neither the note nor the flag.
        // A note that is simply absent without an error is still on its way; a read that
        // failed says so, the way the neighbouring routes do.
        [
          {
            id: 'details',
            label: 'Details',
            render: () =>
              navigating || (!note && !noteError) ? (
                <AsidePlaceholder loading />
              ) : (
                <AsidePlaceholder
                  loading={false}
                  blank={
                    noteError
                      ? 'This note didn’t open, so there is nothing to describe.'
                      : 'This note has no memory details to show.'
                  }
                />
              ),
          },
        ]

  return (
    <div className={styles.page} data-testid="memory-note-surface">
      {editing.isEditing && editing.draft ? (
        <EditorBody
          key={editorKey}
          editor={editing.editor}
          preview={editorPreview}
          mode={editorMode === 'wysiwym' ? 'wysiwym' : 'source'}
          focus={focusMode}
          typewriter={typewriter}
          onSetFocus={setFocusMode}
          onToggleFocus={toggleFocus}
          onToggleTypewriter={toggleTypewriter}
          editorKeys={editorBindings(resolved)}
        />
      ) : (
        <NotePage />
      )}
      {actionsHost && actions ? createPortal(actions, actionsHost) : null}
      <AgentsPanel
        panels={panels}
        defaultLayout={[{ panels: ['details'], activeTab: 'details' }]}
        label="memory details"
      />
    </div>
  )
}
