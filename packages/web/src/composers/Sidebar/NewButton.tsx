import { useRef, useState } from 'react'
import { ContextMenu, type MenuItem } from '../../core/ContextMenu'
import { IconDoc, IconFolderKanban, IconFolderPlus, IconPlus } from '../../core/Icons'
import { cx } from '../../libs/cx/cx'
import styles from './Sidebar.module.scss'

// The "new" control (#13 C): the + opens a small menu — a plain note, or a new
// project (a fresh marked folder). Creating a project is a space:write act, so
// the menu only appears for a principal who can manage projects; otherwise a
// single choice needs no menu and the + just creates a note directly.
// The "New" affordance — lives ONLY in the wide panel head now (#245 dropped the
// standalone "+" from the activity strip), so there's a single instance and the
// historical `new-note` / `new-menu` test ids are unambiguous.
export const NewButton = ({
  canCreateProject,
  onNewNote,
  onNewFolder,
  onNewProject,
}: {
  canCreateProject: boolean
  onNewNote: () => void
  onNewFolder: () => void
  onNewProject: () => void
}) => {
  const ref = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)

  if (!canCreateProject) {
    return (
      <button
        ref={ref}
        className={styles.iconBtn}
        title="New note"
        data-testid="new-note"
        onClick={onNewNote}
      >
        <IconPlus size={16} />
      </button>
    )
  }
  const items: MenuItem[] = [
    { label: 'New note', icon: <IconDoc size={14} />, onClick: onNewNote },
    { label: 'New folder', icon: <IconFolderPlus size={14} />, onClick: onNewFolder },
    { label: 'New project', icon: <IconFolderKanban size={14} />, onClick: onNewProject },
  ]
  const rect = open && ref.current ? ref.current.getBoundingClientRect() : null
  return (
    <>
      <button
        ref={ref}
        className={cx(styles.iconBtn, open && styles.menuOpen)}
        title="New…"
        data-testid="new-menu"
        onClick={() => setOpen((o) => !o)}
      >
        <IconPlus size={16} />
      </button>
      {rect && (
        <ContextMenu
          x={rect.left}
          y={rect.bottom + 4}
          ignoreRef={ref}
          items={items}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}
