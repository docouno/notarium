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
import { useLocation } from 'react-router'
import type {
  AgentAbilitySummary,
  AgentSessionSummary,
  MeAgentRolesResponse,
} from '@notarium/contract'
import { STORE_EVENT } from '@notarium/contract/events'
import { agentsSurfaceOf } from '../../libs/routing/routePaths'
import { STORAGE_KEYS } from '../../libs/storageKeys'
import { useAuth } from '../AuthProvider'
import { useSpace } from '../SpaceProvider'
import { CHANGED_COALESCE_MS, useSync } from '../SyncProvider'

export type AgentsExplorerDataset = 'roles' | 'skills' | 'memory' | 'sessions'
export type AgentsExplorerMode = 'natural' | 'manual'

type AgentsExplorerState = {
  dataset: AgentsExplorerDataset
  mode: AgentsExplorerMode
}

/** How many pages the rows below were assembled from. A refresh re-reads exactly
 *  that many, so an invalidation costs the reader neither the pages they scrolled
 *  through nor their place in them. */
type Paged = { pages: number }

export type AgentsAbilityExplorerPage = Paged & {
  items: AgentAbilitySummary[]
  projects: MeAgentRolesResponse['projects']
  nextCursor: string | null
}

export type AgentsSessionExplorerPage = Paged & {
  items: AgentSessionSummary[]
  nextCursor: string | null
}

type AgentsExplorerCache = {
  roles: AgentsAbilityExplorerPage | null
  skills: AgentsAbilityExplorerPage | null
  memory: null
  sessions: AgentsSessionExplorerPage | null
}

/** The Space every Agents listing is scoped to. Null means NOT RESOLVED YET, never
 *  "ask globally": an unscoped listing is a different, bounded-global question whose
 *  answer the scoped one immediately replaces — three of them on every cold entry. */
export type AgentsExplorerScope = { spaceId: string }

/** The active Space, resolved by slug (or by a slug it used to answer to). Null while
 *  the space table does not name the active slug — the honest "not yet", which every
 *  listing waits on. */
export const resolveAgentsExplorerScope = (
  space: string,
  spaces: readonly { id: string; slug: string; aliases?: string[] }[],
  personalSpace: { id: string; slug: string } | null,
): AgentsExplorerScope | null => {
  const active =
    (personalSpace?.slug === space ? personalSpace : null) ??
    spaces.find((entry) => entry.slug === space || entry.aliases?.includes(space)) ??
    null

  return active ? { spaceId: active.id } : null
}

type AgentsExplorerContextValue = AgentsExplorerState & {
  scope: AgentsExplorerScope | null
  version: number
  versions: Readonly<Record<AgentsExplorerDataset, number>>
  cache: AgentsExplorerCache
  setAbilityPage: (dataset: 'roles' | 'skills', page: AgentsAbilityExplorerPage | null) => void
  setSessionPage: (page: AgentsSessionExplorerPage | null) => void
  revealNatural: (dataset?: AgentsExplorerDataset) => void
  selectManual: (dataset: AgentsExplorerDataset) => void
  /** Ask a dataset to re-read itself. The rows already on screen stay until the
   *  answer lands — an invalidation is a refresh, not a reset, so it must not be
   *  spelled as "throw everything away and start from page one". */
  invalidate: (dataset: AgentsExplorerDataset) => void
}

/** The reload key every Agents listing rides. Two things move it, and BOTH move all
 *  four datasets: an explicit invalidation (a live `CHANGED` frame, a write this tab
 *  just made) and a reconnect. The stream replays nothing it missed while it was
 *  down, so a successful open is the app's standing signal that every held answer is
 *  now unverified — the same fold four older readers already make (`useNotesState`,
 *  `useFeedState`, `FavoritesProvider`, `useGraphData`). Reading it from the
 *  invalidations alone left roles, skills and memory waiting for an unrelated change
 *  to tell them what the reconnect already had. */
