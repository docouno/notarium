import { useEffect, useState } from 'react'
import type {
  AgentAuditQueryStat,
  AgentRetrievalTool,
  AgentSessionAgentStat,
  AgentSessionEventAggregates,
} from '@notarium/contract'
import { AGENT_RETRIEVAL_TOOL } from '@notarium/contract/enums'
import type { ToolName } from '@notarium/contract/tools'
import { AsideSection, AsideSections } from '../../core/AsidePanel'
import { Button } from '../../core/Button'
import { IconX } from '../../core/Icons'
import { Notice } from '../../core/Notice'
import { SearchField } from '../../core/SearchField'
import { Segmented } from '../../core/Segmented'
import { Select } from '../../core/Select'
import { FolderTree } from '../../widgets/FolderTree'
import { ACTIVITY_TOOL_NAMES, type ActivityState } from './activityState'
import { RECURRING_MISS_MIN } from './AgentsProvider'
import { QueryStatRow } from './AuditRows'
import { PanelsSkeleton } from './AuditSkeletons'
import styles from './ActivityAside.module.scss'

const QUERY_FILTER_DEBOUNCE_MS = 300
const NO_EXPANDED_AGENTS = new Set<string>()
type QueryTool = AgentRetrievalTool | 'all'
type ActivityAgentOption = Omit<AgentSessionAgentStat, 'count'> & { count?: number }
const queryToolOf = (tool: ActivityState['tool']): QueryTool =>
  tool && Object.values(AGENT_RETRIEVAL_TOOL).includes(tool as AgentRetrievalTool)
    ? (tool as AgentRetrievalTool)
    : 'all'

export const ActivityFilters = ({
  state,
  agents,
  onAgent,
  onQuery,
  onTool,
}: {
  state: ActivityState
  agents: ActivityAgentOption[]
  onAgent: (agent: string | null) => void
  onQuery: (tool: AgentRetrievalTool | null, q: string | null) => void
  onTool: (tool: ActivityState['tool']) => void
}) => {
  const [tool, setTool] = useState<QueryTool>(queryToolOf(state.tool))
  const [query, setQuery] = useState(state.q ?? '')

  useEffect(() => {
    setTool(queryToolOf(state.tool))
    setQuery(state.q ?? '')
  }, [state.agent, state.group, state.q, state.show, state.tool])

  useEffect(() => {
    const next = query.trim()
    const nextTool = next && tool !== 'all' ? tool : null

    if (!next && state.tool && queryToolOf(state.tool) === 'all') {
      return undefined
    }

    if (next === (state.q ?? '') && nextTool === state.tool) {
      return undefined
    }
    const timeout = setTimeout(() => onQuery(nextTool, next || null), QUERY_FILTER_DEBOUNCE_MS)
    return () => clearTimeout(timeout)
  }, [onQuery, query, state.q, state.tool, tool])

  const clearQuery = () => {
    setTool('all')
    setQuery('')
    onQuery(null, null)
  }

  return (
    <AsideSections testId="activity-filters">
      <AsideSection heading="Tool" testId="activity-tool-filter">
        <Select
          aria-label="Agent tool"
          value={state.tool ?? undefined}
          placeholder="All tools"
          clearLabel="All tools"
          onClear={() => onTool(null)}
          onChange={onTool}
          options={ACTIVITY_TOOL_NAMES.map((value) => ({
            value,
            label: value.replaceAll('_', ' '),
          }))}
        />
      </AsideSection>
      <AsideSection
        heading="Retrieval query"
        testId="activity-query-filter"
        action={
          <button
            type="button"
            className="gf-section-reset"
            onClick={clearQuery}
            disabled={!state.q && !query}
            title="Clear query filter"
            aria-label="Clear query filter"
          >
            <IconX size={13} />
          </button>
        }
      >
        <Segmented<QueryTool>
          block
          value={tool}
          onChange={setTool}
          ariaLabel="Retrieval tool"
          options={[
            { value: 'all', label: 'All' },
            { value: AGENT_RETRIEVAL_TOOL.search, label: 'Search' },
            { value: AGENT_RETRIEVAL_TOOL.recall, label: 'Recall' },
            { value: AGENT_RETRIEVAL_TOOL.getNote, label: 'Open' },
          ]}
        />
        <SearchField
          value={query}
          onChange={setQuery}
          onClear={clearQuery}
          placeholder="Contains text"
          inputProps={{ 'aria-label': 'Retrieval query', 'data-testid': 'activity-query' }}
        />
      </AsideSection>

      {agents.length > 0 && (
        <AsideSection
          heading="Agent"
          testId="activity-agent-filter"
          action={
            <button
              type="button"
              className="gf-section-reset"
              onClick={() => onAgent(null)}
              disabled={!state.agent}
              title="Clear agent filter"
              aria-label="Clear agent filter"
            >
              <IconX size={13} />
            </button>
          }
        >
          <div data-testid="activity-agent-list">
            <FolderTree
              nodes={agents.map((item) => ({
                name: item.agent,
                path: item.agent,
                count: item.count ?? 0,
                showCount: item.count != null,
                children: [],
              }))}
              expanded={NO_EXPANDED_AGENTS}
              onToggleExpand={() => {}}
              isSelected={(agent) => state.agent === agent}
              onToggle={(agent) => onAgent(state.agent === agent ? null : agent)}
              swatch={false}
            />
          </div>
        </AsideSection>
      )}
    </AsideSections>
  )
}

