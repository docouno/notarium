import { useCallback, useEffect, useRef, useState } from 'react'
import { Outlet, useOutletContext, useParams, useSearchParams } from 'react-router'
import type {
  AgentAuditQueryStat,
  AgentRetrievalTool,
  AgentSessionEventAggregates,
} from '@notarium/contract'
import { useAgentsExplorer } from '../../composers/AgentsExplorerProvider'
import { useChrome } from '../../composers/ChromeProvider'
import { CHANGED_COALESCE_MS } from '../../composers/SyncProvider'
import type { AsidePanelDef } from '../../core/AsideGroups'
import { STORAGE_KEYS } from '../../libs/storageKeys'
import { api } from '../../services/api'
import { ActivityDiagnostics, ActivityFilters } from './ActivityAside'
import {
  type ActivityPatch,
  type ActivityState,
  canonicalActivityParams,
  patchActivityState,
  readActivityState,
} from './activityState'
import { AgentsPanel } from './AgentsPanel'
import { useAgentsShell } from './AgentsProvider'

const ACTIVITY_LAYOUT = [{ panels: ['filters', 'diagnostics'], activeTab: 'filters' }]

type ActivityFrameContext = {
  state: ActivityState
  searchParams: URLSearchParams
  sessionsVersion: number
  setState: (patch: ActivityPatch) => void
  setDetailTitle: (title: string | null) => void
}

export const useActivityFrame = (): ActivityFrameContext => useOutletContext<ActivityFrameContext>()

/** One route-level shell for the complete Activity section. Overview/episode
 *  navigation swaps only the outlet, so the aside, its loaded diagnostics and
 *  the centre-column geometry remain alive. */
