import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { NOTE_CLASS } from '@notarium/contract/enums'
import { useChrome } from '../../composers/ChromeProvider'
import { useEditing } from '../../composers/EditingProvider'
import { useHotkeys } from '../../composers/HotkeysProvider'
import { useNotes } from '../../composers/NotesProvider'
import { useSpace } from '../../composers/SpaceProvider'
import { Button } from '../../core/Button'
import { IconEdit, IconEye } from '../../core/Icons'
import { useEditorPreview } from '../../layouts/DocumentLayout/hooks/useEditorPreview'
import { editorBindings } from '../../libs/hotkeys'
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
  const { mode, note, folders, navigating, noteError } = useNotes()
  const { canWrite } = useSpace()
  const editing = useEditing()
  const { actionsHost, setBreadcrumbTail } = useAgentsShell()
  const { editorMode, focusMode, setFocusMode, typewriter, toggleFocus, toggleTypewriter } =
    useChrome()
  const { resolved } = useHotkeys()
  const { editorPreview, setEditorPreview, editorKey } = useEditorPreview(editing.draft)
  const readableMemory =
    mode === 'read' && note?.class === NOTE_CLASS.agentMemory && !note.deleted ? note : null

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
      {canWrite && (
        <Button
          variant="primary"
          disabled={!editing.editor.canSave || editing.saving}
          onClick={() => void editing.saveDraft(editing.editor.buildPayload())}
        >
          {editing.saving ? 'Saving…' : 'Save'}
        </Button>
      )}
    </>
  ) : readableMemory && canWrite ? (
    <Button variant="ghost" onClick={editing.startEdit}>
      <IconEdit size={15} /> Edit
    </Button>
  ) : null
  const panels = editing.isEditing
    ? [
        {
          id: 'details',
          label: 'Details',
          render: () => <EditorMeta editor={editing.editor} folders={folders} />,
        },
      ]
    : readableMemory
      ? [
          {
            id: 'details',
            label: 'Details',
            render: () => <MetaPanel note={readableMemory} />,
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
