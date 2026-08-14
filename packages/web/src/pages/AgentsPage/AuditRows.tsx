import type { ReactNode } from 'react'
import { Link } from 'react-router'
import type {
  AgentAuditQueryStat,
  AgentRetrievalEvent,
  AgentRetrievalTool,
  AgentSessionRetrievalEvent,
} from '@notarium/contract'
import { AGENT_RETRIEVAL_TOOL, NOTE_CLASS } from '@notarium/contract/enums'
import { ActivityTimelineRow } from '../../core/ActivityTimeline'
import {
  IconBot,
  IconBotMessage,
  IconCrosshair,
  IconEye,
  IconScrollText,
  IconSearch,
} from '../../core/Icons'
import { cx } from '../../libs/cx/cx'
import { exactDateTime, timeAgo } from '../../libs/datetime'
import { agentActivityRoute, noteRouteForClass } from '../../libs/routing/routePaths'
import asideStyles from './ActivityAside.module.scss'
import styles from './ActivityRows.module.scss'

export const TOOL_META: Record<AgentRetrievalTool, { label: string; icon: ReactNode }> = {
  search: { label: 'Search', icon: <IconSearch size={13} /> },
  recall: { label: 'Recall', icon: <IconBotMessage size={13} /> },
  get_note: { label: 'Open', icon: <IconEye size={13} /> },
}

export const ToolLabel = ({
  tool,
  showIcon = true,
}: {
  tool: AgentRetrievalTool
  showIcon?: boolean
}) => {
  const meta = TOOL_META[tool]
  return (
    <span className={styles.toolLabel} data-tool={tool}>
      {showIcon && meta.icon}
      {meta.label}
    </span>
  )
}

/** One aggregated query line — query + how often it ran. The blind-spots variant shows the
 *  recurring empty count in amber (a hint), the frequent variant a neutral run count. */
export const QueryStatRow = ({
  stat,
  warn,
  active,
  onSelect,
}: {
  stat: AgentAuditQueryStat
  warn?: boolean
  active?: boolean
  onSelect: (stat: AgentAuditQueryStat) => void
}) => (
  <li className={cx(asideStyles.statItem, active && asideStyles.statItemActive)}>
    <button
      type="button"
      className={asideStyles.statRow}
      aria-pressed={active}
      onClick={() => onSelect(stat)}
    >
      <ToolLabel tool={stat.tool} />
      <span className={asideStyles.statQuery} title={stat.query}>
        {stat.query}
      </span>
      <span className={cx(asideStyles.statCount, warn && asideStyles.statCountWarn)}>
        {warn
          ? `${stat.misses} empty ${stat.misses === 1 ? 'run' : 'runs'}`
          : `${stat.count} ${stat.count === 1 ? 'run' : 'runs'}`}
      </span>
    </button>
  </li>
)

export const HitList = ({ event }: { event: AgentRetrievalEvent }) => {
  if (event.hits.length === 0) {
    return (
      <div className={styles.hitsEmpty}>
        <IconCrosshair size={13} />
        <span>Nothing came back for this query.</span>
      </div>
    )
  }

  return (
    <ul className={styles.hits}>
      {event.hits.map((h, i) => {
        const href = noteRouteForClass(h.noteId, h.class)
        const label = h.title || h.noteId
        return (
          <li key={`${h.noteId}-${i}`}>
            {href ? (
              <Link to={href} className={styles.hit} data-testid="activity-hit-link">
                <span className={styles.hitIcon} aria-hidden>
                  {h.class === NOTE_CLASS.agentMemory ? (
                    <IconBotMessage size={13} />
                  ) : (
                    <IconScrollText size={13} />
                  )}
                </span>
                <span className={styles.hitTitle} title={label}>
                  {label}
                </span>
                {typeof h.score === 'number' && (
                  <span
                    className={styles.hitScore}
                    title="Retrieval relevance score. Higher scores rank first."
                  >
                    relevance {h.score.toFixed(2)}
                  </span>
                )}
              </Link>
            ) : (
              <div className={styles.hit}>
                <span className={styles.hitIcon} aria-hidden>
                  {h.class === NOTE_CLASS.agentMemory ? (
                    <IconBotMessage size={13} />
                  ) : (
                    <IconScrollText size={13} />
                  )}
                </span>
                <span className={styles.hitTitle} title={label}>
                  {label}
                </span>
              </div>
            )}
          </li>
        )
      })}
    </ul>
  )
}

export const AuditRow = ({
  event,
  showSession = false,
  routeState,
}: {
  event: AgentRetrievalEvent | AgentSessionRetrievalEvent
  showSession?: boolean
  routeState?: URLSearchParams | string
}) => {
  const empty = event.tool !== AGENT_RETRIEVAL_TOOL.getNote && event.resultCount === 0
  // get_note's "query" is a raw note ref (an id) — show the opened note's title instead
  // when we captured it, so the row reads "Open <title>" not "Open <id>".
  const label =
    event.tool === AGENT_RETRIEVAL_TOOL.getNote
      ? (event.hits[0]?.title ?? event.query)
      : event.query
  const tool = TOOL_META[event.tool]
  const context =
    showSession && 'sessionId' in event ? (
      <Link
        to={agentActivityRoute(event.sessionId ?? 'outside', routeState)}
        className={styles.sessionMetaLink}
      >
        {event.sessionId ? (event.sessionName ?? 'Session') : 'Outside session'}
      </Link>
    ) : null
  const attributes = [
    event.classFilter === NOTE_CLASS.agentMemory
      ? 'agent memory'
      : event.classFilter
        ? 'user docs'
        : null,
    'sessionAttach' in event && event.sessionAttach ? `${event.sessionAttach} session` : null,
    event.project,
  ]
    .filter(Boolean)
    .join(' · ')
  const outcome =
    event.tool === AGENT_RETRIEVAL_TOOL.getNote
      ? null
      : event.resultCount === 0
        ? 'no results'
        : `${event.resultCount} result${event.resultCount === 1 ? '' : 's'}`
  return (
    <ActivityTimelineRow
      as="li"
      icon={tool.icon}
      primary={
        <span className={styles.query} title={label}>
          {label}
        </span>
      }
      time={<time title={exactDateTime(event.at)}>{timeAgo(event.at)}</time>}
      action={tool.label}
      actor={
        event.agent ? (
          <>
            <IconBot size={12} />
            {event.agent}
          </>
        ) : undefined
      }
      context={context}
      attributes={attributes || undefined}
      outcome={
        outcome ? (
          <span
            className={cx(empty && styles.resultEmpty)}
            title={
              typeof event.topScore === 'number'
                ? `Top relevance score ${event.topScore.toFixed(2)}. Higher scores rank first.`
                : undefined
            }
          >
            {outcome}
          </span>
        ) : undefined
      }
      detail={<HitList event={event} />}
      disclosureLabel={`Toggle ${tool.label.toLowerCase()} results for ${label}`}
      reserveDisclosure
      testId="audit-row"
    />
  )
}
