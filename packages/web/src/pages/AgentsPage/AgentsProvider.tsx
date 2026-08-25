import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { Outlet, useLocation } from 'react-router'
import type {
  AgentSessions,
  MeAgentContext,
  MeAgentRolesResponse,
  MeAgentSkillsResponse,
} from '@notarium/contract'
import { useAgentsExplorer } from '../../composers/AgentsExplorerProvider'
import { useProjects } from '../../composers/ProjectsProvider'
import { IconAward, IconDrama, IconFolderKanban, IconUser } from '../../core/Icons'
import { Breadcrumbs, type Crumb } from '../../layouts/Breadcrumbs'
import { PageFrame } from '../../layouts/PageFrame'
import { SettingsLayout, type SettingsTab } from '../../layouts/SettingsLayout'
import {
  agentContextRoute,
  agentRolesRoute,
  agentSkillsRoute,
  agentsRoute,
  agentsSurfaceOf,
  isModifiedClick,
} from '../../libs/routing/routePaths'
import { api } from '../../services/api'
import { type AgentsSection, AgentsTabs } from './AgentsTabs'
import type { RoleCounts, SkillCounts } from './helpers/abilitiesMetric'
import { contextScopeSearch } from './helpers/contextScope'

// The Agents chrome (#243): a data layer over ALL Agents sections. It loads the small
// per-section summaries ONCE (personal context load + session rollup) and hands them to the
// section pill-bar, so each pill carries a live identity line (the tabs read poor
// without one) and switching sections never re-flashes them (the provider
// sits ABOVE the section routes, so it doesn't remount). No chrome of its own — it's a
// provider + <Outlet/>, so it composes under a future SHELL tab without a double topbar.

/** A distinct query counts as a "blind spot" only when it RECURS empty — a one-off zero
 *  result is normal retrieval, not a gap worth flagging: not every empty result is an error. */
export const RECURRING_MISS_MIN = 2

type AgentsSummaryData = {
  context: { loadedTokens: number; pins: number; memory: number } | null
  sessions: { active: number; total: number } | null
  // The pill's own shapes: the rollup and the line drawn from it name the same
  // counts, so a facet added to one cannot go missing from the other.
  roles: RoleCounts | null
  skills: SkillCounts | null
  loading: boolean
}

export type AgentsSummary = AgentsSummaryData & {
  updateContext: (context: MeAgentContext) => void
}

const contextSummaryOf = (ctx: MeAgentContext) => ({
  loadedTokens: ctx.loadedTokens,
  pins: ctx.pins.length,
  memory: ctx.memory.length,
})

const sessionsSummaryOf = (sessions: AgentSessions) => ({
  active: sessions.active,
  total: sessions.total,
})

const rolesSummaryOf = (roles: MeAgentRolesResponse) => ({
  count: roles.facets.source.owned,
  activeRole: roles.activeRole,
  truncated: roles.truncated ?? false,
})

const skillsSummaryOf = (skills: MeAgentSkillsResponse) => ({
  count: skills.facets.source.owned,
  truncated: skills.truncated ?? false,
})

const noopUpdate = () => {}

const AgentsSummaryContext = createContext<AgentsSummary>({
  context: null,
  sessions: null,
  roles: null,
  skills: null,
  loading: true,
  updateContext: noopUpdate,
})

export const useAgentsSummary = (): AgentsSummary => useContext(AgentsSummaryContext)

type AgentsShellSlots = {
  actionsHost: HTMLElement | null
  /** The aside toggle's own slot, kept to the RIGHT of the page's actions. Two hosts
   *  rather than one, because a portal appends its children when it MOUNTS: a page whose
   *  actions arrive with its data (every state-bearing route since #393) would otherwise
   *  land them past a toggle that mounted with the panel a moment earlier. */
  toggleHost: HTMLElement | null
  asideHost: HTMLElement | null
  setContentInert: (inert: boolean) => void
  setBreadcrumbTail: (tail: Crumb | null) => void
}

const AgentsShellContext = createContext<AgentsShellSlots>({
  actionsHost: null,
  toggleHost: null,
  asideHost: null,
  setContentInert: () => {},
  setBreadcrumbTail: () => {},
})

export const useAgentsShell = (): AgentsShellSlots => useContext(AgentsShellContext)

