import { Button } from '../../core/Button'
import { IconBrain, IconLink, IconPlus } from '../../core/Icons'
import { useEditing } from '../EditingProvider'
import { useNotes } from '../NotesProvider'
import { useSpace } from '../SpaceProvider'
import styles from './Splash.module.scss'

// The empty-reader splash: Home and any folder browse without an open note.
// Until a real dashboard exists, home = this splash over the full tree.
export const Splash = () => {
  const { tree } = useNotes()
  const { startNew } = useEditing()
  const { canWrite } = useSpace()
  const total = tree?.stats.total ?? 0
  // A reader can't create — the copy and the action drop the "new note" path so
  // the empty state stays honest instead of inviting a rejected write.
  return (
    <div className={styles.splash}>
      <div className={styles.splashMark}>
        <IconBrain size={44} />
      </div>
      <h2>Your knowledge base</h2>
      <p>
        {total
          ? canWrite
            ? 'Pick a note from the list, search, or create a new one.'
            : 'Pick a note from the list or search.'
          : canWrite
            ? 'No notes yet — create your first note to get started.'
            : 'No notes here yet.'}
      </p>
      <div className={styles.splashStats}>
        <span>
          <IconLink size={14} /> {total} notes
        </span>
      </div>
      {canWrite && (
        <Button variant="primary" onClick={() => void startNew()}>
          <IconPlus size={16} /> New note
        </Button>
      )}
    </div>
  )
}
