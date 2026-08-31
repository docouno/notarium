import { useMemo, useRef, useState } from 'react'
import { Link } from 'react-router'
import type {
  AgentCallDetail,
  AgentCallEvent,
  AgentSessionEvent,
  AgentSessionWriteEvent,
} from '@notarium/contract'
import { NOTE_CLASS, REVISION_KIND } from '@notarium/contract/enums'
import { ActivityTimelineRow } from '../../core/ActivityTimeline'
import { IconArchive, IconBot, IconClock, IconCode, IconEdit } from '../../core/Icons'
import type { NoticeVariant } from '../../core/Notice'
import { exactDateTime, timeAgo } from '../../libs/datetime'
import { highlightCode } from '../../libs/markdown/markdown/highlight'
import { useMarkdownEnhance } from '../../libs/markdown/useMarkdownEnhance'
import { agentActivityRoute, noteRouteForClass } from '../../libs/routing/routePaths'
import { api } from '../../services/api'
import { AuditRow } from './AuditRows'
import styles from './ActivityRows.module.scss'

const writeLabel: Record<AgentSessionWriteEvent['revisionKind'], string> = {
  write: 'Wrote',
  delete: 'Deleted',
  restore: 'Restored',
  external: 'Changed',
  merge: 'Merged',
}

const writeVariant: Record<AgentSessionWriteEvent['revisionKind'], NoticeVariant> = {
  write: 'info',
  delete: 'error',
  restore: 'info',
  external: 'warning',
  merge: 'info',
}

const callVariant: Record<AgentCallEvent['outcome'], NoticeVariant | undefined> = {
  success: 'info',
  invalid_arguments: 'warning',
  denied: 'warning',
  tool_error: 'error',
  internal_error: 'error',
}

const callTarget = (event: AgentCallEvent): string => {
  if (!event.target || typeof event.target !== 'object' || Array.isArray(event.target)) {
    return event.tool
  }
  const target = event.target as Record<string, unknown>

  for (const key of ['query', 'ref', 'title', 'path', 'project', 'role', 'name']) {
    if (typeof target[key] === 'string') {
      return `${event.tool} · ${target[key]}`
    }
  }

  return event.tool
}

const JsonDetailBlock = ({ value }: { value: string }) => {
  const html = useMemo(
    () => `<pre><code class="hljs language-json">${highlightCode(value, 'json')}</code></pre>`,
    [value],
  )
  const ref = useRef<HTMLDivElement>(null)

  // Reuse the reader's highlighted code-block skin and copy affordance. The
  // highlighter escapes source bytes before emitting class-only token spans.
  useMarkdownEnhance(ref, html)

  return (
    <div
      ref={ref}
      className={`markdown ${styles.callDetail}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

export const ActivityCallRow = ({
  event,
  showSession = false,
  routeState,
}: {
  event: AgentCallEvent
  showSession?: boolean
  routeState?: URLSearchParams | string
}) => {
  const [expanded, setExpanded] = useState(false)
  const [detail, setDetail] = useState<AgentCallDetail | null>(null)
  const [failed, setFailed] = useState(false)
  const context = showSession ? (
    <Link
      to={agentActivityRoute(event.sessionId ?? 'outside', routeState)}
      className={styles.sessionMetaLink}
    >
      {event.sessionId ? (event.sessionName ?? 'Session') : 'Outside session'}
    </Link>
  ) : null
  const detailView = (
    <JsonDetailBlock
      value={JSON.stringify(
        failed
          ? { status: 'error', message: 'Detailed trace could not be loaded.' }
          : (detail ?? { target: event.target, result: event.result, status: 'Loading…' }),
        null,
        2,
      )}
    />
  )

  return (
    <ActivityTimelineRow
      as="li"
      icon={<IconCode size={14} />}
      variant={callVariant[event.outcome]}
      primary={<span className={styles.query}>{callTarget(event)}</span>}
      time={<time title={exactDateTime(event.at)}>{timeAgo(event.at)}</time>}
      action={
        event.effect === 'mutation' ? 'Mutation' : event.effect === 'read' ? 'Read' : 'Control'
      }
      actor={
        event.agent ? (
          <>
            <IconBot size={12} />
            {event.agent}
          </>
        ) : undefined
      }
      context={context}
      attributes={`${event.durationMs} ms · ${event.transport}`}
      outcome={event.outcome.replaceAll('_', ' ')}
      detail={detailView}
      expanded={expanded}
      onExpandedChange={(next) => {
        setExpanded(next)
        if (next && !detail && !failed) {
          void api
            .agentCallDetailGet(event.id)
            .then(setDetail)
            .catch(() => setFailed(true))
        }
      }}
      disclosureLabel={`Toggle call details for ${event.tool}`}
      reserveDisclosure
      testId="agent-call-row"
    />
  )
}

export const ActivityWriteRow = ({
  event,
  showSession = false,
  routeState,
}: {
  event: AgentSessionWriteEvent
  showSession?: boolean
  routeState?: URLSearchParams | string
}) => {
  const unavailable = event.unavailableReason != null
  const href =
    unavailable || event.revisionKind === REVISION_KIND.delete
      ? null
      : noteRouteForClass(event.noteId, event.class ?? undefined)
  const icon = unavailable ? (
    <IconClock size={14} />
  ) : event.revisionKind === REVISION_KIND.delete ? (
    <IconArchive size={14} />
  ) : (
    <IconEdit size={14} />
  )
  const context = showSession ? (
    <Link
      to={agentActivityRoute(event.sessionId ?? 'outside', routeState)}
      className={styles.sessionMetaLink}
    >
      {event.sessionId ? (event.sessionName ?? 'Session') : 'Outside session'}
    </Link>
  ) : null
  const attributes = [
    event.class === NOTE_CLASS.agentMemory ? 'agent memory' : event.class ? 'user docs' : null,
    event.sessionAttach ? `${event.sessionAttach} session` : null,
    event.space,
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <ActivityTimelineRow
      as="li"
      icon={icon}
      variant={unavailable ? undefined : writeVariant[event.revisionKind]}
      primary={
        href ? (
          <Link to={href} className={styles.writeTitle}>
            {event.title || event.noteId}
          </Link>
        ) : (
          <span className={styles.writeTitle}>{event.title || event.noteId}</span>
        )
      }
      time={<time title={exactDateTime(event.at)}>{timeAgo(event.at)}</time>}
      action={unavailable ? 'Unavailable' : writeLabel[event.revisionKind]}
      actor={
        event.agent ? (
          <>
            <IconBot size={12} />
            {event.agent}
          </>
        ) : undefined
      }
      context={context}
      attributes={attributes}
      reserveDisclosure
      testId="session-write-row"
    />
  )
}

export const ActivityEventRow = ({
  event,
  showSession = false,
  routeState,
}: {
  event: AgentSessionEvent
  showSession?: boolean
  routeState?: URLSearchParams | string
}) =>
  event.type === 'call' ? (
    <ActivityCallRow event={event} showSession={showSession} routeState={routeState} />
  ) : event.type === 'retrieval' ? (
    <AuditRow event={event} showSession={showSession} routeState={routeState} />
  ) : (
    <ActivityWriteRow event={event} showSession={showSession} routeState={routeState} />
  )