export const ActivityFrame = () => {
  const { id } = useParams<{ id: string }>()
  const [searchParams, setSearchParams] = useSearchParams()
  const state = readActivityState(searchParams)
  const { asideOpen } = useChrome()
  const { versions } = useAgentsExplorer()
  const observedSessionsVersion = useRef(versions.sessions)
  const [sessionsVersion, setSessionsVersion] = useState(versions.sessions)
  const sessionsVersionTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const aggregateFlight = useRef<{ version: number; controller: AbortController } | null>(null)
  const aggregateTrailingVersion = useRef<number | null>(null)
  const aggregateRequestedVersion = useRef(-1)
  const aggregateRunner = useRef<(version: number) => void>(() => {})
  const [aggregates, setAggregates] = useState<AgentSessionEventAggregates | null>(null)
  const [aggregateStatus, setAggregateStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>(
    'idle',
  )
  const { setBreadcrumbTail } = useAgentsShell()
  const setDetailTitle = useCallback(
    (title: string | null) => setBreadcrumbTail(title ? { label: title } : null),
    [setBreadcrumbTail],
  )

  useEffect(() => {
    if (observedSessionsVersion.current === versions.sessions) {
      return undefined
    }
    observedSessionsVersion.current = versions.sessions
    if (sessionsVersionTimer.current) {
      return undefined
    }
    sessionsVersionTimer.current = setTimeout(() => {
      sessionsVersionTimer.current = null
      setSessionsVersion(observedSessionsVersion.current)
    }, CHANGED_COALESCE_MS)

    return undefined
  }, [versions.sessions])

  useEffect(
    () => () => {
      if (sessionsVersionTimer.current) {
        clearTimeout(sessionsVersionTimer.current)
        sessionsVersionTimer.current = null
      }
    },
    [],
  )

  const startAggregateLoad = useCallback((version: number) => {
    const controller = new AbortController()
    aggregateFlight.current = { version, controller }
    setAggregateStatus('loading')
    void api
      .agentSessionEventsGet('all', { limit: 1, aggregates: '1' }, controller.signal)
      .then((next) => {
        if (controller.signal.aborted || aggregateRequestedVersion.current > version) {
          return
        }
        if (!next.aggregates) {
          setAggregateStatus('error')
          return
        }
        setAggregates(next.aggregates)
        setAggregateStatus('ready')
      })
      .catch(() => {
        if (!controller.signal.aborted && aggregateRequestedVersion.current <= version) {
          setAggregateStatus('error')
        }
      })
      .finally(() => {
        if (aggregateFlight.current?.controller !== controller) {
          return
        }
        aggregateFlight.current = null
        const trailing = aggregateTrailingVersion.current
        aggregateTrailingVersion.current = null

        if (trailing != null) {
          aggregateRunner.current(trailing)
        }
      })
  }, [])
  aggregateRunner.current = startAggregateLoad

  const loadAggregates = useCallback((version: number, force = false) => {
    if (!force && version <= aggregateRequestedVersion.current) {
      return
    }
    aggregateRequestedVersion.current = Math.max(aggregateRequestedVersion.current, version)
    const flight = aggregateFlight.current

    if (flight) {
      if (version > flight.version) {
        aggregateTrailingVersion.current = Math.max(
          aggregateTrailingVersion.current ?? version,
          version,
        )
      }

      return
    }

    aggregateRunner.current(version)
  }, [])

  useEffect(() => {
    if (!asideOpen && !aggregates) {
      return undefined
    }
    // A task boundary lets StrictMode discard its rehearsal effect before any
    // whole-history DB work starts; the real setup schedules the sole request.
    const timer = setTimeout(() => loadAggregates(sessionsVersion), 0)

    return () => clearTimeout(timer)
  }, [aggregates, asideOpen, loadAggregates, sessionsVersion])

  useEffect(() => {
    return () => {
      aggregateFlight.current?.controller.abort()
      aggregateFlight.current = null
      aggregateTrailingVersion.current = null
    }
  }, [])

  const setState = useCallback(
    (patch: ActivityPatch) => {
      setSearchParams(patchActivityState(searchParams, patch), { replace: true })
    },
    [searchParams, setSearchParams],
  )

  useEffect(() => {
    const canonical = canonicalActivityParams(searchParams)

    if (canonical.toString() !== searchParams.toString()) {
      setSearchParams(canonical, { replace: true })
    }
  }, [searchParams, setSearchParams])

  useEffect(() => {
    if (!id) {
      setDetailTitle(null)
    }
  }, [id, setDetailTitle])

  const applyFilter = useCallback(
    (patch: ActivityPatch) => {
      setState(patch)
    },
    [setState],
  )

  const selectDiagnostic = useCallback(
    (stat: AgentAuditQueryStat) => {
      const selected = state.tool === stat.tool && state.q === stat.query
      applyFilter({
        group: 'none',
        show: 'reads',
        tool: selected ? null : stat.tool,
        q: selected ? null : stat.query,
      })
    },
    [applyFilter, state.q, state.tool],
  )

  const setQuery = useCallback(
    (tool: AgentRetrievalTool | null, q: string | null) =>
      applyFilter({ tool, q, show: q ? 'reads' : state.show }),
    [applyFilter, state.show],
  )

  const aggregateAgents = aggregates?.agents ?? []
  const filterAgents = aggregateAgents.some((item) => item.agent === state.agent)
    ? aggregateAgents
    : state.agent
      ? [{ agent: state.agent, count: undefined }, ...aggregateAgents]
      : aggregateAgents
  const panels: AsidePanelDef[] = [
    {
      id: 'filters',
      label: 'Filters',
      render: () => (
        <ActivityFilters
          state={state}
          agents={filterAgents}
          onAgent={(agent) => applyFilter({ agent })}
          onQuery={setQuery}
          onTool={(tool) => applyFilter({ tool })}
        />
      ),
    },
    {
      id: 'diagnostics',
      label: 'Diagnostics',
      render: () => (
        <ActivityDiagnostics
          aggregates={aggregates}
          loading={aggregateStatus === 'loading'}
          failed={aggregateStatus === 'error'}
          state={state}
          onSelect={selectDiagnostic}
          onRetry={() => loadAggregates(sessionsVersion, true)}
          onProblem={(tool) =>
            applyFilter({ group: 'none', show: 'all', tool, q: null, outcome: 'errors' })
          }
        />
      ),
    },
  ]
  return (
    <>
      <Outlet context={{ state, searchParams, sessionsVersion, setState, setDetailTitle }} />
      <AgentsPanel
        panels={panels}
        defaultLayout={ACTIVITY_LAYOUT}
        storageKey={STORAGE_KEYS.activityAsideGroups}
        label="activity panels"
      />
    </>
  )
}
