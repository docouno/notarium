import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router'
import type { AgentSessionEvents, AgentSessionTarget } from '@notarium/contract'
import { HTTP_STATUS } from '@notarium/contract/http'
import { ActivityTimeline } from '../../core/ActivityTimeline'
import { Button } from '../../core/Button'
import { EmptyState } from '../../core/EmptyState'
import { IconHistory } from '../../core/Icons'
import { Notice } from '../../core/Notice'
import { Segmented } from '../../core/Segmented'
import { agentActivityRoute } from '../../libs/routing/routePaths'
import { api, ApiError } from '../../services/api'
import { ActivityEventRow } from './ActivityEventRows'
import { useActivityFrame } from './ActivityFrame'
import { type ActivityShow } from './activityState'
import { ActivityListSkeleton } from './AuditSkeletons'
import { countLabel } from './consts'
import {
  collectActivityWindow,
  continueActivityWindow,
  flattenActivityWindow,
} from './helpers/activityWindow'
import styles from './ActivityPage.module.scss'

const targetTitle = (target: AgentSessionTarget): string =>
  target.kind === 'all'
    ? 'All activity'
    : target.kind === 'outside'
      ? 'Outside sessions'
      : target.name

export const ActivityEpisodePage = () => {
  const { id = '' } = useParams<{ id: string }>()
  const { searchParams, sessionsVersion, setDetailTitle, setState, state } = useActivityFrame()
  const [data, setData] = useState<AgentSessionEvents | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [failed, setFailed] = useState(false)
  const [notFound, setNotFound] = useState(false)
  const dataRef = useRef(data)
  dataRef.current = data
  const requestSeq = useRef(0)
  const requestAbort = useRef<AbortController | null>(null)
  const depth = useRef({ committed: 0, requested: 1 })
  const failedOperation = useRef<'refresh' | 'continuation'>('refresh')
  const terminalNotFound = useRef(false)
  const observedSessionsVersion = useRef(sessionsVersion)
  const latestSessionsVersion = useRef(sessionsVersion)
  latestSessionsVersion.current = sessionsVersion

  const refresh = useCallback(async () => {
    const seq = ++requestSeq.current
    requestAbort.current?.abort()
    const controller = new AbortController()
    requestAbort.current = controller
    const requestedDepth = depth.current.requested

    setLoading(true)
    setLoadingMore(requestedDepth > depth.current.committed)
    setFailed(false)
    failedOperation.current = 'refresh'
    try {
      const window = await collectActivityWindow(
        (cursor) =>
          api.agentSessionEventsGet(
            id,
            {
              limit: 50,
              cursor,
              filter: state.show === 'all' ? undefined : state.show,
              agent: state.agent ?? undefined,
              tool: state.tool ?? undefined,
              q: state.q ?? undefined,
              outcome: state.outcome === 'all' ? undefined : state.outcome,
            },
            controller.signal,
          ),
        {
          requestedDepth,
          cursorOf: (page) => page.nextCursor,
          current: () => seq === requestSeq.current && !controller.signal.aborted,
        },
      )

      if (!window) {
        return
      }
      depth.current = { committed: window.depth, requested: window.depth }
      const nextData = {
        ...window.first,
        events: flattenActivityWindow(
          window.pages,
          (page) => page.events,
          (event) => `${event.type}:${event.id}`,
        ),
        hasMore: window.last.hasMore && window.nextCursor != null,
        nextCursor: window.nextCursor,
      }
      dataRef.current = nextData
      setData(nextData)
    } catch (error) {
      if (seq === requestSeq.current && !controller.signal.aborted) {
        if (error instanceof ApiError && error.status === HTTP_STATUS.NOT_FOUND) {
          depth.current = { committed: 0, requested: 1 }
          terminalNotFound.current = true
          dataRef.current = null
          setData(null)
          setNotFound(true)
          return
        }
        setFailed(true)
      }
    } finally {
      if (seq === requestSeq.current) {
        setLoading(false)
        setLoadingMore(false)
      }
    }
  }, [id, state.agent, state.outcome, state.q, state.show, state.tool])

  const continueWindow = useCallback(async () => {
    const previous = dataRef.current
    const cursor = previous?.nextCursor

    if (!previous || !cursor) {
      return
    }
    const seq = ++requestSeq.current
    requestAbort.current?.abort()
    const controller = new AbortController()
    requestAbort.current = controller
    const committedDepth = depth.current.committed

    setLoading(true)
    setLoadingMore(true)
    setFailed(false)
    failedOperation.current = 'continuation'
    try {
      const continuation = await continueActivityWindow(
        (nextCursor) =>
          api.agentSessionEventsGet(
            id,
            {
              limit: 50,
              cursor: nextCursor,
              filter: state.show === 'all' ? undefined : state.show,
              agent: state.agent ?? undefined,
              tool: state.tool ?? undefined,
              q: state.q ?? undefined,
              outcome: state.outcome === 'all' ? undefined : state.outcome,
            },
            controller.signal,
          ),
        {
          cursor,
          cursorOf: (page) => page.nextCursor,
          current: () => seq === requestSeq.current && !controller.signal.aborted,
        },
      )

      if (!continuation) {
        return
      }
      const nextDepth = committedDepth + 1
      const nextData = {
        ...previous,
        events: flattenActivityWindow(
          [previous, continuation.page],
          (page) => page.events,
          (event) => `${event.type}:${event.id}`,
        ),
        hasMore: continuation.page.hasMore && continuation.nextCursor != null,
        nextCursor: continuation.nextCursor,
      }
      depth.current = { committed: nextDepth, requested: nextDepth }
      dataRef.current = nextData
      setData(nextData)
    } catch (error) {
      if (seq === requestSeq.current && !controller.signal.aborted) {
        if (error instanceof ApiError && error.status === HTTP_STATUS.NOT_FOUND) {
          depth.current = { committed: 0, requested: 1 }
          terminalNotFound.current = true
          dataRef.current = null
          setData(null)
          setNotFound(true)
          return
        }
        setFailed(true)
      }
    } finally {
      if (seq === requestSeq.current) {
        setLoading(false)
        setLoadingMore(false)
      }
    }
  }, [id, state.agent, state.outcome, state.q, state.show, state.tool])

  useEffect(() => {
    observedSessionsVersion.current = latestSessionsVersion.current
    depth.current = { committed: 0, requested: 1 }
    failedOperation.current = 'refresh'
    terminalNotFound.current = false
    dataRef.current = null
    setData(null)
    setNotFound(false)
    void refresh()
    return () => {
      requestSeq.current += 1
      requestAbort.current?.abort()
    }
  }, [refresh])

  useEffect(() => {
    if (observedSessionsVersion.current === sessionsVersion) {
      return
    }
    observedSessionsVersion.current = sessionsVersion
    if (!terminalNotFound.current) {
      void refresh()
    }
  }, [refresh, sessionsVersion])

  const loadOlder = () => {
    depth.current.requested = Math.max(depth.current.committed, depth.current.requested) + 1
    void continueWindow()
  }

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

        {notFound ? (
          <Notice
            variant="error"
            className={styles.loadError}
            data-testid="activity-episode-not-found"
          >
            This activity episode no longer exists.
          </Notice>
        ) : failed ? (
          <Notice variant="error" className={styles.loadError} data-testid="activity-episode-error">
            <span>Couldn’t load this activity episode.</span>
            <Button
              variant="ghost"
              onClick={() =>
                void (failedOperation.current === 'continuation' ? continueWindow() : refresh())
              }
            >
              Retry
            </Button>
          </Notice>
        ) : null}

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

        {loading && !data && !notFound ? (
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
                <Button variant="ghost" disabled={loadingMore} onClick={loadOlder}>
                  {loadingMore ? 'Loading…' : 'Load older activity'}
                </Button>
              </div>
            )}
          </>
        ) : failed || notFound ? null : (
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
