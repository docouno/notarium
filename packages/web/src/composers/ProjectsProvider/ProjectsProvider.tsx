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
import type { ProjectRow } from '@notarium/contract'
import { canWriteSpace } from '../../libs/access'
import { api } from '../../services/api'
import { useAuth } from '../AuthProvider'
import { useSpace } from '../SpaceProvider'

// The projects layer's client half (#13): which folders of the ACTIVE space are
// marked as projects, plus the human management acts (mark/unmark). One source
// of truth shared by the tree (badges + the folder context menu) and the
// space-management Projects tab — marking a folder in the tree updates the list,
// and vice versa, without each surface re-fetching on its own. Space-scoped:
// re-fetched whenever the active space changes (a project belongs to one space,
// #16). The agent never marks containers — this is the human's act (the same
// POST/DELETE /api/s/<slug>/projects the REST contract exposes).
//
// Refresh triggers: space switch, our own mark/unmark (optimistic + a reconciling
// GET), and a folder move/rename (its write-through re-prefixes the path, #13 I3).
// There is no projects SSE channel — projects change rarely and only by an
// explicit human act — so a change made in ANOTHER tab/by an agent/by a boot
// marker-reconcile is picked up on the next space switch or page load, not live.
// That's an accepted limit for a human-managed, slow-changing registry.

export type ProjectsContextValue = {
  /** The active space's projects (null = not loaded yet / a failed load). */
  projects: ProjectRow[] | null
  /** The space the current `projects` snapshot belongs to. Lets space-free pages
   *  avoid acting on a stale project list during a workspace re-anchor. */
  projectsSpace: string
  /** A load error, if the last fetch failed (the management tab surfaces it). */
  error: string | null
  /** May this principal mark/unmark/create projects in the active space? Marking
   *  is a `space:write` act, so this is exactly `can(space:write)` — a writer or
   *  owner, the single principal on a 'none' host, or one's own personal domain.
   *  A reader (and a host-admin who is only a reader/non-member) sees projects —
   *  a structural fact — but not the actions: the server would reject them. */
  canManage: boolean
  /** Re-fetch the space's projects. Called after a folder move/rename, whose
   *  write-through re-prefixes the project's path server-side (#13 I3). */
  reload: () => Promise<void>
  /** The project whose folder path is exactly `path` ('' = the root project);
   *  undefined while the list is loading or if the folder isn't a project. */
  projectAt: (path: string) => ProjectRow | undefined
  /** Mark a folder ('' = the space root) as a project — write-through marker +
   *  registry row (idempotent). Refreshes the list and returns the row. */
  mark: (folderPath: string, displayName?: string) => Promise<ProjectRow>
  /** Create a NEW empty project (#13 C): mint a fresh folder named `name` (the
   *  marker write mkdir's it) + register it. Throws if the folder already
   *  exists. Refreshes the list and returns the row. */
  create: (name: string) => Promise<ProjectRow>
  /** Unmark a project by id (removes the marker + the row). Refreshes the list. */
  unmark: (id: string) => Promise<void>
  /** Rename a project by id (#100 phase 2) — change its handle slug and/or displayName.
   *  A changed slug retires the old one into the alias history (old `space/<slug>`
   *  keeps resolving). Throws on a slug collision / the root project. Refreshes. */
  rename: (id: string, patch: { slug?: string; displayName?: string }) => Promise<ProjectRow>
}

const ProjectsContext = createContext<ProjectsContextValue | null>(null)

export const useProjects = (): ProjectsContextValue => {
  const ctx = useContext(ProjectsContext)

  if (!ctx) {
    throw new Error('useProjects must be used within ProjectsProvider')
  }

  return ctx
}