export const agentsExplorerVersions = (
  invalidations: Readonly<Record<AgentsExplorerDataset, number>>,
  connectionRevision: number,
): Record<AgentsExplorerDataset, number> => ({
  roles: invalidations.roles + connectionRevision,
  skills: invalidations.skills + connectionRevision,
  memory: invalidations.memory + connectionRevision,
  sessions: invalidations.sessions + connectionRevision,
})

const AgentsExplorerContext = createContext<AgentsExplorerContextValue | null>(null)
const INITIAL_VERSIONS: Record<AgentsExplorerDataset, number> = {
  roles: 0,
  skills: 0,
  memory: 0,
  sessions: 0,
}
const INITIAL_CACHE: AgentsExplorerCache = {
  roles: null,
  skills: null,
  memory: null,
  sessions: null,
}

export const naturalAgentsExplorerDataset = (pathname: string): AgentsExplorerDataset => {
  const surface = agentsSurfaceOf(pathname)

  if (!surface) {
    return 'roles'
  }

  return surface.section === 'context'
    ? 'memory'
    : surface.section === 'activity'
      ? 'sessions'
      : surface.abilityKind
}

const isDataset = (value: unknown): value is AgentsExplorerDataset =>
  value === 'roles' || value === 'skills' || value === 'memory' || value === 'sessions'

export const agentsExplorerStorageKey = (owner: string, spaceId: string): string =>
  `${STORAGE_KEYS.agentsExplorerPrefix}${encodeURIComponent(owner)}:${spaceId}`

/** Collapsed explorer GROUPS, per owner + Space — a separate record from the dataset
 *  lens above so a malformed collapse map can never cost the user their lens. */
export const agentsExplorerGroupsStorageKey = (owner: string, spaceId: string): string =>
  `${STORAGE_KEYS.agentsExplorerPrefix}groups:${encodeURIComponent(owner)}:${spaceId}`

export const resolveAgentsExplorerState = (
  stored: string | null,
  natural: AgentsExplorerDataset,
): AgentsExplorerState => {
  try {
    const parsed = JSON.parse(stored ?? 'null') as Partial<AgentsExplorerState>

    if (isDataset(parsed?.dataset) && (parsed.mode === 'natural' || parsed.mode === 'manual')) {
      return parsed.mode === 'natural'
        ? { dataset: natural, mode: 'natural' }
        : { dataset: parsed.dataset, mode: 'manual' }
    }
  } catch {
    /* A malformed or blocked preference falls back to the route's natural lens. */
  }

  return { dataset: natural, mode: 'natural' }
}

const readState = (key: string, natural: AgentsExplorerDataset): AgentsExplorerState =>
  resolveAgentsExplorerState(localStorage.getItem(key), natural)

export const useAgentsExplorer = (): AgentsExplorerContextValue => {
  const value = useContext(AgentsExplorerContext)

  if (!value) {
    throw new Error('useAgentsExplorer must be used within AgentsExplorerProvider')
  }

  return value
}

