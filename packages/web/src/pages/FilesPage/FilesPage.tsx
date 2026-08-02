import { Navigate, useLocation } from 'react-router'
import { FolderChildrenSummary } from '../../composers/FolderChildrenSummary'
import { useNotes } from '../../composers/NotesProvider'
import { useSpace } from '../../composers/SpaceProvider'
import { Splash } from '../../composers/Splash'
import { noteRoute, parseAppPath } from '../../libs/routing/routePaths'
import styles from './FilesPage.module.scss'

// `/s/<space>/files/<path>` — a folder of the Files surface (#51, #212). A folder
// with a PAGE (#212) shows its body in the standard note reader, so this redirects
// to the page note's `/n/<id>` (zero bespoke — the page IS an ordinary note). A
// folder with no page renders a VIRTUAL page: title + direct children summary, but
// no `index.md` is written until the user edits and saves a description. The space
// root ('') stays the generic browse — its home/dashboard is a separate surface.
// Notes are still addressed by `/n/<id>`.
export const FilesPage = () => {
  const location = useLocation()
  const { tree } = useNotes()
  const { space } = useSpace()

  const parsed = parseAppPath(location.pathname)
  const path = parsed.kind === 'files' ? parsed.path : ''
  const folder = tree?.folders.find((f) => f.path === path)

  // A folder with a page → show its body in the standard reader (its `/n/<id>`).
  if (folder?.pageNoteId) {
    const to = noteRoute(folder.pageNoteId)

    if (to) {
      return <Navigate to={to} replace />
    }
  }

  // The Files root (''), a path still loading, OR a path that names no real folder
  // (a bogus/stale URL — a moved folder's alias is already redirected upstream by
  // NotesProvider) → the generic browse. An EXISTING page-less folder gets the
  // virtual page below; merely opening it never materialises an `index.md`.
  if (!folder) {
    return <Splash />
  }

  const name = folder.name || path.split('/').pop() || space
  return (
    <article className="doc" data-testid="virtual-folder-page">
      <header className={styles.docHead}>
        <h1 className={styles.docTitle}>{name}</h1>
      </header>
      <FolderChildrenSummary space={space} folderPath={path} />
    </article>
  )
}
