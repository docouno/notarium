import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router'
import type { AgentSessionEvents, AgentSessionTarget } from '@notarium/contract'
import { ActivityTimeline } from '../../core/ActivityTimeline'
import { Button } from '../../core/Button'
import { EmptyState } from '../../core/EmptyState'
import { IconHistory } from '../../core/Icons'
import { Notice } from '../../core/Notice'
import { Segmented } from '../../core/Segmented'
import { agentActivityRoute } from '../../libs/routing/routePaths'
import { api } from '../../services/api'
import { ActivityEventRow } from './ActivityEventRows'
import { useActivityFrame } from './ActivityFrame'
import { type ActivityShow } from './activityState'
import { ActivityListSkeleton } from './AuditSkeletons'
import { countLabel } from './consts'
import styles from './ActivityPage.module.scss'

const targetTitle = (target: AgentSessionTarget): string =>
  target.kind === 'all'
    ? 'All activity'
    : target.kind === 'outside'
      ? 'Outside sessions'
      : target.name

export const ActivityEpisodePage = () => {
  const { id = '' } = useParams<{ id: string }>()
  const { searchParams, setDetailTitle, setState, state } = useActivityFrame()
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
          filter: state.show === 'all' ? undefined : state.show,
          agent: state.agent ?? undefined,
          tool: state.tool ?? undefined,
          q: state.q ?? undefined,
          outcome: state.outcome === 'all' ? undefined : state.outcome,
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
    [id, state.agent, state.outcome, state.q, state.show, state.tool],
  )

  useEffect(() => {
    setData(null)
    void load()
    return () => {
      requestSeq.current += 1
    }
  }, [load])

  const target = data?.target
  const title = target ? targetTitle(target) : 'Activity'
  const counts =
    target?.kind === 'session'
      ? `${target.calls == null ? 'Archived' : countLabel(target.calls, 'call')} · ${countLabel(target.reads, 'read')} · ${countLabel(target.writes, 'mutation')}`
      : null
  const filtered =
    state.show !== 'all' || state.outcome !== 'all' || !!state.agent || !!state.tool || !!state.q

  useEffect(() => {
    setDetailTitle(title)
    return () => setDetailTitle(null)
  }, [setDetailTitle, title])

  const setShow = (show: ActivityShow) => {
    setState(show === 'writes' ? { show, q: null } : { show })
  }

  const resetFilters = () => {
    setState({ show: 'all', agent: null, tool: null, q: null, outcome: 'all' })
  }

  return (
    <div className={styles.page} data-testid="agent-activity-episode">
      <div className={styles.inner}>
        <header className={styles.detailHead}>
          <span className={styles.detailEyebrow}>
            {target?.kind === 'outside' ? 'Unattributed activity' : 'Session activity'}
          </span>
          <div className={styles.detailTitleLine}>
            <h1 className={styles.title}>{title}</h1>
            {target?.kind === 'session' && target.active && (
              <span className={styles.activeLabel}>Active</span>
            )}
          </div>
          {counts && <p className={styles.sub}>{counts} · newest first</p>}
          {target?.kind === 'session' && (target.parentId || target.named === false) && (
            <div className={styles.sessionProvenance}>
              {target.parentId && (
                <Link
                  to={agentActivityRoute(target.parentId, searchParams)}
                  className={styles.parentLink}
                >
                  Forked from parent session
                </Link>
              )}
              {target.named === false && <span className={styles.sessionKindLabel}>Automatic</span>}
            </div>
          )}
        </header>

        {failed && (
          <Notice variant="error" className={styles.loadError} data-testid="activity-episode-error">
            <span>Couldn’t load this activity episode.</span>
            <Button variant="ghost" onClick={() => void load(data?.nextCursor ?? undefined)}>
              Retry
            </Button>
          </Notice>
        )}

        <div className={styles.controls}>
          <Segmented<ActivityShow>
            value={state.show}
            onChange={setShow}
            ariaLabel="Show activity"
            options={[
              { value: 'all', label: 'All' },
              { value: 'reads', label: 'Reads' },
              { value: 'writes', label: 'Mutations' },
            ]}
          />
          {data?.total != null && data.total > 0 && (
            <span className={styles.total}>{countLabel(data.total, 'event')}</span>
          )}
        </div>

        {loading && !data ? (
          <ActivityListSkeleton />
        ) : data?.events.length ? (
          <>
            <ActivityTimeline as="ul" testId="activity-episode-events">
              {data.events.map((event) => (
                <ActivityEventRow key={`${event.type}-${event.id}`} event={event} />
              ))}
            </ActivityTimeline>
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
            title={filtered ? 'No activity matches these filters' : 'No audited activity'}
            hint={
              target?.kind === 'outside'
                ? 'Activity appears here when a call cannot be attributed to one active session.'
                : 'The session call count can include tools that do not read or revise notes.'
            }
            action={
              filtered ? (
                <Button variant="ghost" onClick={resetFilters}>
                  Reset filters
                </Button>
              ) : undefined
            }
          />
        )}
      </div>
    </div>
  )
}
