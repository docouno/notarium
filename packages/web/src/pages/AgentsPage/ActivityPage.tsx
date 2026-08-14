import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import type {
  AgentSessionEvents,
  AgentSessionOutside,
  AgentSessions,
  AgentSessionSummary,
} from '@notarium/contract'
import { ActivityTimeline, ActivityTimelineRow } from '../../core/ActivityTimeline'
import { Button } from '../../core/Button'
import { ContextMenu } from '../../core/ContextMenu'
import { EmptyState } from '../../core/EmptyState'
import {
  IconArchive,
  IconClock,
  IconCrosshair,
  IconExternal,
  IconHistory,
  IconMore,
} from '../../core/Icons'
import { Notice } from '../../core/Notice'
import { Segmented } from '../../core/Segmented'
import { exactDateTime, timeAgo } from '../../libs/datetime'
import { agentActivityRoute } from '../../libs/routing/routePaths'
import { api } from '../../services/api'
import { ActivityEventRow } from './ActivityEventRows'
import { useActivityFrame } from './ActivityFrame'
import { type ActivityGroup, type ActivityShow } from './activityState'
import { ActivityListSkeleton, SessionListSkeleton } from './AuditSkeletons'
import { countLabel } from './consts'
import styles from './ActivityPage.module.scss'

type EpisodeState = {
  data: AgentSessionEvents | null
  loading: boolean
  loadingMore: boolean
  failed: boolean
}

const sessionCounts = (session: AgentSessionSummary): string => {
  if (session.reads + session.writes === 0) {
    return session.calls == null
      ? 'Archived snapshot · no audited activity'
      : `${countLabel(session.calls, 'call')} · no audited activity`
  }
  const audited = `${countLabel(session.reads, 'read')} · ${countLabel(session.writes, 'write')}`
  return session.calls == null
    ? `${audited} · archived snapshot`
    : `${countLabel(session.calls, 'call')} · ${audited}`
}

const EpisodeActions = ({ to }: { to: string }) => {
  const navigate = useNavigate()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const closeMenu = () => setMenu(null)

  return (
    <>
      <Button
        ref={triggerRef}
        variant="ghost"
        icon
        active={menu != null}
        title="More actions"
        aria-label="More actions"
        aria-haspopup="menu"
        aria-expanded={menu != null}
        onClick={() => {
          if (menu) {
            setMenu(null)
            return
          }
          const rect = triggerRef.current?.getBoundingClientRect()

          if (rect) {
            setMenu({ x: rect.right, y: rect.bottom + 4 })
          }
        }}
      >
        <IconMore size={15} />
      </Button>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          ignoreRef={triggerRef}
          items={[
            {
              label: 'Open episode',
              icon: <IconExternal size={15} />,
              onClick: () => navigate(to),
            },
          ]}
          onClose={closeMenu}
        />
      )}
    </>
  )
}

const relevantCount = (
  item: AgentSessionSummary | AgentSessionOutside,
  show: ActivityShow,
): number =>
  show === 'reads' ? item.reads : show === 'writes' ? item.writes : item.reads + item.writes