export const ProjectsProvider = ({ children }: { children: ReactNode }) => {
  const { space } = useSpace()
  const { mode, me } = useAuth()
  const [projects, setProjects] = useState<ProjectRow[] | null>(null)
  const [projectsSpace, setProjectsSpace] = useState(space)
  const [error, setError] = useState<string | null>(null)

  // Marking is a space:write act — the SAME capability the POST/DELETE
  // /api/s/<slug>/projects endpoints require (authz space:write → role ≥ writer).
  // So the client gate is the exact mirror of can(space:write): canWriteSpace
  // (#111). Host-admin is deliberately NOT a shortcut here — the server's admin
  // override is for management/recovery (need:'owner'), never space:write, so
  // trusting `admin` would re-show actions the server then rejects (#121). A
  // reader (admin or not) sees badges but no actions.
  const canManage = canWriteSpace(me, mode, space)

  // Order responses by a monotonic request id, not by space slug: a fast
  // A→B→A switch (or a mark+reload racing a switch) leaves several GETs in
  // flight, and slug identity can't tell which is freshest — an older same-space
  // answer could paint over a newer one. Only the latest `reload` wins.
  const seq = useRef(0)

  const reload = useCallback(async () => {
    const my = ++seq.current

    try {
      const rows = await api.projectsGet(space)

      if (my !== seq.current) {
        return
      } // superseded by a later reload
      setProjects(rows)
      setProjectsSpace(space)
      setError(null)
    } catch (e) {
      if (my !== seq.current) {
        return
      }
      setProjectsSpace(space)
      setError((e as Error).message)
    }
  }, [space])

  // Re-fetch on every space switch (projects are space-scoped). Clear first so a
  // badge from the previous space can't linger over this one's tree.
  useEffect(() => {
    setProjects(null)
    setProjectsSpace(space)
    setError(null)
    void reload()
  }, [space, reload])

  const projectAt = useCallback(
    (path: string) => projects?.find((p) => p.path === path),
    [projects],
  )

  const mark = useCallback(
    async (folderPath: string, displayName?: string) => {
      const row = await api.markProject(space, folderPath, displayName)
      // Reflect the row NOW (the write already landed) so the badge/menu are
      // correct even if the reconciling GET below fails — reload() then replaces
      // this with server truth. Upsert by id and path (marking is idempotent).
      setProjects((prev) => [
        ...(prev ?? []).filter((p) => p.id !== row.id && p.path !== row.path),
        row,
      ])
      await reload()
      return row
    },
    [space, reload],
  )

  const create = useCallback(
    async (name: string) => {
      const folderPath = name.trim()
      // The typed name IS the folder path — slashes nest (#97/1a). We do NOT send
      // it as displayName: the server derives BOTH the displayName and the slug
      // from the folder's LAST segment, so `test/sub` yields slug `sub` anchored
      // on the target folder (not `test-sub` from slugifying the whole path).
      // create=true mkdir's the folder via the marker write.
      const row = await api.markProject(space, folderPath, undefined, true)
      setProjects((prev) => [
        ...(prev ?? []).filter((p) => p.id !== row.id && p.path !== row.path),
        row,
      ])
      await reload()
      return row
    },
    [space, reload],
  )

  const unmark = useCallback(
    async (id: string) => {
      await api.unmarkProject(space, id)
      // Drop it NOW so the badge clears even if the reconciling GET fails.
      setProjects((prev) => (prev ?? []).filter((p) => p.id !== id))
      await reload()
    },
    [space, reload],
  )

  const rename = useCallback(
    async (id: string, patch: { slug?: string; displayName?: string }) => {
      const row = await api.patchProject(space, id, patch)
      // Reflect the renamed row NOW (the write landed) so the tree badge / handle
      // are correct even if the reconciling GET fails; reload() then replaces it.
      setProjects((prev) => (prev ?? []).map((p) => (p.id === row.id ? row : p)))
      await reload()
      return row
    },
    [space, reload],
  )

  const value = useMemo<ProjectsContextValue>(
    () => ({
      projects,
      projectsSpace,
      error,
      canManage,
      reload,
      projectAt,
      mark,
      create,
      unmark,
      rename,
    }),
    [projects, projectsSpace, error, canManage, reload, projectAt, mark, create, unmark, rename],
  )
  return <ProjectsContext.Provider value={value}>{children}</ProjectsContext.Provider>
}
