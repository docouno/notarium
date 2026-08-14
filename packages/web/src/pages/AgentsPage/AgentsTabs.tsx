import { IconBot, IconHistory, IconScrollText } from '../../core/Icons'
import { type PillTab, PillTabs } from '../../core/PillTabs'
import {
  agentActivityRoute,
  agentContextRoute,
  agentRolesRoute,
} from '../../libs/routing/routePaths'
import { useAgentsSummary } from './AgentsProvider'

// The Agents section nav (#243): a permanent pill-bar switching the Agents surface's
// top-level sections — Context (the eager-load constructor), Roles and Activity
// (the owner-global audit). The SAME PillTabs the dashboard uses. Each pill carries a
// live identity line from AgentsChrome (Activity = active + retained/archived episodes)
// so the bar reads as the surface's primary nav, not a bare toggle. Grows as Agents gains
// sections (roles/tokens) — each a routed `/agents/<section>`, SHELL-ready.

export type AgentsSection = 'context' | 'roles' | 'activity'

const fmtTokens = (n: number): string =>
  n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n)

export const AgentsTabs = ({ active }: { active: AgentsSection }) => {
  const { context, sessions, roles, loading } = useAgentsSummary()

  const contextMetric = context
    ? context.loadedTokens > 0
      ? `≈${fmtTokens(context.loadedTokens)} tokens loaded`
      : `${context.pins} pinned · ${context.memory} memory`
    : loading
      ? '…'
      : undefined

  const sessionsMetric = sessions
    ? sessions.total === 0
      ? 'no sessions yet'
      : sessions.active > 0
        ? `${sessions.active} active · ${sessions.total} session${sessions.total === 1 ? '' : 's'}`
        : `${sessions.total} session${sessions.total === 1 ? '' : 's'}`
    : loading
      ? '…'
      : undefined

  const rolesCountMetric = roles
    ? roles.truncated
      ? roles.count
        ? `${roles.count}+ roles`
        : 'partial role count'
      : `${roles.count} ${roles.count === 1 ? 'role' : 'roles'}${roles.count ? '' : ' added'}`
    : undefined
  const rolesMetric = roles
    ? `${rolesCountMetric}${roles.activeRole ? ` · ${roles.activeRole} active` : ''}`
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
      key: 'roles',
      to: agentRolesRoute(),
      label: 'Roles',
      icon: <IconBot size={15} />,
      metric: rolesMetric,
      testId: 'agents-tab-roles',
    },
    {
      key: 'activity',
      to: agentActivityRoute(),
      label: 'Activity',
      icon: <IconHistory size={15} />,
      metric: sessionsMetric,
      testId: 'agents-tab-activity',
    },
  ]
  return <PillTabs tabs={tabs} activeKey={active} ariaLabel="Agents sections" />
}
