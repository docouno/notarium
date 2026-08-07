import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router'
import type {
  AgentSessionEvents,
  AgentSessionTarget,
  AgentSessionWriteEvent,
} from '@notarium/contract'
import { REVISION_KIND } from '@notarium/contract/enums'
import { Button } from '../../core/Button'
import { Chip } from '../../core/Chips'
import { EmptyState } from '../../core/EmptyState'
import { IconArchive, IconBot, IconEdit, IconHistory } from '../../core/Icons'
import { Notice } from '../../core/Notice'
import { Segmented } from '../../core/Segmented'
import { SettingsLayout } from '../../layouts/SettingsLayout'
import { exactDateTime, timeAgo } from '../../libs/datetime'
import { noteRouteForClass } from '../../libs/routing/routePaths'
import { agentSessionsRoute } from '../../libs/routing/routePaths'
import { api } from '../../services/api'
import { AgentsTabs } from './AgentsTabs'
import { AuditRow } from './AuditRows'
import { ListSkeleton } from './AuditSkeletons'
import { countLabel } from './consts'
import styles from './SessionsPage.module.scss'

type EventFilter = 'all' | 'reads' | 'writes'

const targetTitle = (target: AgentSessionTarget): string =>
  target.kind === 'outside' ? 'Outside sessions' : target.name

const writeLabel: Record<AgentSessionWriteEvent['revisionKind'], string> = {
  write: 'Wrote',
  delete: 'Deleted',
  restore: 'Restored',
  external: 'Changed',
  merge: 'Merged',
}

const WriteRow = ({ event }: { event: AgentSessionWriteEvent }) => {
  const href =
    event.revisionKind === REVISION_KIND.delete
      ? null
      : noteRouteForClass(event.noteId, event.class ?? undefined)
  return (
    <li className={styles.writeRow} data-testid="session-write-row">
      <span className={styles.writeIcon}>
        {event.revisionKind === REVISION_KIND.delete ? (
          <IconArchive size={14} />
        ) : (
          <IconEdit size={14} />
        )}
      </span>
      <span className={styles.writeMain}>
        <span className={styles.writeTitleLine}>
          <span className={styles.writeKind}>{writeLabel[event.revisionKind]}</span>
          {href ? (
            <Link to={href} className={styles.writeTitle}>
              {event.title || event.noteId}
            </Link>
          ) : (
            <span className={styles.writeTitle}>{event.title || event.noteId}</span>
          )}
        </span>
        <span className={styles.writeMeta}>
          {event.agent && (
            <span className={styles.agent}>
              <IconBot size={12} />
              {event.agent}
            </span>
          )}
          {event.class && <Chip>{event.class}</Chip>}
          {event.sessionAttach && <Chip>{event.sessionAttach}</Chip>}
          <span>{event.space}</span>
        </span>
      </span>
      <span className={styles.time} title={exactDateTime(event.at)}>
        {timeAgo(event.at)}
      </span>
    </li>
  )
}

export const SessionPage = () => {
  const { id = '' } = useParams<{ id: string }>()
  const [filter, setFilter] = useState<EventFilter>('all')
  const [data, setData] = useState<AgentSessionEvents | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [failed, setFailed] = useState(false)
  const requestSeq = useRef(0)

  const load = useCallback(
    async (cursor?: string) => {
      const seq = ++requestSeq.current

      if (cursor) {
        setLoadingMore(true)
      } else {
        setLoading(true)
      }
      setFailed(false)
      try {
        const next = await api.agentSessionEventsGet(id, {
          limit: 50,
          cursor,
          filter: filter === 'all' ? undefined : filter,
        })

        if (seq !== requestSeq.current) {
          return
        }
        setData((prev) =>
          cursor && prev ? { ...next, events: [...prev.events, ...next.events] } : next,
        )
      } catch {
        if (seq === requestSeq.current) {
          setFailed(true)
        }
      } finally {
        if (seq === requestSeq.current) {
          setLoading(false)
          setLoadingMore(false)
        }
      }
    },
    [filter, id],
  )

  useEffect(() => {
    setData(null)
    void load()
    return () => {
      requestSeq.current += 1
    }
  }, [load])

  const target = data?.target
  const title = target ? targetTitle(target) : 'Session'
  const counts = target
    ? target.kind === 'outside'
      ? `${countLabel(target.reads, 'read')} · ${countLabel(target.writes, 'write')}`
      : `${target.calls == null ? 'Archived' : countLabel(target.calls, 'call')} · ${countLabel(target.reads, 'read')} · ${countLabel(target.writes, 'write')}`
    : null

  return (
    <SettingsLayout
      trail={[{ label: 'Agents' }, { label: 'Sessions' }, { label: title }]}
      spaceLess
      sectionTabs={<AgentsTabs active="sessions" />}
      testIdPrefix="session"
    >
      <div className={styles.page} data-testid="agent-session">
        <div className={styles.inner}>
          <header className={styles.detailHead}>
            <Link to={agentSessionsRoute()} className={styles.backLink}>
              ← All sessions
            </Link>
            <div className={styles.detailTitleLine}>
              <h1 className={styles.title}>{title}</h1>
              {target?.kind === 'session' && target.active && (
                <span className={styles.activeLabel}>Active</span>
              )}
            </div>
            {target?.kind === 'session' && (target.parentId || target.named === false) && (
              <div className={styles.sessionProvenance}>
                {target.parentId && (
                  <Link to={agentSessionsRoute(target.parentId)} className={styles.parentLink}>
                    Parent session
                  </Link>
                )}
                {target.named === false && (
                  <span className={styles.sessionKindLabel}>Automatic</span>
                )}
              </div>
            )}
            {counts && <p className={styles.sub}>{counts} · newest first</p>}
          </header>

          {failed && (
            <Notice variant="error" data-testid="session-error">
              Couldn’t load this session.
            </Notice>
          )}

          <div className={styles.controls}>
            <Segmented<EventFilter>
              value={filter}
              onChange={setFilter}
              ariaLabel="Filter session activity"
              options={[
                { value: 'all', label: 'All' },
                { value: 'reads', label: 'Reads' },
                { value: 'writes', label: 'Writes' },
              ]}
            />
            {data && data.total > 0 && (
              <span className={styles.total}>{countLabel(data.total, 'event')}</span>
            )}
          </div>

          {loading && !data ? (
            <ListSkeleton />
          ) : data?.events.length ? (
            <>
              <ul className={styles.list} data-testid="session-events">
                {data.events.map((event) =>
                  event.type === 'retrieval' ? (
                    <AuditRow key={`r-${event.id}`} event={event} />
                  ) : (
                    <WriteRow key={`w-${event.id}`} event={event} />
                  ),
                )}
              </ul>
              {data.hasMore && data.nextCursor && (
                <div className={styles.loadMore}>
                  <Button
                    variant="ghost"
                    disabled={loadingMore}
                    onClick={() => void load(data.nextCursor ?? undefined)}
                  >
                    {loadingMore ? 'Loading…' : 'Load older activity'}
                  </Button>
                </div>
              )}
            </>
          ) : failed ? null : (
            <EmptyState
              variant="bare"
              icon={<IconHistory size={20} />}
              title={
                filter === 'all'
                  ? 'No audited activity'
                  : target?.kind === 'outside'
                    ? `No ${filter} outside sessions`
                    : `No ${filter} in this session`
              }
              hint={
                target?.kind === 'outside'
                  ? 'Activity appears here when a call cannot be attributed to one active session.'
                  : 'The session call count can include tools that do not read or revise notes.'
              }
            />
          )}
        </div>
      </div>
    </SettingsLayout>
  )
}
