import { IconHistory, IconScrollText } from '../../core/Icons'
import { type PillTab, PillTabs } from '../../core/PillTabs'
import { agentAuditRoute, agentContextRoute } from '../../libs/routing/routePaths'
import { useAgentsSummary } from './AgentsProvider'

// The Agents section nav (#243): a permanent pill-bar switching the Agents surface's
// top-level sections — Context (the eager-load constructor, #165/#208) and Audit (the
// runtime-retrieval log). The SAME PillTabs the dashboard uses (content-width layout).
// Each pill carries a live identity line from the shared AgentsChrome summary (Context =
// its eager token load, Audit = query count + a soft amber dot when queries recur empty)
// so the bar reads as the surface's primary nav, not a bare toggle. Grows as Agents gains
// sections (roles/tokens) — each a routed `/agents/<section>`, SHELL-ready.

export type AgentsSection = 'context' | 'audit'

const fmtTokens = (n: number): string =>
  n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n)

export const AgentsTabs = ({ active }: { active: AgentsSection }) => {
  const { context, audit, loading } = useAgentsSummary()

  const contextMetric = context
    ? context.loadedTokens > 0
      ? `≈${fmtTokens(context.loadedTokens)} tokens loaded`
      : `${context.pins} pinned · ${context.memory} memory`
    : loading
      ? '…'
      : undefined

  const auditMetric = audit
    ? audit.totalCalls === 0
      ? 'no activity yet'
      : audit.blindSpots > 0
        ? `${audit.totalCalls} calls · ${audit.blindSpots} blind ${audit.blindSpots === 1 ? 'spot' : 'spots'}`
        : `${audit.totalCalls} calls`
    : loading
      ? '…'
      : undefined

  const tabs: PillTab[] = [
    {
      key: 'context',
      to: agentContextRoute(),
      label: 'Context',
      icon: <IconScrollText size={15} />,
      metric: contextMetric,
      testId: 'agents-tab-context',
    },
    {
      key: 'audit',
      to: agentAuditRoute(),
      label: 'Audit',
      icon: <IconHistory size={15} />,
      metric: auditMetric,
      warn: !!audit && audit.blindSpots > 0,
      testId: 'agents-tab-audit',
    },
  ]
  return <PillTabs tabs={tabs} activeKey={active} ariaLabel="Agents sections" />
}
