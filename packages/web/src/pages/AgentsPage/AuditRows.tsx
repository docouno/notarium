import type { ReactNode } from 'react'
import { Link } from 'react-router'
import type {
  AgentAuditQueryStat,
  AgentRetrievalEvent,
  AgentRetrievalTool,
} from '@notarium/contract'
import { AGENT_RETRIEVAL_TOOL, NOTE_CLASS } from '@notarium/contract/enums'
import { Chip } from '../../core/Chips'
import { DisclosureCard } from '../../core/DisclosureCard'
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
import { noteRouteForClass } from '../../libs/routing/routePaths'
import styles from './AuditPage.module.scss'

export const TOOL_META: Record<AgentRetrievalTool, { label: string; icon: ReactNode }> = {
  search: { label: 'Search', icon: <IconSearch size={13} /> },
  recall: { label: 'Recall', icon: <IconBotMessage size={13} /> },
  get_note: { label: 'Open', icon: <IconEye size={13} /> },
}

export const ToolBadge = ({ tool }: { tool: AgentRetrievalTool }) => {
  const meta = TOOL_META[tool]
  return (
    <span className={styles.toolBadge} data-tool={tool}>
      {meta.icon}
      {meta.label}
    </span>
  )
}

/** One aggregated query line — query + how often it ran. The blind-spots variant shows the
 *  recurring empty count in amber (a hint), the frequent variant a neutral run count. */
export const QueryStatRow = ({ stat, warn }: { stat: AgentAuditQueryStat; warn?: boolean }) => (
  <li className={styles.statRow}>
    <ToolBadge tool={stat.tool} />
    <span className={styles.statQuery} title={stat.query}>
      {stat.query}
    </span>
    <span className={cx(styles.statCount, warn && styles.statCountWarn)}>
      {warn ? `${stat.misses}× empty` : `${stat.count}×`}
    </span>
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
          <li key={`${h.noteId}-${i}`} className={styles.hit}>
            <span className={styles.hitIcon} aria-hidden>
              {h.class === NOTE_CLASS.agentMemory ? (
                <IconBotMessage size={13} />
              ) : (
                <IconScrollText size={13} />
              )}
            </span>
            {href ? (
              <Link to={href} className={styles.hitTitle} title={label}>
                {label}
              </Link>
            ) : (
              <span className={styles.hitTitle} title={label}>
                {label}
              </span>
            )}
            {typeof h.score === 'number' && (
              <span className={styles.hitScore}>{h.score.toFixed(3)}</span>
            )}
          </li>
        )
      })}
    </ul>
  )
}

export const AuditRow = ({ event }: { event: AgentRetrievalEvent }) => {
  const empty = event.tool !== AGENT_RETRIEVAL_TOOL.getNote && event.resultCount === 0
  // get_note's "query" is a raw note ref (an id) — show the opened note's title instead
  // when we captured it, so the row reads "Open <title>" not "Open <id>".
  const label =
    event.tool === AGENT_RETRIEVAL_TOOL.getNote
      ? (event.hits[0]?.title ?? event.query)
      : event.query
  // The card chrome + disclosure toggle come from the shared DisclosureCard (#243, same
  // primitive the context constructor uses) — the caret sits at the row START, ahead of
  // the tool badge; the reveal (the hit list) is the card body.
  return (
    <li>
      <DisclosureCard
        caret="start"
        headerClassName={styles.rowHead}
        testId="audit-row"
        header={
          <>
            <ToolBadge tool={event.tool} />
            <span className={styles.query} title={label}>
              {label}
            </span>
            <span className={styles.rowMeta}>
              {event.agent && (
                <span className={styles.agent} title={`Run by ${event.agent}`}>
                  <IconBot size={12} />
                  {event.agent}
                </span>
              )}
              {event.classFilter && (
                <Chip>{event.classFilter === NOTE_CLASS.agentMemory ? 'memory' : 'docs'}</Chip>
              )}
              {/* Scope only shows when the call NARROWED to a project — the common whole-reach
                  fan-out is the default and would just be noise on every row. */}
              {event.project && (
                <span className={styles.scope} title={event.project}>
                  {event.project}
                </span>
              )}
              <span
                className={cx(styles.result, empty && styles.resultEmpty)}
                title={
                  typeof event.topScore === 'number'
                    ? `top score ${event.topScore.toFixed(3)}`
                    : undefined
                }
              >
                {event.tool === AGENT_RETRIEVAL_TOOL.getNote
                  ? 'opened'
                  : event.resultCount === 0
                    ? 'no results'
                    : `${event.resultCount} result${event.resultCount === 1 ? '' : 's'}`}
              </span>
              <span className={styles.time} title={exactDateTime(event.at)}>
                {timeAgo(event.at)}
              </span>
            </span>
          </>
        }
      >
        <HitList event={event} />
      </DisclosureCard>
    </li>
  )
}