export const ActivityPage = () => {
  const { searchParams, setState, state } = useActivityFrame()
  const [stream, setStream] = useState<AgentSessionEvents | null>(null)
  const [overview, setOverview] = useState<AgentSessions | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [failed, setFailed] = useState(false)
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set())
  const [episodes, setEpisodes] = useState<Record<string, EpisodeState>>({})
  const requestSeq = useRef(0)
  const episodeRequestSeq = useRef(0)
  const episodeRequests = useRef(new Map<string, number>())

  const clearEpisodes = useCallback(() => {
    episodeRequestSeq.current += 1
    episodeRequests.current.clear()
    setExpandedIds(new Set())
    setEpisodes({})
  }, [])

  const loadStream = useCallback(
    async (cursor?: string) => {
      const seq = ++requestSeq.current

      if (cursor) {
        setLoadingMore(true)
      } else {
        setLoading(true)
      }
      setFailed(false)
      try {
        const next = await api.agentSessionEventsGet('all', {
          limit: 50,
          cursor,
          filter: state.show === 'all' ? undefined : state.show,
          agent: state.agent ?? undefined,
          tool: state.tool ?? undefined,
          q: state.q ?? undefined,
        })

        if (seq !== requestSeq.current) {
          return
        }
        setStream((prev) =>
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
    [state.agent, state.q, state.show, state.tool],
  )

  const loadOverview = useCallback(
    async (cursor?: string) => {
      const seq = ++requestSeq.current

      if (cursor) {
        setLoadingMore(true)
      } else {
        setLoading(true)
      }
      setFailed(false)
      try {
        const next = await api.agentSessionsGet({
          limit: 30,
          cursor,
          filter: state.show === 'all' ? undefined : state.show,
          aggregates: '0',
        })

        if (seq !== requestSeq.current) {
          return
        }
        setOverview((prev) =>
          cursor && prev ? { ...next, sessions: [...prev.sessions, ...next.sessions] } : next,
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
    [state.show],
  )

  useEffect(() => {
    if (state.group !== 'none') {
      return undefined
    }
    requestSeq.current += 1
    setStream(null)
    setLoading(true)
    void loadStream()
    return () => {
      requestSeq.current += 1
    }
  }, [loadStream, state.group])

  useEffect(() => {
    if (state.group !== 'session') {
      return undefined
    }
    requestSeq.current += 1
    clearEpisodes()
    setOverview(null)
    setLoading(true)
    void loadOverview()
    return () => {
      requestSeq.current += 1
    }
  }, [clearEpisodes, loadOverview, state.group])

  const loadEpisode = useCallback(
    async (id: string, cursor?: string) => {
      const seq = ++episodeRequestSeq.current
      episodeRequests.current.set(id, seq)
      setEpisodes((previous) => ({
        ...previous,
        [id]: {
          data: cursor ? (previous[id]?.data ?? null) : null,
          loading: !cursor,
          loadingMore: !!cursor,
          failed: false,
        },
      }))
      try {
        const next = await api.agentSessionEventsGet(id, {
          limit: 50,
          cursor,
          filter: state.show === 'all' ? undefined : state.show,
        })

        if (episodeRequests.current.get(id) !== seq) {
          return
        }
        setEpisodes((previous) => {
          const current = previous[id]
          const data =
            cursor && current?.data
              ? { ...next, events: [...current.data.events, ...next.events] }
              : next

          return {
            ...previous,
            [id]: { data, loading: false, loadingMore: false, failed: false },
          }
        })
      } catch {
        if (episodeRequests.current.get(id) === seq) {
          setEpisodes((previous) => ({
            ...previous,
            [id]: {
              data: previous[id]?.data ?? null,
              loading: false,
              loadingMore: false,
              failed: true,
            },
          }))
        }
      }
    },
    [state.show],
  )

  const toggleEpisode = (id: string, open: boolean) => {
    if (!open) {
      episodeRequests.current.delete(id)
      setExpandedIds((previous) => {
        const next = new Set(previous)
        next.delete(id)
        return next
      })
      setEpisodes((previous) => {
        const next = { ...previous }
        delete next[id]
        return next
      })
      return
    }
    setExpandedIds((previous) => new Set(previous).add(id))
    void loadEpisode(id)
  }

  const changeGroup = (group: ActivityGroup) => {
    clearEpisodes()
    setState({ group })
  }

  const changeShow = (show: ActivityShow) => {
    clearEpisodes()
    setState(show === 'writes' ? { show, tool: null, q: null } : { show })
  }

  const resetFilters = () => {
    clearEpisodes()
    setState({ agent: null, tool: null, q: null, show: 'all' })
  }

  const streamEmpty = !loading && !failed && stream?.events.length === 0
  const overviewEmpty =
    !loading && !failed && overview?.sessions.length === 0 && overview.outside == null
  const filtered = state.show !== 'all' || !!state.agent || !!state.q

  const episodeBody = (id: string) => {
    const episodeState = episodes[id]
    const episode = episodeState?.data ?? null
    const matchingEpisode =
      episode?.target.kind === 'outside'
        ? id === 'outside'
          ? episode
          : null
        : episode?.target.kind === 'session' && episode.target.id === id
          ? episode
          : null
    const retryEpisode = () => void loadEpisode(id, matchingEpisode?.nextCursor ?? undefined)

    return (
      <div className={styles.sessionCardBody} data-testid="activity-session-events">
        {!episodeState || episodeState.loading ? (
          <ActivityListSkeleton rows={4} />
        ) : matchingEpisode ? (
          <>
            {episodeState.failed && (
              <Notice variant="error" className={styles.loadError}>
                <span>Couldn’t load older episode activity.</span>
                <Button variant="ghost" onClick={retryEpisode}>
                  Retry
                </Button>
              </Notice>
            )}
            {matchingEpisode.events.length > 0 ? (
              <ActivityTimeline as="ul" testId="activity-session-event-timeline">
                {matchingEpisode.events.map((event) => (
                  <ActivityEventRow key={`${event.type}-${event.id}`} event={event} />
                ))}
              </ActivityTimeline>
            ) : (
              <EmptyState
                variant="bare"
                icon={<IconHistory size={18} />}
                title={`No ${state.show === 'all' ? 'audited activity' : state.show}`}
              />
            )}
            {matchingEpisode.hasMore && matchingEpisode.nextCursor && (
              <div className={styles.loadMore}>
                <Button
                  variant="ghost"
                  disabled={episodeState.loadingMore}
                  onClick={() => void loadEpisode(id, matchingEpisode.nextCursor as string)}
                >
                  {episodeState.loadingMore ? 'Loading…' : 'Load older episode activity'}
                </Button>
              </div>
            )}
          </>
        ) : episodeState.failed ? (
          <Notice variant="error" className={styles.loadError}>
            <span>Couldn’t load this episode.</span>
            <Button variant="ghost" onClick={retryEpisode}>
              Retry
            </Button>
          </Notice>
        ) : (
          <EmptyState
            variant="bare"
            icon={<IconHistory size={18} />}
            title={`No ${state.show === 'all' ? 'audited activity' : state.show}`}
          />
        )}
      </div>
    )
  }

  return (
    <div className={styles.page} data-testid="agents-activity">
      <div className={styles.inner}>
        <header className={styles.head}>
          <h1 className={styles.title}>Activity</h1>
          <p className={styles.sub}>
            What your agents retrieved and changed, newest first. Group the stream to inspect
            complete work episodes.
          </p>
        </header>

        {failed && (
          <Notice variant="error" className={styles.loadError} data-testid="activity-error">
            <span>Couldn’t load agent activity.</span>
            <Button
              variant="ghost"
              onClick={() =>
                void (state.group === 'session'
                  ? loadOverview(overview?.nextCursor ?? undefined)
                  : loadStream(stream?.nextCursor ?? undefined))
              }
            >
              Retry
            </Button>
          </Notice>
        )}

        <div className={styles.activityControls}>
          <div className={styles.controlGroup}>
            <span>Group</span>
            <Segmented<ActivityGroup>
              value={state.group}
              onChange={changeGroup}
              ariaLabel="Group activity"
              options={[
                { value: 'none', label: 'None' },
                { value: 'session', label: 'Session' },
              ]}
            />
          </div>
          <div className={styles.controlGroup}>
            <span>Show</span>
            <Segmented<ActivityShow>
              value={state.show}
              onChange={changeShow}
              ariaLabel="Show activity"
              options={[
                { value: 'all', label: 'All' },
                { value: 'reads', label: 'Reads' },
                { value: 'writes', label: 'Writes' },
              ]}
            />
          </div>
        </div>

        {state.group === 'none' ? (
          <>
            <div className={styles.sessionListHead}>
              <span className={styles.sessionListTitle}>Recent activity</span>
            </div>
            {loading && !stream ? (
              <ActivityListSkeleton />
            ) : stream?.events.length ? (
              <>
                <ActivityTimeline as="ul" testId="activity-stream">
                  {stream.events.map((event) => (
                    <ActivityEventRow
                      key={`${event.type}-${event.id}`}
                      event={event}
                      showSession
                      routeState={searchParams}
                    />
                  ))}
                </ActivityTimeline>
                {stream.hasMore && stream.nextCursor && (
                  <div className={styles.loadMore}>
                    <Button
                      variant="ghost"
                      disabled={loadingMore}
                      onClick={() => void loadStream(stream.nextCursor ?? undefined)}
                    >
                      {loadingMore ? 'Loading…' : 'Load older activity'}
                    </Button>
                  </div>
                )}
              </>
            ) : streamEmpty ? (
              <EmptyState
                icon={<IconHistory size={22} />}
                title={filtered ? 'No activity matches these filters' : 'No agent activity yet'}
                hint={
                  filtered
                    ? 'Try a broader slice or reset the filters.'
                    : 'Reads and writes appear here as agents work with your notes.'
                }
                action={
                  filtered ? (
                    <Button variant="ghost" onClick={resetFilters}>
                      Reset filters
                    </Button>
                  ) : undefined
                }
                testId="activity-empty"
              />
            ) : null}
          </>
        ) : (
          <>
            <div className={styles.sessionListHead}>
              <span className={styles.sessionListTitle}>Recent episodes</span>
              {overview && (
                <span className={styles.sessionListMeta}>
                  {countLabel(overview.total, 'session')}
                </span>
              )}
            </div>
            {loading && !overview ? (
              <SessionListSkeleton />
            ) : overviewEmpty ? (
              <EmptyState
                icon={<IconHistory size={22} />}
                title={filtered ? 'No activity matches these filters' : 'No agent sessions yet'}
                hint={
                  filtered
                    ? 'Try a broader slice or reset the filters.'
                    : 'A session appears after an agent calls start_session. Unbound activity stays visible in its own group.'
                }
                action={
                  filtered ? (
                    <Button variant="ghost" onClick={resetFilters}>
                      Reset filters
                    </Button>
                  ) : undefined
                }
              />
            ) : overview ? (
              <>
                <div className={styles.sessionTimeline} data-testid="activity-session-list">
                  {overview.outside && (
                    <ActivityTimeline
                      as="ul"
                      className={styles.sessionTimelineSegment}
                      testId="activity-session-segment"
                      spine={false}
                    >
                      <ActivityTimelineRow
                        as="li"
                        icon={<IconCrosshair size={14} />}
                        variant="warning"
                        primary={<span className={styles.sessionTitle}>Outside sessions</span>}
                        time={
                          <span
                            title={
                              overview.outside.lastSeenAt
                                ? exactDateTime(overview.outside.lastSeenAt)
                                : undefined
                            }
                          >
                            {overview.outside.lastSeenAt
                              ? timeAgo(overview.outside.lastSeenAt)
                              : 'Never'}
                          </span>
                        }
                        outcome={`${countLabel(overview.outside.reads, 'read')} · ${countLabel(overview.outside.writes, 'write')} without a session`}
                        detail={episodeBody('outside')}
                        expanded={expandedIds.has('outside')}
                        onExpandedChange={(open) => toggleEpisode('outside', open)}
                        reserveDisclosure
                        disclosureLabel="Toggle activity for outside sessions"
                        detailClassName={styles.sessionDetail}
                        trailing={
                          <EpisodeActions to={agentActivityRoute('outside', searchParams)} />
                        }
                        testId="activity-session-outside"
                      />
                    </ActivityTimeline>
                  )}
                  {overview.sessions.map((session) => {
                    const expandable = relevantCount(session, state.show) > 0
                    return (
                      <ActivityTimeline
                        as="ul"
                        key={session.id}
                        className={styles.sessionTimelineSegment}
                        testId="activity-session-segment"
                        spine={false}
                      >
                        <ActivityTimelineRow
                          as="li"
                          icon={
                            session.retained ? <IconClock size={14} /> : <IconArchive size={14} />
                          }
                          variant={session.active ? 'success' : undefined}
                          primary={
                            <span className={styles.sessionTitleLine}>
                              <span className={styles.sessionTitle}>{session.name}</span>
                              {session.parentId && (
                                <span className={styles.sessionKindLabel}>Fork</span>
                              )}
                              {session.named === false && (
                                <span className={styles.sessionKindLabel}>Automatic</span>
                              )}
                              {session.active && <span className={styles.activeLabel}>Active</span>}
                            </span>
                          }
                          time={
                            <span title={exactDateTime(session.lastSeenAt)}>
                              {timeAgo(session.lastSeenAt)}
                            </span>
                          }
                          outcome={sessionCounts(session)}
                          detail={expandable ? episodeBody(session.id) : undefined}
                          expanded={expandedIds.has(session.id)}
                          onExpandedChange={(open) => toggleEpisode(session.id, open)}
                          reserveDisclosure
                          disclosureLabel={`Toggle activity for ${session.name}`}
                          detailClassName={styles.sessionDetail}
                          trailing={
                            <EpisodeActions to={agentActivityRoute(session.id, searchParams)} />
                          }
                          testId="activity-session-row"
                        />
                      </ActivityTimeline>
                    )
                  })}
                </div>
                {overview.hasMore && overview.nextCursor && (
                  <div className={styles.loadMore}>
                    <Button
                      variant="ghost"
                      disabled={loadingMore}
                      onClick={() => void loadOverview(overview.nextCursor ?? undefined)}
                    >
                      {loadingMore ? 'Loading…' : 'Load older sessions'}
                    </Button>
                  </div>
                )}
              </>
            ) : null}
          </>
        )}
      </div>
    </div>
  )
}
