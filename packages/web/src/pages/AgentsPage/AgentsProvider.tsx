import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { Outlet, useLocation } from 'react-router'
import type { AgentAudit, MeAgentContext } from '@notarium/contract'
import { api } from '../../services/api'

// The Agents chrome (#243): a data layer over ALL Agents sections. It loads the small
// per-section summaries ONCE (personal context load + audit rollup) and hands them to the
// section pill-bar, so each pill carries a live identity line (the tabs read poor
// without one) and switching sections never re-flashes them (the provider
// sits ABOVE the section routes, so it doesn't remount). No chrome of its own — it's a
// provider + <Outlet/>, so it composes under a future SHELL tab without a double topbar.

/** A distinct query counts as a "blind spot" only when it RECURS empty — a one-off zero
 *  result is normal retrieval, not a gap worth flagging: not every empty result is an error. */
export const RECURRING_MISS_MIN = 2

type AgentsSummaryData = {
  context: { loadedTokens: number; pins: number; memory: number } | null
  audit: { totalCalls: number; totalQueries: number; blindSpots: number } | null
  loading: boolean
}

export type AgentsSummary = AgentsSummaryData & {
  updateAudit: (audit: AgentAudit) => void
  updateContext: (context: MeAgentContext) => void
}

const contextSummaryOf = (ctx: MeAgentContext) => ({
  loadedTokens: ctx.loadedTokens,
  pins: ctx.pins.length,
  memory: ctx.memory.length,
})

// Aggregates ride the first page only (null on an appended page) — a summary is only ever
// fed from a first-page 'all' response, but stay null-safe so a stray call can't throw.
const auditSummaryOf = (audit: AgentAudit) => ({
  totalCalls: audit.total,
  totalQueries: audit.aggregates?.totalQueries ?? 0,
  blindSpots: (audit.aggregates?.misses ?? []).filter((m) => m.misses >= RECURRING_MISS_MIN).length,
})

const noopUpdate = () => {}

const AgentsSummaryContext = createContext<AgentsSummary>({
  context: null,
  audit: null,
  loading: true,
  updateAudit: noopUpdate,
  updateContext: noopUpdate,
})

export const useAgentsSummary = (): AgentsSummary => useContext(AgentsSummaryContext)

export const AgentsChrome = () => {
  // The landing section, captured once (the chrome mounts ABOVE the section routes, so it
  // never remounts on an in-area switch — this stays the entry route).
  const landingPath = useRef(useLocation().pathname).current
  const [summary, setSummary] = useState<AgentsSummaryData>({
    context: null,
    audit: null,
    loading: true,
  })

  const updateAudit = useCallback((audit: AgentAudit) => {
    setSummary((prev) => ({ ...prev, audit: auditSummaryOf(audit), loading: false }))
  }, [])

  const updateContext = useCallback((context: MeAgentContext) => {
    setSummary((prev) => ({ ...prev, context: contextSummaryOf(context), loading: false }))
  }, [])

  // On landing, skip ONLY the audit summary when Audit is the active section — AuditPage feeds
  // it via updateAudit, and it's the expensive fetch (the whole-history aggregate scan). Context
  // is always fetched: it's cheap AND ContextPage feeds updateContext only from its PERSONAL
  // scope, so a project-scope landing would otherwise leave the Context pill blank.
  useEffect(() => {
    const onAudit = landingPath.startsWith('/agents/audit')
    let alive = true

    void (async () => {
      const [ctx, audit] = await Promise.all([
        api.meAgentContextGet().catch(() => null),
        onAudit ? Promise.resolve(undefined) : api.agentAuditGet({ limit: 1 }).catch(() => null),
      ])

      if (!alive) {
        return
      }
      setSummary((prev) => ({
        context: ctx ? contextSummaryOf(ctx) : null,
        audit: audit === undefined ? prev.audit : audit ? auditSummaryOf(audit) : null,
        loading: false,
      }))
    })()

    return () => {
      alive = false
    }
  }, [landingPath])

  return (
    <AgentsSummaryContext.Provider value={{ ...summary, updateAudit, updateContext }}>
      <Outlet />
    </AgentsSummaryContext.Provider>
  )
}
