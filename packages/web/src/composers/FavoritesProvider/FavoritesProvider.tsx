import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { FavoriteEntityKind, FavoriteItem, ProjectRow } from '@notarium/contract'
import { FAVORITE_ENTITY_KIND } from '@notarium/contract/enums'
import { STORE_EVENT } from '@notarium/contract/events'
import type { SkeletonNode } from '../../libs/tree/tree'
import { noteView, type NoteView } from '../../libs/wire'
import { api } from '../../services/api'
import { useNotes } from '../NotesProvider'
import { useSpace } from '../SpaceProvider'
import { useSync } from '../SyncProvider'

export type FavoritesContextValue = {
  items: FavoriteItem[]
  loading: boolean
  /** Has at least one load COMPLETED (successfully) for the current space? Mirrors
   *  the file tree's `treeLoaded` — distinguishes a fresh cold load from a
   *  successful-but-empty one, so a transient BACKGROUND-reload failure doesn't
   *  surface a cold-load error banner over a (possibly empty) known list (#42). */
  loaded: boolean
  error: string | null
  reload: () => Promise<void>
  isNoteFavorite: (id: string | null | undefined) => boolean
  isProjectFavorite: (id: string | null | undefined) => boolean
  folderFavorite: (path: string) => FavoriteItem | null
  toggleNote: (note: Pick<NoteView, 'id'>) => Promise<void>
  toggleProject: (project: ProjectRow) => Promise<void>
  toggleFolder: (folder: Pick<SkeletonNode, 'path' | 'id'>) => Promise<void>
  remove: (kind: FavoriteEntityKind, id: string) => Promise<void>
}

const FavoritesContext = createContext<FavoritesContextValue | null>(null)

export const useFavorites = (): FavoritesContextValue => {
  const ctx = useContext(FavoritesContext)

  if (!ctx) {
    throw new Error('useFavorites must be used within FavoritesProvider')
  }

  return ctx
}

const keyOf = (item: FavoriteItem): string => `${item.kind}:${item.id}`

export const FavoritesProvider = ({ children }: { children: ReactNode }) => {
  const { space } = useSpace()
  const { subscribe, connectionRevision, observationEpoch } = useSync()
  const { remember } = useNotes()
  const [items, setItems] = useState<FavoriteItem[]>([])
  const [loading, setLoading] = useState(true)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // A space switch swaps the whole set — until this space's first load COMPLETES,
  // `loaded` is false so the cold-load error branch can distinguish it from an
  // empty result. reload() (below) re-runs on the space change (it depends on space).
  useEffect(() => {
    setLoaded(false)
  }, [space])

  // Monotonic request id: reload() fires from three uncoordinated sources (initial /
  // space-change load, every sync 'changed' event, and post-mutation refreshes), so
  // an out-of-order GET must not clobber a newer snapshot (latest-wins), and a
  // BACKGROUND refresh must not flip `loading` — else the favorites tree flashes to a
  // skeleton on every unrelated note save while it's on screen (Sidebar gates the
  // favorites tree render on `favorites.loading`).
  const reqSeq = useRef(0)

  const reload = useCallback(
    async ({ background = false }: { background?: boolean } = {}) => {
      const seq = ++reqSeq.current
      const observedAt = Math.max(connectionRevision, observationEpoch())

      if (!background) {
        setLoading(true)
      }
      try {
        const res = await api.favoritesGet(space)

        if (seq !== reqSeq.current) {
          return
        } // superseded by a newer reload — drop this stale snapshot
        setItems(res.items)
        remember(
          res.items
            .filter((it) => it.kind === FAVORITE_ENTITY_KIND.note)
            .map((it) => noteView(it.note)),
          [],
          observedAt,
        )
        setError(null)
        setLoaded(true) // this space has now completed a successful load (cold state over)
      } catch (err) {
        if (seq !== reqSeq.current) {
          return
        }
        setError((err as Error).message || 'Could not load favorites')
      } finally {
        // Only the LATEST request owns `loading` — clears an initial/space-change load
        // even if a background refresh superseded it; a background refresh never set it.
        if (seq === reqSeq.current) {
          setLoading(false)
        }
      }
    },
    [space, remember, connectionRevision, observationEpoch],
  )

  useEffect(() => {
    void reload()
  }, [reload])

  useEffect(
    () =>
      subscribe((event) => {
        if (event.type === STORE_EVENT.CHANGED) {
          void reload({ background: true })
        }
      }),
    [subscribe, reload],
  )

  const byKey = useMemo(() => new Map(items.map((it) => [keyOf(it), it])), [items])
  const folderByPath = useMemo(() => {
    const map = new Map<string, FavoriteItem>()

    for (const it of items) {
      if (it.kind === FAVORITE_ENTITY_KIND.folder) {
        map.set(it.folder.path, it)
      }
      if (it.kind === FAVORITE_ENTITY_KIND.project) {
        map.set(it.project.path, it)
      }
    }

    return map
  }, [items])

  const remove = useCallback(
    async (kind: FavoriteEntityKind, id: string) => {
      await api.favoriteDelete(space, kind, id)
      // Background: an un-favorite must not flash the favorites tree to a skeleton
      // (Sidebar gates it on `loading`) — symmetric with the add paths (#42).
      await reload({ background: true })
    },
    [space, reload],
  )

  const toggleNote = useCallback(
    async (note: Pick<NoteView, 'id'>) => {
      if (byKey.has(`${FAVORITE_ENTITY_KIND.note}:${note.id}`)) {
        await remove(FAVORITE_ENTITY_KIND.note, note.id)
      } else {
        await api.favoritePut(space, { kind: FAVORITE_ENTITY_KIND.note, id: note.id })
        await reload({ background: true })
      }
    },
    [byKey, remove, reload, space],
  )

  const toggleProject = useCallback(
    async (project: ProjectRow) => {
      if (byKey.has(`${FAVORITE_ENTITY_KIND.project}:${project.id}`)) {
        await remove(FAVORITE_ENTITY_KIND.project, project.id)
      } else {
        await api.favoritePut(space, { kind: FAVORITE_ENTITY_KIND.project, id: project.id })
        await reload({ background: true })
      }
    },
    [byKey, remove, reload, space],
  )

  const toggleFolder = useCallback(
    async (folder: Pick<SkeletonNode, 'path' | 'id'>) => {
      const fav = folderByPath.get(folder.path)

      if (fav) {
        await remove(fav.kind, fav.id)
      } else {
        await api.favoritePut(space, {
          kind: FAVORITE_ENTITY_KIND.folder,
          id: folder.id,
          path: folder.path,
        })
        await reload({ background: true })
      }
    },
    [folderByPath, remove, reload, space],
  )

  const value = useMemo<FavoritesContextValue>(
    () => ({
      items,
      loading,
      loaded,
      error,
      reload,
      isNoteFavorite: (id) => Boolean(id && byKey.has(`${FAVORITE_ENTITY_KIND.note}:${id}`)),
      isProjectFavorite: (id) => Boolean(id && byKey.has(`${FAVORITE_ENTITY_KIND.project}:${id}`)),
      folderFavorite: (path) => folderByPath.get(path) ?? null,
      toggleNote,
      toggleProject,
      toggleFolder,
      remove,
    }),
    [
      byKey,
      error,
      folderByPath,
      items,
      loading,
      loaded,
      reload,
      remove,
      toggleFolder,
      toggleNote,
      toggleProject,
    ],
  )

  return <FavoritesContext.Provider value={value}>{children}</FavoritesContext.Provider>
}
