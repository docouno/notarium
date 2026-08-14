import { useCallback, useEffect, useRef, useState } from 'react'
import { Outlet, useOutletContext, useParams, useSearchParams } from 'react-router'
import type {
  AgentAuditQueryStat,
  AgentRetrievalTool,
  AgentSessionEventAggregates,
} from '@notarium/contract'
import { useChrome } from '../../composers/ChromeProvider'
import { AsideGroups, type AsidePanelDef } from '../../core/AsideGroups'
import { IconPanelRight } from '../../core/Icons'
import { IconToggle } from '../../core/IconToggle'
import { type Crumb } from '../../layouts/Breadcrumbs'
import { SettingsLayout } from '../../layouts/SettingsLayout'
import { agentActivityRoute } from '../../libs/routing/routePaths'
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
import { AgentsTabs } from './AgentsTabs'

const ACTIVITY_LAYOUT = [{ panels: ['filters', 'diagnostics'], activeTab: 'filters' }]

type ActivityFrameContext = {
  state: ActivityState
  searchParams: URLSearchParams
  setState: (patch: ActivityPatch) => void
  setDetailTitle: (title: string | null) => void
}

export const useActivityFrame = (): ActivityFrameContext => useOutletContext<ActivityFrameContext>()

const useNarrowActivityAside = () => {
  const [narrow, setNarrow] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 720px)').matches,
  )

  useEffect(() => {
    const media = window.matchMedia('(max-width: 720px)')
    const update = () => setNarrow(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  return narrow
}

/** One route-level shell for the complete Activity section. Overview/episode
 *  navigation swaps only the outlet, so the aside, its loaded diagnostics and
 *  the centre-column geometry remain alive. */
export const ActivityFrame = () => {
  const { id } = useParams<{ id: string }>()
  const [searchParams, setSearchParams] = useSearchParams()
  const state = readActivityState(searchParams)
  const { asideOpen, toggleAside } = useChrome()
  const narrowAside = useNarrowActivityAside()
  const previousAsideOpen = useRef(asideOpen)
  const openerRef = useRef<HTMLButtonElement>(null)
  const aggregateAbort = useRef<AbortController | null>(null)
  const [aggregates, setAggregates] = useState<AgentSessionEventAggregates | null>(null)
  const [detailTitle, setDetailTitle] = useState<string | null>(null)
  const [aggregateStatus, setAggregateStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>(
    'idle',
  )
  const aggregateRequestSeq = useRef(0)
  const focusAsideOnOpen = asideOpen && !previousAsideOpen.current

  useEffect(() => {
    previousAsideOpen.current = asideOpen
  }, [asideOpen])

  const loadAggregates = useCallback(async () => {
    const seq = ++aggregateRequestSeq.current
    aggregateAbort.current?.abort()
    const controller = new AbortController()
    aggregateAbort.current = controller
    setAggregateStatus('loading')
    try {
      const next = await api.agentSessionEventsGet(
        'all',
        { limit: 1, aggregates: '1' },
        controller.signal,
      )

      if (seq !== aggregateRequestSeq.current) {
        return
      }
      if (!next.aggregates) {
        setAggregateStatus('error')
        return
      }
      setAggregates(next.aggregates)
      setAggregateStatus('ready')
    } catch {
      if (seq === aggregateRequestSeq.current && !controller.signal.aborted) {
        setAggregateStatus('error')
      }
    }
  }, [])

  useEffect(() => {
    if (asideOpen && aggregateStatus === 'idle') {
      void loadAggregates()
    }
  }, [aggregateStatus, asideOpen, loadAggregates])

  useEffect(
    () => () => {
      aggregateRequestSeq.current += 1
      aggregateAbort.current?.abort()
    },
    [],
  )

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
  }, [id])

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

  const closeAside = useCallback(() => {
    toggleAside()
    requestAnimationFrame(() => openerRef.current?.focus())
  }, [toggleAside])

  const openToggle = (
    <IconToggle
      ref={openerRef}
      icon={<IconPanelRight size={15} />}
      active={false}
      onClick={toggleAside}
      title="Open activity panels"
    />
  )
  const closeToggle = (
    <IconToggle
      icon={<IconPanelRight size={15} />}
      active
      onClick={closeAside}
      title="Close activity panels"
    />
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
          onRetry={() => void loadAggregates()}
        />
      ),
    },
  ]
  const aside = asideOpen ? (
    <AsideGroups
      panels={panels}
      defaultLayout={ACTIVITY_LAYOUT}
      storageKey={STORAGE_KEYS.activityAsideGroups}
      headerAction={closeToggle}
      overlayOnNarrow
      modal={narrowAside}
      onRequestClose={closeAside}
      autoFocus={focusAsideOnOpen || narrowAside}
    />
  ) : null
  const trail: Crumb[] = id
    ? [
        { label: 'Agents' },
        { label: 'Activity', href: agentActivityRoute(undefined, searchParams) },
        { label: detailTitle ?? 'Activity' },
      ]
    : [{ label: 'Agents' }, { label: 'Activity' }]

  return (
    <SettingsLayout
      trail={trail}
      spaceLess
      sectionTabs={<AgentsTabs active="activity" />}
      topbarActions={!asideOpen ? openToggle : undefined}
      aside={aside}
      contentInert={asideOpen && narrowAside}
      testIdPrefix={id ? 'activity-episode' : 'activity'}
    >
      <Outlet context={{ state, searchParams, setState, setDetailTitle }} />
    </SettingsLayout>
  )
}