export const AgentsExplorerProvider = ({ children }: { children: ReactNode }) => {
  const location = useLocation()
  const { me } = useAuth()
  const { space, spaces, personalSpace } = useSpace()
  const { subscribe, agentSessionsRev, connectionRevision } = useSync()
  const natural = naturalAgentsExplorerDataset(location.pathname)
  const activeSpace = resolveAgentsExplorerScope(space, spaces, personalSpace)
  // The stable account id, so explorer state survives a rename of the handle.
  const owner = me?.id ?? '@system'
  const storageKey = activeSpace ? agentsExplorerStorageKey(owner, activeSpace.spaceId) : null
  const [state, setState] = useState<AgentsExplorerState>({ dataset: natural, mode: 'natural' })
  const [stateStorageKey, setStateStorageKey] = useState<string | null>(null)
  const [invalidations, setInvalidations] = useState(INITIAL_VERSIONS)
  const [cache, setCache] = useState<AgentsExplorerCache>(INITIAL_CACHE)
  const observedSessionsRev = useRef(agentSessionsRev)

  useEffect(() => {
    setState(storageKey ? readState(storageKey, natural) : { dataset: natural, mode: 'natural' })
    setStateStorageKey(storageKey)
    // The lens preference is re-read per route (a route has a natural dataset), but the
    // CACHE belongs to owner + Space alone. Clearing it on a route change dropped the
    // rows a dataset had already loaded WITHOUT asking anyone to load them again — the
    // consumer's fetch effect is keyed on dataset/space/version, none of which moved —
    // so opening an entity from the explorer left the tree on a permanent skeleton.
  }, [natural, storageKey])

  useEffect(() => {
    setCache(INITIAL_CACHE)
  }, [storageKey])

  useEffect(() => {
    setState((current) =>
      current.mode === 'natural' && current.dataset !== natural
        ? { ...current, dataset: natural }
        : current,
    )
  }, [natural])

  useEffect(() => {
    if (!storageKey || stateStorageKey !== storageKey) {
      return
    }
    try {
      localStorage.setItem(storageKey, JSON.stringify(state))
    } catch {
      /* Preferences are best-effort. */
    }
  }, [state, stateStorageKey, storageKey])

  const revealNatural = useCallback(
    (dataset?: AgentsExplorerDataset) => {
      setState({ dataset: dataset ?? natural, mode: 'natural' })
    },
    [natural],
  )
  const selectManual = useCallback((dataset: AgentsExplorerDataset) => {
    setState({ dataset, mode: 'manual' })
  }, [])
  // Identity-stable on purpose: the SSE subscription below is torn down and rebound
  // whenever this changes, and its cleanup clears the coalescing timer — so an
  // `invalidate` that moved with the active lens dropped events that arrived just
  // before the user switched datasets.
  const invalidate = useCallback((dataset: AgentsExplorerDataset) => {
    setInvalidations((current) => ({ ...current, [dataset]: current[dataset] + 1 }))
  }, [])
  const setAbilityPage = useCallback(
    (dataset: 'roles' | 'skills', page: AgentsAbilityExplorerPage | null) => {
      setCache((current) => ({ ...current, [dataset]: page }))
    },
    [],
  )
  const setSessionPage = useCallback((page: AgentsSessionExplorerPage | null) => {
    setCache((current) => ({ ...current, sessions: page }))
  }, [])

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const unsubscribe = subscribe((event) => {
      if (event.type !== STORE_EVENT.CHANGED || timer) {
        return
      }
      timer = setTimeout(() => {
        timer = null
        invalidate('roles')
        invalidate('skills')
        invalidate('memory')
      }, CHANGED_COALESCE_MS)
    })

    return () => {
      if (timer) {
        clearTimeout(timer)
      }
      unsubscribe()
    }
  }, [invalidate, subscribe])

  useEffect(() => {
    if (observedSessionsRev.current === agentSessionsRev) {
      return
    }
    observedSessionsRev.current = agentSessionsRev
    invalidate('sessions')
  }, [agentSessionsRev, invalidate])

  // Referentially stable: every listing effect keys on it, and a fresh object per
  // provider render would make each landed page ask for itself again.
  const spaceId = activeSpace?.spaceId ?? null
  const scope = useMemo<AgentsExplorerScope | null>(() => (spaceId ? { spaceId } : null), [spaceId])
  const versions = useMemo(
    () => agentsExplorerVersions(invalidations, connectionRevision),
    [connectionRevision, invalidations],
  )
  const value = useMemo<AgentsExplorerContextValue>(
    () => ({
      ...state,
      scope,
      version: versions[state.dataset],
      versions,
      cache,
      setAbilityPage,
      setSessionPage,
      revealNatural,
      selectManual,
      invalidate,
    }),
    [
      state,
      scope,
      versions,
      cache,
      setAbilityPage,
      setSessionPage,
      revealNatural,
      selectManual,
      invalidate,
    ],
  )

  return <AgentsExplorerContext.Provider value={value}>{children}</AgentsExplorerContext.Provider>
}
