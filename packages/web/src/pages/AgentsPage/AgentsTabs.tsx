import { useAgentsExplorer } from '../../composers/AgentsExplorerProvider'
import { IconHistory, IconScrollText, IconSparkles } from '../../core/Icons'
import { type PillTab, PillTabs } from '../../core/PillTabs'
import {
  agentActivityRoute,
  agentContextRoute,
  agentRolesRoute,
  isModifiedClick,
} from '../../libs/routing/routePaths'
import { useAgentsSummary } from './AgentsProvider'
import { abilitiesMetric } from './helpers/abilitiesMetric'

// The Agents section nav: package library first, then eager Context and
// owner-global Activity. Roles and Skills are two routed views under one pill.
export type AgentsSection = 'abilities' | 'context' | 'activity'

const fmtTokens = (n: number): string =>
  n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n)

export const AgentsTabs = ({ active }: { active: AgentsSection }) => {
  const { context, sessions, roles, skills, loading } = useAgentsSummary()
  const { revealNatural } = useAgentsExplorer()

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

  const packageMetric = abilitiesMetric(roles, skills) ?? (loading ? '…' : undefined)

  const tabs: PillTab[] = [
    {
      key: 'abilities',
      to: agentRolesRoute(),
      label: 'Abilities',
      icon: <IconSparkles size={15} />,
      metric: packageMetric,
      testId: 'agents-tab-roles',
      onClick: (event) => {
        if (!isModifiedClick(event)) {
          revealNatural('roles')
        }
      },
    },
    {
      key: 'context',
      to: agentContextRoute(),
      label: 'Context',
      icon: <IconScrollText size={15} />,
      metric: contextMetric,
      testId: 'agents-tab-context',
      onClick: (event) => {
        if (!isModifiedClick(event)) {
          revealNatural('memory')
        }
      },
    },
    {
      key: 'activity',
      to: agentActivityRoute(),
      label: 'Activity',
      icon: <IconHistory size={15} />,
      metric: sessionsMetric,
      testId: 'agents-tab-activity',
      onClick: (event) => {
        if (!isModifiedClick(event)) {
          revealNatural('sessions')
        }
      },
    },
  ]
  return <PillTabs tabs={tabs} activeKey={active} ariaLabel="Agents sections" />
}
