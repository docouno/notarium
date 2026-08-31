import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import type {
  AgentSessionEvents,
  AgentSessionOutside,
  AgentSessions,
  AgentSessionSummary,
} from '@notarium/contract'
import { HTTP_STATUS } from '@notarium/contract/http'
import { ActivityTimeline, ActivityTimelineRow } from '../../core/ActivityTimeline'
import { Button } from '../../core/Button'
import { ContextMenu } from '../../core/ContextMenu'
import { useDialog } from '../../core/Dialog'
import { EmptyState } from '../../core/EmptyState'
import {
  IconArchive,
  IconClock,
  IconCopy,
  IconCrosshair,
  IconDownload,
  IconExternal,
  IconHistory,
  IconMore,
  IconTrash,
} from '../../core/Icons'
import { Notice } from '../../core/Notice'
import { Segmented } from '../../core/Segmented'
import { useCopy, useToast } from '../../core/Toast'
import { exactDateTime, timeAgo } from '../../libs/datetime'
import { agentActivityRoute } from '../../libs/routing/routePaths'
import { AGENT_TRACE_COPY_MAX_BYTES, api, ApiError } from '../../services/api'
import { ActivityEventRow } from './ActivityEventRows'
import { useActivityFrame } from './ActivityFrame'
import { type ActivityGroup, type ActivityOutcome, type ActivityShow } from './activityState'
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
  const audited = `${countLabel(session.reads, 'read')} · ${countLabel(session.writes, 'mutation')}`
  return session.calls == null
    ? `${audited} · archived snapshot`
    : `${countLabel(session.calls, 'call')} · ${audited}`
}

const EpisodeActions = ({
  to,
  id,
  name,
  onDeleted,
}: {
  to: string
  id?: string
  name?: string
  onDeleted?: () => void
}) => {
  const navigate = useNavigate()
  const { confirm } = useDialog()
  const copyText = useCopy()
  const toast = useToast()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const closeMenu = () => setMenu(null)

  const download = () => {
    if (!id) {
      return
    }
    const link = document.createElement('a')
    link.href = api.agentSessionExportUrl(id)
    link.download = ''
    link.click()
  }

  const copyTrace = async () => {
    if (!id) {
      return
    }
    try {
      const result = await api.agentSessionTraceCopy(id, AGENT_TRACE_COPY_MAX_BYTES)

      if (result.status === 'too-large') {
        toast.warning(
          `Trace is larger than ${Math.round(result.limitBytes / 1024)} KB and wasn’t copied.`,
          { action: { label: 'Download', onClick: download } },
        )
        return
      }
      copyText(result.text, { label: 'session trace', subject: name ?? id })
    } catch {
      toast.error('Couldn’t prepare the session trace for copying.')
    }
  }

  const remove = async () => {
    if (!id) {
      return
    }
    const accepted = await confirm({
      title: `Delete “${name ?? id}”?`,
      message:
        'This removes the session and its retained call and retrieval diagnostics. Notes and revision history remain.',
      confirmLabel: 'Delete',
      danger: true,
    })

    if (!accepted) {
      return
    }
    try {
      const result = await api.agentSessionDelete(id)

      if (result === 'deleting') {
        toast.info('Deletion is in progress. The session is already hidden and cannot be reused.')
      }
      onDeleted?.()
    } catch (error) {
      if (error instanceof ApiError && error.status === HTTP_STATUS.CONFLICT) {
        const confirmedActive = await confirm({
          title: 'Delete active session?',
          message:
            'Running agent work will not be cancelled. The session and its retained diagnostics will be removed, and later calls using this session id will fail.',
          confirmLabel: 'Delete anyway',
          danger: true,
        })

        if (confirmedActive) {
          const result = await api.agentSessionDelete(id, true)

          if (result === 'deleting') {
            toast.info(
              'Deletion is in progress. The session is already hidden and cannot be reused.',
            )
          }
          onDeleted?.()
        }

        return
      }
      throw error
    }
  }

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
            ...(id
              ? [
                  {
                    label: 'Copy trace',
                    icon: <IconCopy size={15} />,
                    onClick: () => void copyTrace(),
                  },
                  { label: 'Download trace', icon: <IconDownload size={15} />, onClick: download },
                  { divider: true },
                  {
                    label: 'Delete session',
                    icon: <IconTrash size={15} />,
                    danger: true,
                    onClick: () => void remove(),
                  },
                ]
              : []),
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
          outcome: state.outcome === 'all' ? undefined : state.outcome,
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
    [state.agent, state.outcome, state.q, state.show, state.tool],
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
          tool: state.tool ?? undefined,
          outcome: state.outcome === 'all' ? undefined : state.outcome,
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
    [state.outcome, state.show, state.tool],
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
    setState(show === 'writes' ? { show, q: null } : { show })
  }

  const resetFilters = () => {
    clearEpisodes()
    setState({ agent: null, tool: null, q: null, show: 'all', outcome: 'all' })
  }

  const streamEmpty = !loading && !failed && stream?.events.length === 0
  const overviewEmpty =
    !loading && !failed && overview?.sessions.length === 0 && overview.outside == null
  const filtered =
    state.show !== 'all' || state.outcome !== 'all' || !!state.agent || !!state.tool || !!state.q

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
            Every retained agent call and its terminal outcome, newest first. Group the stream to
            inspect work episodes.
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
            <span>Outcome</span>
            <Segmented<ActivityOutcome>
              value={state.outcome}
              onChange={(outcome) => {
                clearEpisodes()
                setState({ outcome })
              }}
              ariaLabel="Filter by call outcome"
              options={[
                { value: 'all', label: 'All' },
                { value: 'success', label: 'Success' },
                { value: 'errors', label: 'Errors' },
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
                { value: 'writes', label: 'Mutations' },
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
                        outcome={`${countLabel(overview.outside.reads, 'read')} · ${countLabel(overview.outside.writes, 'mutation')} without a session`}
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
                              {!session.complete && (
                                <span className={styles.sessionKindLabel}>Legacy / partial</span>
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
                            <EpisodeActions
                              to={agentActivityRoute(session.id, searchParams)}
                              id={session.id}
                              name={session.name}
                              onDeleted={() => {
                                setOverview((current) =>
                                  current
                                    ? {
                                        ...current,
                                        sessions: current.sessions.filter(
                                          (candidate) => candidate.id !== session.id,
                                        ),
                                        total: Math.max(0, current.total - 1),
                                        active: Math.max(
                                          0,
                                          current.active - (session.active ? 1 : 0),
                                        ),
                                      }
                                    : current,
                                )
                                toggleEpisode(session.id, false)
                              }}
                            />
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
