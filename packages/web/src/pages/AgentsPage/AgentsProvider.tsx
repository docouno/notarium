import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { Outlet, useLocation } from 'react-router'
import type { AgentSessions, MeAgentContext, MeAgentRolesResponse } from '@notarium/contract'
import { api } from '../../services/api'

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
  roles: { count: number; activeRole: string | null; truncated: boolean } | null
  loading: boolean
}

export type AgentsSummary = AgentsSummaryData & {
  updateContext: (context: MeAgentContext) => void
  updateRoles: (roles: MeAgentRolesResponse) => void
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
  count: roles.roles.length,
  activeRole: roles.activeRole,
  truncated: roles.truncated ?? false,
})

const noopUpdate = () => {}

const AgentsSummaryContext = createContext<AgentsSummary>({
  context: null,
  sessions: null,
  roles: null,
  loading: true,
  updateContext: noopUpdate,
  updateRoles: noopUpdate,
})

export const useAgentsSummary = (): AgentsSummary => useContext(AgentsSummaryContext)

export const AgentsChrome = () => {
  // The landing section, captured once (the chrome mounts ABOVE the section routes, so it
  // never remounts on an in-area switch — this stays the entry route).
  const landingPath = useRef(useLocation().pathname).current
  const [summary, setSummary] = useState<AgentsSummaryData>({
    context: null,
    sessions: null,
    roles: null,
    loading: true,
  })
  const rolesVersion = useRef(0)

  const updateContext = useCallback((context: MeAgentContext) => {
    setSummary((prev) => ({ ...prev, context: contextSummaryOf(context), loading: false }))
  }, [])

  const updateRoles = useCallback((roles: MeAgentRolesResponse) => {
    rolesVersion.current++
    setSummary((prev) => ({ ...prev, roles: rolesSummaryOf(roles), loading: false }))
  }, [])

  // Every section uses the same cheap one-row rollup. The Activity stream reads a
  // different endpoint, so it cannot feed this summary as the old overview did.
  useEffect(() => {
    const onRoles = landingPath.startsWith('/agents/roles')
    const requestedRolesVersion = rolesVersion.current
    let alive = true

    void (async () => {
      const [ctx, sessions, roles] = await Promise.all([
        api.meAgentContextGet().catch(() => null),
        api.agentSessionsGet({ limit: 1, aggregates: '0' }).catch(() => null),
        onRoles ? Promise.resolve(undefined) : api.agentRolesGet().catch(() => null),
      ])

      if (!alive) {
        return
      }
      setSummary((prev) => ({
        context: ctx ? contextSummaryOf(ctx) : null,
        sessions: sessions ? sessionsSummaryOf(sessions) : null,
        roles:
          roles === undefined || rolesVersion.current !== requestedRolesVersion
            ? prev.roles
            : roles
              ? rolesSummaryOf(roles)
              : null,
        loading: false,
      }))
    })()

    return () => {
      alive = false
    }
  }, [landingPath])

  return (
    <AgentsSummaryContext.Provider value={{ ...summary, updateContext, updateRoles }}>
      <Outlet />
    </AgentsSummaryContext.Provider>
  )
}
