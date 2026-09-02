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
import {
  collectActivityWindow,
  continueActivityWindow,
  flattenActivityWindow,
} from './helpers/activityWindow'
import styles from './ActivityPage.module.scss'

type EpisodeState = {
  data: AgentSessionEvents | null
  committedDepth: number
  requestedDepth: number
  version: number
  loading: boolean
  loadingMore: boolean
  failed: boolean
  failedOperation: 'refresh' | 'continuation'
}

// One expanded overview can expose 31 timelines. Revision-driven revalidation
// shares a small browser/server budget; direct user continuation remains immediate.
const EPISODE_REFRESH_CONCURRENCY = 4

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
  const { searchParams, sessionsVersion, setState, state } = useActivityFrame()
  const [stream, setStream] = useState<AgentSessionEvents | null>(null)
  const [overview, setOverview] = useState<AgentSessions | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [failed, setFailed] = useState(false)
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set())
  const [episodes, setEpisodes] = useState<Record<string, EpisodeState>>({})
  const streamRef = useRef(stream)
  streamRef.current = stream
  const overviewRef = useRef(overview)
  overviewRef.current = overview
  const requestSeq = useRef(0)
  const requestAbort = useRef<AbortController | null>(null)
  const streamDepth = useRef({ committed: 0, requested: 1 })
  const overviewDepth = useRef({ committed: 0, requested: 1 })
  const streamFailedOperation = useRef<'refresh' | 'continuation'>('refresh')
  const overviewFailedOperation = useRef<'refresh' | 'continuation'>('refresh')
  const observedSessionsVersion = useRef(sessionsVersion)
  const latestSessionsVersion = useRef(sessionsVersion)
  latestSessionsVersion.current = sessionsVersion
  const episodeRequestSeq = useRef(0)
  const episodeRequests = useRef(
    new Map<string, { seq: number; version: number; depth: number; controller: AbortController }>(),
  )
  const episodeRefreshQueue = useRef(new Map<string, { version: number; depth: number }>())
  const activeQueuedEpisodeIds = useRef(new Set<string>())
  const visibleEpisodeIds = useRef(new Set<string>())
  const episodeQueueEpoch = useRef(0)
  const pumpEpisodeRefreshes = useRef<() => void>(() => {})
  const episodesRef = useRef(episodes)
  episodesRef.current = episodes

  const abortEpisodeRequests = useCallback(() => {
    episodeQueueEpoch.current += 1
    episodeRefreshQueue.current.clear()
    activeQueuedEpisodeIds.current.clear()
    episodeRequestSeq.current += 1
    for (const request of episodeRequests.current.values()) {
      request.controller.abort()
    }
    episodeRequests.current.clear()
  }, [])

  const clearEpisodes = useCallback(() => {
    abortEpisodeRequests()
    visibleEpisodeIds.current.clear()
    setExpandedIds(new Set())
    episodesRef.current = {}
    setEpisodes({})
  }, [abortEpisodeRequests])

  const dropEpisode = useCallback((id: string) => {
    episodeRefreshQueue.current.delete(id)
    episodeRequests.current.get(id)?.controller.abort()
    episodeRequests.current.delete(id)
    setExpandedIds((previous) => {
      const next = new Set(previous)
      next.delete(id)
      return next
    })
    setEpisodes((previous) => {
      const next = { ...previous }
      delete next[id]
      episodesRef.current = next
      return next
    })
  }, [])

  useEffect(() => () => abortEpisodeRequests(), [abortEpisodeRequests])

  const refreshStream = useCallback(async () => {
    const seq = ++requestSeq.current
    requestAbort.current?.abort()
    const controller = new AbortController()
    requestAbort.current = controller
    const requestedDepth = streamDepth.current.requested

    setLoading(true)
    setLoadingMore(requestedDepth > streamDepth.current.committed)
    setFailed(false)
    streamFailedOperation.current = 'refresh'
    try {
      const window = await collectActivityWindow(
        (cursor) =>
          api.agentSessionEventsGet(
            'all',
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
      streamDepth.current = { committed: window.depth, requested: window.depth }
      const nextStream = {
        ...window.first,
        events: flattenActivityWindow(
          window.pages,
          (page) => page.events,
          (event) => `${event.type}:${event.id}`,
        ),
        hasMore: window.last.hasMore && window.nextCursor != null,
        nextCursor: window.nextCursor,
      }
      streamRef.current = nextStream
      setStream(nextStream)
    } catch {
      if (seq === requestSeq.current && !controller.signal.aborted) {
        setFailed(true)
      }
    } finally {
      if (seq === requestSeq.current) {
        setLoading(false)
        setLoadingMore(false)
      }
    }
  }, [state.agent, state.outcome, state.q, state.show, state.tool])

  const refreshOverview = useCallback(async () => {
    const seq = ++requestSeq.current
    requestAbort.current?.abort()
    const controller = new AbortController()
    requestAbort.current = controller
    const requestedDepth = overviewDepth.current.requested

    setLoading(true)
    setLoadingMore(requestedDepth > overviewDepth.current.committed)
    setFailed(false)
    overviewFailedOperation.current = 'refresh'
    try {
      const window = await collectActivityWindow(
        (cursor) =>
          api.agentSessionsGet(
            {
              limit: 30,
              cursor,
              filter: state.show === 'all' ? undefined : state.show,
              aggregates: '0',
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
      overviewDepth.current = { committed: window.depth, requested: window.depth }
      const nextOverview = {
        ...window.first,
        sessions: flattenActivityWindow(
          window.pages,
          (page) => page.sessions,
          (session) => session.id,
        ),
        hasMore: window.last.hasMore && window.nextCursor != null,
        nextCursor: window.nextCursor,
      }
      overviewRef.current = nextOverview
      setOverview(nextOverview)
    } catch {
      if (seq === requestSeq.current && !controller.signal.aborted) {
        setFailed(true)
      }
    } finally {
      if (seq === requestSeq.current) {
        setLoading(false)
        setLoadingMore(false)
      }
    }
  }, [state.show])

  const continueStream = useCallback(async () => {
    const previous = streamRef.current
    const cursor = previous?.nextCursor

    if (!previous || !cursor) {
      return
    }
    const seq = ++requestSeq.current
    requestAbort.current?.abort()
    const controller = new AbortController()
    requestAbort.current = controller
    const committedDepth = streamDepth.current.committed

    setLoading(true)
    setLoadingMore(true)
    setFailed(false)
    streamFailedOperation.current = 'continuation'
    try {
      const continuation = await continueActivityWindow(
        (nextCursor) =>
          api.agentSessionEventsGet(
            'all',
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
      const nextStream = {
        ...previous,
        events: flattenActivityWindow(
          [previous, continuation.page],
          (page) => page.events,
          (event) => `${event.type}:${event.id}`,
        ),
        hasMore: continuation.page.hasMore && continuation.nextCursor != null,
        nextCursor: continuation.nextCursor,
      }
      streamDepth.current = { committed: nextDepth, requested: nextDepth }
      streamRef.current = nextStream
      setStream(nextStream)
    } catch {
      if (seq === requestSeq.current && !controller.signal.aborted) {
        setFailed(true)
      }
    } finally {
      if (seq === requestSeq.current) {
        setLoading(false)
        setLoadingMore(false)
      }
    }
  }, [state.agent, state.outcome, state.q, state.show, state.tool])

  const continueOverview = useCallback(async () => {
    const previous = overviewRef.current
    const cursor = previous?.nextCursor

    if (!previous || !cursor) {
      return
    }
    const seq = ++requestSeq.current
    requestAbort.current?.abort()
    const controller = new AbortController()
    requestAbort.current = controller
    const committedDepth = overviewDepth.current.committed

    setLoading(true)
    setLoadingMore(true)
    setFailed(false)
    overviewFailedOperation.current = 'continuation'
    try {
      const continuation = await continueActivityWindow(
        (nextCursor) =>
          api.agentSessionsGet(
            {
              limit: 30,
              cursor: nextCursor,
              filter: state.show === 'all' ? undefined : state.show,
              aggregates: '0',
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
      const nextOverview = {
        ...previous,
        sessions: flattenActivityWindow(
          [previous, continuation.page],
          (page) => page.sessions,
          (session) => session.id,
        ),
        hasMore: continuation.page.hasMore && continuation.nextCursor != null,
        nextCursor: continuation.nextCursor,
      }
      overviewDepth.current = { committed: nextDepth, requested: nextDepth }
      overviewRef.current = nextOverview
      setOverview(nextOverview)
    } catch {
      if (seq === requestSeq.current && !controller.signal.aborted) {
        setFailed(true)
      }
    } finally {
      if (seq === requestSeq.current) {
        setLoading(false)
        setLoadingMore(false)
      }
    }
  }, [state.show])

  useEffect(() => {
    if (state.group !== 'none') {
      return undefined
    }
    observedSessionsVersion.current = latestSessionsVersion.current
    requestSeq.current += 1
    requestAbort.current?.abort()
    streamDepth.current = { committed: 0, requested: 1 }
    streamFailedOperation.current = 'refresh'
    clearEpisodes()
    streamRef.current = null
    setStream(null)
    setLoading(true)
    void refreshStream()
    return () => {
      requestSeq.current += 1
      requestAbort.current?.abort()
    }
  }, [clearEpisodes, refreshStream, state.group])

  useEffect(() => {
    if (state.group !== 'session') {
      return undefined
    }
    observedSessionsVersion.current = latestSessionsVersion.current
    requestSeq.current += 1
    requestAbort.current?.abort()
    overviewDepth.current = { committed: 0, requested: 1 }
    overviewFailedOperation.current = 'refresh'
    clearEpisodes()
    overviewRef.current = null
    setOverview(null)
    setLoading(true)
    void refreshOverview()
    return () => {
      requestSeq.current += 1
      requestAbort.current?.abort()
    }
  }, [clearEpisodes, refreshOverview, state.group])

  const refreshEpisode = useCallback(
    async (id: string, version: number, requestedDepth?: number) => {
      const previousState = episodesRef.current[id]
      const wantedDepth = requestedDepth ?? previousState?.requestedDepth ?? 1
      const currentRequest = episodeRequests.current.get(id)

      if (
        currentRequest &&
        currentRequest.version >= version &&
        currentRequest.depth >= wantedDepth
      ) {
        return
      }
      currentRequest?.controller.abort()
      const seq = ++episodeRequestSeq.current
      const controller = new AbortController()
      episodeRequests.current.set(id, { seq, version, depth: wantedDepth, controller })
      setEpisodes((previous) => {
        const next = {
          ...previous,
          [id]: {
            data: previous[id]?.data ?? null,
            committedDepth: previous[id]?.committedDepth ?? 0,
            requestedDepth: wantedDepth,
            version: previous[id]?.version ?? -1,
            loading: true,
            loadingMore: wantedDepth > (previous[id]?.committedDepth ?? 0),
            failed: false,
            failedOperation: 'refresh' as const,
          },
        }
        episodesRef.current = next
        return next
      })
      try {
        const window = await collectActivityWindow(
          (cursor) =>
            api.agentSessionEventsGet(
              id,
              {
                limit: 50,
                cursor,
                filter: state.show === 'all' ? undefined : state.show,
                tool: state.tool ?? undefined,
                outcome: state.outcome === 'all' ? undefined : state.outcome,
              },
              controller.signal,
            ),
          {
            requestedDepth: wantedDepth,
            cursorOf: (page) => page.nextCursor,
            current: () =>
              episodeRequests.current.get(id)?.seq === seq && !controller.signal.aborted,
          },
        )

        if (!window) {
          return
        }
        setEpisodes((previous) => {
          const next = {
            ...previous,
            [id]: {
              data: {
                ...window.first,
                events: flattenActivityWindow(
                  window.pages,
                  (page) => page.events,
                  (event) => `${event.type}:${event.id}`,
                ),
                hasMore: window.last.hasMore && window.nextCursor != null,
                nextCursor: window.nextCursor,
              },
              committedDepth: window.depth,
              requestedDepth: window.depth,
              version,
              loading: false,
              loadingMore: false,
              failed: false,
              failedOperation: 'refresh' as const,
            },
          }
          episodesRef.current = next
          return next
        })
      } catch (error) {
        if (episodeRequests.current.get(id)?.seq === seq && !controller.signal.aborted) {
          if (error instanceof ApiError && error.status === HTTP_STATUS.NOT_FOUND) {
            dropEpisode(id)
            return
          }
          setEpisodes((previous) => {
            const next = {
              ...previous,
              [id]: {
                data: previous[id]?.data ?? null,
                committedDepth: previous[id]?.committedDepth ?? 0,
                requestedDepth: wantedDepth,
                version: previous[id]?.version ?? -1,
                loading: false,
                loadingMore: false,
                failed: true,
                failedOperation: 'refresh' as const,
              },
            }
            episodesRef.current = next
            return next
          })
        }
      } finally {
        if (episodeRequests.current.get(id)?.seq === seq) {
          episodeRequests.current.delete(id)
        }
      }
    },
    [dropEpisode, state.outcome, state.show, state.tool],
  )

  const continueEpisode = useCallback(
    async (id: string, version: number, requestedDepth: number) => {
      const previousState = episodesRef.current[id]
      const previous = previousState?.data
      const cursor = previous?.nextCursor

      if (!previousState || !previous || !cursor) {
        return
      }
      episodeRefreshQueue.current.delete(id)
      const currentRequest = episodeRequests.current.get(id)
      currentRequest?.controller.abort()
      const seq = ++episodeRequestSeq.current
      const controller = new AbortController()
      episodeRequests.current.set(id, { seq, version, depth: requestedDepth, controller })
      setEpisodes((current) => {
        const next = {
          ...current,
          [id]: {
            ...current[id],
            requestedDepth,
            loading: true,
            loadingMore: true,
            failed: false,
            failedOperation: 'continuation' as const,
          },
        }
        episodesRef.current = next
        return next
      })
      try {
        const continuation = await continueActivityWindow(
          (nextCursor) =>
            api.agentSessionEventsGet(
              id,
              {
                limit: 50,
                cursor: nextCursor,
                filter: state.show === 'all' ? undefined : state.show,
                tool: state.tool ?? undefined,
                outcome: state.outcome === 'all' ? undefined : state.outcome,
              },
              controller.signal,
            ),
          {
            cursor,
            cursorOf: (page) => page.nextCursor,
            current: () =>
              episodeRequests.current.get(id)?.seq === seq && !controller.signal.aborted,
          },
        )

        if (!continuation) {
          return
        }
        const nextDepth = previousState.committedDepth + 1
        setEpisodes((current) => {
          const next = {
            ...current,
            [id]: {
              data: {
                ...previous,
                events: flattenActivityWindow(
                  [previous, continuation.page],
                  (page) => page.events,
                  (event) => `${event.type}:${event.id}`,
                ),
                hasMore: continuation.page.hasMore && continuation.nextCursor != null,
                nextCursor: continuation.nextCursor,
              },
              committedDepth: nextDepth,
              requestedDepth: nextDepth,
              version,
              loading: false,
              loadingMore: false,
              failed: false,
              failedOperation: 'continuation' as const,
            },
          }
          episodesRef.current = next
          return next
        })
      } catch (error) {
        if (episodeRequests.current.get(id)?.seq === seq && !controller.signal.aborted) {
          if (error instanceof ApiError && error.status === HTTP_STATUS.NOT_FOUND) {
            dropEpisode(id)
            return
          }
          setEpisodes((current) => {
            const next = {
              ...current,
              [id]: {
                data: current[id]?.data ?? previous,
                committedDepth: current[id]?.committedDepth ?? previousState.committedDepth,
                requestedDepth,
                version: current[id]?.version ?? previousState.version,
                loading: false,
                loadingMore: false,
                failed: true,
                failedOperation: 'continuation' as const,
              },
            }
            episodesRef.current = next
            return next
          })
        }
      } finally {
        if (episodeRequests.current.get(id)?.seq === seq) {
          episodeRequests.current.delete(id)
        }
      }
    },
    [dropEpisode, state.outcome, state.show, state.tool],
  )

  const runEpisodeRefreshQueue = useCallback(() => {
    while (activeQueuedEpisodeIds.current.size < EPISODE_REFRESH_CONCURRENCY) {
      let candidate: [string, { version: number; depth: number }] | null = null

      for (const entry of episodeRefreshQueue.current) {
        const [id] = entry

        if (!visibleEpisodeIds.current.has(id)) {
          episodeRefreshQueue.current.delete(id)
          continue
        }
        if (!activeQueuedEpisodeIds.current.has(id)) {
          candidate = entry
          break
        }
      }
      if (!candidate) {
        return
      }
      const [id, request] = candidate
      const epoch = episodeQueueEpoch.current
      episodeRefreshQueue.current.delete(id)
      activeQueuedEpisodeIds.current.add(id)
      void refreshEpisode(id, request.version, request.depth).finally(() => {
        if (episodeQueueEpoch.current !== epoch) {
          return
        }
        activeQueuedEpisodeIds.current.delete(id)
        pumpEpisodeRefreshes.current()
      })
    }
  }, [refreshEpisode])
  pumpEpisodeRefreshes.current = runEpisodeRefreshQueue

  const enqueueEpisodeRefresh = useCallback((id: string, version: number, depth: number) => {
    const queued = episodeRefreshQueue.current.get(id)

    if (!queued || queued.version < version || queued.depth < depth) {
      episodeRefreshQueue.current.set(id, {
        version: Math.max(queued?.version ?? -1, version),
        depth: Math.max(queued?.depth ?? 1, depth),
      })
    }
    const active = episodeRequests.current.get(id)

    if (active && (active.version < version || active.depth < depth)) {
      active.controller.abort()
    }
    pumpEpisodeRefreshes.current()
  }, [])

  const toggleEpisode = (id: string, open: boolean) => {
    if (!open) {
      dropEpisode(id)
      return
    }
    setExpandedIds((previous) => new Set(previous).add(id))
  }

  useEffect(() => {
    if (state.group !== 'session' || !overview) {
      return
    }
    const visible = new Set(overview.sessions.map((session) => session.id))

    if (overview.outside) {
      visible.add('outside')
    }
    visibleEpisodeIds.current = visible
    for (const id of episodeRefreshQueue.current.keys()) {
      if (!visible.has(id)) {
        episodeRefreshQueue.current.delete(id)
      }
    }
    for (const id of activeQueuedEpisodeIds.current) {
      if (!visible.has(id)) {
        episodeRequests.current.get(id)?.controller.abort()
      }
    }
    for (const id of expandedIds) {
      if (visible.has(id) && (episodesRef.current[id]?.version ?? -1) < sessionsVersion) {
        enqueueEpisodeRefresh(id, sessionsVersion, episodesRef.current[id]?.requestedDepth ?? 1)
      }
    }
  }, [enqueueEpisodeRefresh, expandedIds, overview, sessionsVersion, state.group])

  useEffect(() => {
    if (observedSessionsVersion.current === sessionsVersion) {
      return
    }
    observedSessionsVersion.current = sessionsVersion
    void (state.group === 'session' ? refreshOverview() : refreshStream())
  }, [refreshOverview, refreshStream, sessionsVersion, state.group])

  const loadOlderStream = () => {
    streamDepth.current.requested =
      Math.max(streamDepth.current.committed, streamDepth.current.requested) + 1
    void continueStream()
  }

  const loadOlderOverview = () => {
    overviewDepth.current.requested =
      Math.max(overviewDepth.current.committed, overviewDepth.current.requested) + 1
    void continueOverview()
  }

  const loadOlderEpisode = (id: string) => {
    const current = episodesRef.current[id]
    const requestedDepth = Math.max(current?.committedDepth ?? 0, current?.requestedDepth ?? 1) + 1
    const next = {
      ...(current ?? {
        data: null,
        committedDepth: 0,
        version: -1,
        loading: false,
        loadingMore: false,
        failed: false,
        failedOperation: 'refresh' as const,
      }),
      requestedDepth,
    }
    episodesRef.current = { ...episodesRef.current, [id]: next }
    setEpisodes(episodesRef.current)
    episodeRefreshQueue.current.delete(id)
    void (current?.version === sessionsVersion
      ? continueEpisode(id, sessionsVersion, requestedDepth)
      : refreshEpisode(id, sessionsVersion, requestedDepth))
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

    const retryEpisode = () => {
      const requestedDepth = episodeState?.requestedDepth ?? 1

      void (episodeState?.failedOperation === 'continuation' &&
      episodeState.version === sessionsVersion
        ? continueEpisode(id, sessionsVersion, requestedDepth)
        : refreshEpisode(id, sessionsVersion, requestedDepth))
    }

    return (
      <div className={styles.sessionCardBody} data-testid="activity-session-events">
        {!episodeState || (episodeState.loading && !episodeState.data) ? (
          <ActivityListSkeleton rows={4} />
        ) : matchingEpisode ? (
          <>
            {episodeState.failed && (
              <Notice variant="error" className={styles.loadError}>
                <span>Couldn’t refresh this episode.</span>
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
                  onClick={() => loadOlderEpisode(id)}
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
                  ? overviewFailedOperation.current === 'continuation'
                    ? continueOverview()
                    : refreshOverview()
                  : streamFailedOperation.current === 'continuation'
                    ? continueStream()
                    : refreshStream())
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
                    <Button variant="ghost" disabled={loadingMore} onClick={loadOlderStream}>
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
                                requestSeq.current += 1
                                requestAbort.current?.abort()
                                setLoading(false)
                                setLoadingMore(false)
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
                                dropEpisode(session.id)
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
                    <Button variant="ghost" disabled={loadingMore} onClick={loadOlderOverview}>
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