export const ActivityDiagnostics = ({
  aggregates,
  loading,
  failed,
  state,
  onSelect,
  onRetry,
  onProblem,
}: {
  aggregates: AgentSessionEventAggregates | null
  loading: boolean
  failed: boolean
  state: ActivityState
  onSelect: (stat: AgentAuditQueryStat) => void
  onRetry: () => void
  onProblem: (tool: ToolName) => void
}) => {
  if (loading && !aggregates) {
    return <PanelsSkeleton />
  }

  if (failed && !aggregates) {
    return (
      <div className={styles.diagnosticsError} data-testid="activity-diagnostics-error">
        <Notice variant="error">Couldn’t load retrieval diagnostics.</Notice>
        <Button variant="ghost" onClick={onRetry}>
          Retry
        </Button>
      </div>
    )
  }

  const retrieval = aggregates?.retrieval
  const blindSpots = (retrieval?.misses ?? []).filter((item) => item.misses >= RECURRING_MISS_MIN)
  const frequent = retrieval?.top ?? []
  const recurringProblems = aggregates?.recurringProblems ?? []
  const active = (stat: AgentAuditQueryStat) => state.tool === stat.tool && state.q === stat.query

  return (
    <AsideSections testId="activity-diagnostics">
      <AsideSection
        heading="Recurring problems"
        hint="Repeated invalid argument shapes from Compact trace."
      >
        {recurringProblems.length > 0 ? (
          <ul className={styles.statList} data-testid="activity-recurring-problems">
            {recurringProblems.map((problem) => {
              const tool = ACTIVITY_TOOL_NAMES.includes(problem.tool as ToolName)
                ? (problem.tool as ToolName)
                : null
              return (
                <li key={problem.fingerprint}>
                  <button
                    type="button"
                    className={styles.problemRow}
                    disabled={!tool}
                    onClick={() => tool && onProblem(tool)}
                  >
                    <span>{problem.tool.replaceAll('_', ' ')}</span>
                    <span>{problem.count} repeats</span>
                  </button>
                </li>
              )
            })}
          </ul>
        ) : (
          <p className={styles.diagnosticsEmpty}>No recurring invalid calls.</p>
        )}
      </AsideSection>
      <AsideSection heading="Blind spots" hint="Queries that repeatedly returned no results.">
        {blindSpots.length > 0 ? (
          <ul className={styles.statList} data-testid="activity-blind-spots">
            {blindSpots.map((stat) => (
              <QueryStatRow
                key={`${stat.tool}-${stat.query}`}
                stat={stat}
                warn
                active={active(stat)}
                onSelect={onSelect}
              />
            ))}
          </ul>
        ) : (
          <p className={styles.diagnosticsEmpty}>No recurring empty queries.</p>
        )}
      </AsideSection>

      <AsideSection heading="Frequent" hint="Most-used retrieval queries across all activity.">
        {frequent.length > 0 ? (
          <ul className={styles.statList} data-testid="activity-frequent-queries">
            {frequent.map((stat) => (
              <QueryStatRow
                key={`${stat.tool}-${stat.query}`}
                stat={stat}
                active={active(stat)}
                onSelect={onSelect}
              />
            ))}
          </ul>
        ) : (
          <p className={styles.diagnosticsEmpty}>No retrieval queries yet.</p>
        )}
      </AsideSection>
    </AsideSections>
  )
}