export const AgentsChrome = () => {
  const [summary, setSummary] = useState<AgentsSummaryData>({
    context: null,
    sessions: null,
    roles: null,
    skills: null,
    loading: true,
  })
  const sessionsVersion = useRef(0)
  const location = useLocation()
  const { projects } = useProjects()
  const { revealNatural, scope, versions } = useAgentsExplorer()
  const [actionsHost, setActionsHost] = useState<HTMLElement | null>(null)
  const [toggleHost, setToggleHost] = useState<HTMLElement | null>(null)
  const [asideHost, setAsideHost] = useState<HTMLElement | null>(null)
  const [contentInert, setContentInert] = useState(false)
  const [breadcrumbTail, setBreadcrumbTailState] = useState<{
    path: string
    tail: Crumb | null
  }>({ path: '', tail: null })
  const setBreadcrumbTail = useCallback(
    (tail: Crumb | null) => setBreadcrumbTailState({ path: location.pathname, tail }),
    [location.pathname],
  )

  const updateContext = useCallback((context: MeAgentContext) => {
    setSummary((prev) => ({ ...prev, context: contextSummaryOf(context), loading: false }))
  }, [])

  // Every entry route needs the cheap rollup, so it is read here once and only
  // here: a summary of the SECTION cannot be taken from whatever the library page
  // is currently showing, or a filter would rewrite the count of what exists.
  useEffect(() => {
    if (!scope) {
      return undefined
    }
    const requestedSessionsVersion = sessionsVersion.current
    let alive = true

    void (async () => {
      const [ctx, sessions] = await Promise.all([
        api.meAgentContextGet().catch(() => null),
        api.agentSessionsGet({ limit: 1, aggregates: '0' }).catch(() => null),
      ])

      if (!alive) {
        return
      }
      setSummary((prev) => ({
        ...prev,
        context: ctx ? contextSummaryOf(ctx) : null,
        sessions:
          sessionsVersion.current === requestedSessionsVersion
            ? sessions
              ? sessionsSummaryOf(sessions)
              : null
            : prev.sessions,
        loading: false,
      }))
    })()

    return () => {
      alive = false
    }
  }, [scope])

  // The counts ride on the unfiltered listing's facets, so one row is enough — the
  // page of items is not what is being read here.
  useEffect(() => {
    // The rollup is the SECTION's, and the section is the active Space's — so it waits
    // for the scope instead of asking the owner-global question and discarding it.
    if (!scope) {
      return undefined
    }
    let alive = true

    void api
      .agentRolesGet({ ...scope, limit: 1 })
      .then((roles) => {
        if (alive) {
          setSummary((prev) => ({ ...prev, roles: rolesSummaryOf(roles), loading: false }))
        }
      })
      .catch(() => {
        if (alive) {
          setSummary((prev) => ({ ...prev, roles: null, loading: false }))
        }
      })

    return () => {
      alive = false
    }
  }, [scope, versions.roles])

  useEffect(() => {
    if (!scope) {
      return undefined
    }
    let alive = true

    void api
      .agentSkillsGet({ ...scope, limit: 1 })
      .then((skills) => {
        if (alive) {
          setSummary((prev) => ({ ...prev, skills: skillsSummaryOf(skills), loading: false }))
        }
      })
      .catch(() => {
        if (alive) {
          setSummary((prev) => ({ ...prev, skills: null, loading: false }))
        }
      })

    return () => {
      alive = false
    }
  }, [scope, versions.skills])

  useEffect(() => {
    if (sessionsVersion.current === versions.sessions) {
      return undefined
    }
    sessionsVersion.current = versions.sessions
    const requestedVersion = versions.sessions
    let alive = true

    void api
      .agentSessionsGet({ limit: 1, aggregates: '0' })
      .then((sessions) => {
        if (alive && sessionsVersion.current === requestedVersion) {
          setSummary((prev) => ({
            ...prev,
            sessions: sessionsSummaryOf(sessions),
            loading: false,
          }))
        }
      })
      .catch(() => {})

    return () => {
      alive = false
    }
  }, [versions.sessions])

  const surface = agentsSurfaceOf(location.pathname)
  const memorySurface = surface?.memoryNote === true
  const section: AgentsSection = surface?.section ?? 'abilities'
  const abilityKind = surface?.abilityKind ?? 'roles'
  const groups = useMemo<SettingsTab[][] | undefined>(() => {
    if (section === 'abilities') {
      return [
        [
          {
            id: 'roles',
            label: 'Roles',
            icon: <IconDrama size={15} />,
            onClick: (event) => {
              if (!isModifiedClick(event)) {
                revealNatural('roles')
              }
            },
          },
          {
            id: 'skills',
            label: 'Skills',
            icon: <IconAward size={15} />,
            onClick: (event) => {
              if (!isModifiedClick(event)) {
                revealNatural('skills')
              }
            },
          },
        ],
      ]
    }
    if (section === 'activity') {
      return undefined
    }
    const projectTabs = (projects ?? [])
      .filter((project) => project.slug !== 'personal')
      .map((project) => ({
        id: project.slug,
        label: project.displayName,
        icon: <IconFolderKanban size={14} />,
      }))
    return projectTabs.length
      ? [[{ id: 'personal', label: 'Personal', icon: <IconUser size={14} /> }], projectTabs]
      : [[{ id: 'personal', label: 'Personal', icon: <IconUser size={14} /> }]]
  }, [projects, revealNatural, section])
  const routeFor = useCallback(
    (id: string) => {
      if (section === 'abilities') {
        const route = id === 'skills' ? agentSkillsRoute() : agentRolesRoute()
        return `${route}${location.search}`
      }

      return `${agentContextRoute(id)}${memorySurface ? '' : contextScopeSearch(location.search)}`
    },
    [location.search, memorySurface, section],
  )
  const contextPathScope = location.pathname.startsWith('/agents/context/')
    ? decodeURIComponent(location.pathname.slice('/agents/context/'.length).split('/')[0] ?? '')
    : 'personal'
  const contextScope = memorySurface
    ? new URLSearchParams(location.search).get('context') || 'personal'
    : contextPathScope
  const contextProject = (projects ?? []).find(
    (project) => project.handle === contextScope || project.slug === contextScope,
  )
  const currentTail = breadcrumbTail.path === location.pathname ? breadcrumbTail.tail : null
  const trail: Crumb[] =
    section === 'abilities'
      ? [
          { label: 'Agents', href: agentsRoute() },
          { label: 'Abilities', href: agentRolesRoute() },
          {
            label: abilityKind === 'skills' ? 'Skills' : 'Roles',
            href: abilityKind === 'skills' ? agentSkillsRoute() : agentRolesRoute(),
          },
          ...(currentTail ? [currentTail] : []),
        ]
      : section === 'activity'
        ? [
            { label: 'Agents', href: agentsRoute() },
            { label: 'Activity', href: `${agentsRoute('activity')}${location.search}` },
            ...(currentTail ? [currentTail] : []),
          ]
        : memorySurface
          ? [
              { label: 'Agents', href: agentsRoute() },
              { label: 'Context', href: agentContextRoute(contextProject?.slug ?? 'personal') },
              { label: 'Memory' },
              ...(currentTail ? [currentTail] : []),
            ]
          : [
              { label: 'Agents', href: agentsRoute() },
              { label: 'Context', href: agentContextRoute() },
              { label: contextProject?.displayName ?? 'Personal' },
              ...(currentTail ? [currentTail] : []),
            ]
  const activeId =
    section === 'abilities'
      ? abilityKind
      : section === 'context'
        ? (contextProject?.slug ?? 'personal')
        : undefined

  return (
    <AgentsSummaryContext.Provider value={{ ...summary, updateContext }}>
      <AgentsShellContext.Provider
        value={{ actionsHost, toggleHost, asideHost, setContentInert, setBreadcrumbTail }}
      >
        <PageFrame
          topbarLeft={<Breadcrumbs trail={trail} spaceLess />}
          topbarActions={
            <>
              <div ref={setActionsHost} style={{ display: 'contents' }} />
              <div ref={setToggleHost} style={{ display: 'contents' }} />
            </>
          }
          aside={<div ref={setAsideHost} style={{ display: 'contents' }} />}
          contentInert={contentInert}
        >
          <SettingsLayout
            trail={trail}
            sectionTabs={<AgentsTabs active={section} />}
            groups={groups}
            routeFor={routeFor}
            activeId={activeId}
            testIdPrefix={section === 'abilities' ? 'agent-library' : 'context-scope'}
            framed={false}
          >
            <Outlet />
          </SettingsLayout>
        </PageFrame>
      </AgentsShellContext.Provider>
    </AgentsSummaryContext.Provider>
  )
}
