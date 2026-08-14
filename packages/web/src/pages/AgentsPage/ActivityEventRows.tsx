import { Link } from 'react-router'
import type { AgentSessionEvent, AgentSessionWriteEvent } from '@notarium/contract'
import { NOTE_CLASS, REVISION_KIND } from '@notarium/contract/enums'
import { ActivityTimelineRow } from '../../core/ActivityTimeline'
import { IconArchive, IconBot, IconClock, IconEdit } from '../../core/Icons'
import type { NoticeVariant } from '../../core/Notice'
import { exactDateTime, timeAgo } from '../../libs/datetime'
import { agentActivityRoute, noteRouteForClass } from '../../libs/routing/routePaths'
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
  event.type === 'retrieval' ? (
    <AuditRow event={event} showSession={showSession} routeState={routeState} />
  ) : (
    <ActivityWriteRow event={event} showSession={showSession} routeState={routeState} />
  )
