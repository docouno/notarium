import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { STORE_EVENT } from '@notarium/contract/events'
import { IconChevron, IconDoc, IconFolder, IconFolderKanban } from '../../core/Icons'
import { folderPageHref, noteRoute } from '../../libs/routing/routePaths'
import type { NoteView, TreeFolder } from '../../libs/wire'
import { api } from '../../services/api'
import { useProjects } from '../ProjectsProvider'
import { useSync } from '../SyncProvider'
import styles from './FolderChildrenSummary.module.scss'

type SummaryState = {
  loading: boolean
  error: boolean
  folders: TreeFolder[]
  notes: NoteView[]
}

const initialState: SummaryState = { loading: true, error: false, folders: [], notes: [] }

export const FolderChildrenSummary = ({
  space,
  folderPath,
}: {
  space: string
  folderPath: string
}) => {
  const { subscribe } = useSync()
  const { projectAt } = useProjects()
  const [state, setState] = useState<SummaryState>(initialState)
  const [reloadKey, setReloadKey] = useState(0)
  const targetRef = useRef('')

  useEffect(
    () =>
      subscribe((event) => {
        if (event.type === STORE_EVENT.CHANGED) {
          setReloadKey((n) => n + 1)
        }
      }),
    [subscribe],
  )

  useEffect(() => {
    const ac = new AbortController()
    const target = `${space}\0${folderPath}`
    const sameTarget = targetRef.current === target
    targetRef.current = target
    setState((prev) => {
      const hasItems = prev.folders.length > 0 || prev.notes.length > 0
      return sameTarget ? { ...prev, loading: !hasItems, error: false } : initialState
    })
    api
      .treeChildrenGet(space, folderPath, { signal: ac.signal })
      .then((step) => {
        if (ac.signal.aborted) {
          return
        }
        setState({ loading: false, error: false, folders: step.folders, notes: step.notes })
      })
      .catch(() => {
        if (!ac.signal.aborted) {
          setState((prev) => ({ ...prev, loading: false, error: true }))
        }
      })
    return () => ac.abort()
  }, [space, folderPath, reloadKey])

  const folderHref = useCallback((folder: TreeFolder) => folderPageHref(space, folder), [space])
  const hasItems = state.folders.length > 0 || state.notes.length > 0

  return (
    <section
      className={styles.summary}
      data-testid="folder-children-summary"
      aria-labelledby="folder-children-title"
    >
      <div className={styles.head}>
        <h2 id="folder-children-title">Contents</h2>
      </div>

      {state.loading && !hasItems ? (
        <div className={styles.skeleton} aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
      ) : state.error && !hasItems ? (
        <p className={styles.message}>Couldn’t load this folder.</p>
      ) : !hasItems ? (
        <p className={styles.message}>No child pages yet.</p>
      ) : (
        <ul className={styles.list}>
          {state.folders.map((folder) => (
            <FolderSummaryRow
              key={`folder:${folder.path}`}
              folder={folder}
              href={folderHref(folder)}
              isProject={!!projectAt(folder.path)}
            />
          ))}
          {state.notes.map((note) => {
            const href = noteRoute(note.id)

            if (!href) {
              return null
            }

            return (
              <li key={`note:${note.id}`}>
                <Link
                  className={styles.row}
                  to={href}
                  data-testid="folder-summary-note"
                  data-id={note.id}
                >
                  <IconDoc size={17} />
                  <span>{note.title}</span>
                  <IconChevron size={14} className={styles.chevron} />
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

const FolderSummaryRow = ({
  folder,
  href,
  isProject,
}: {
  folder: TreeFolder
  href: string
  isProject: boolean
}) => {
  const icon = isProject ? (
    <span
      className={styles.projectIcon}
      title="Project"
      data-testid="project-badge"
      aria-label="Project"
    >
      <IconFolderKanban size={17} />
    </span>
  ) : (
    <IconFolder size={17} />
  )
  return (
    <li>
      <Link
        className={styles.row}
        to={href}
        data-testid="folder-summary-folder"
        data-path={folder.path}
      >
        {icon}
        <span>{folder.name}</span>
        <IconChevron size={14} className={styles.chevron} />
      </Link>
    </li>
  )
}
