import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react'
import { STORE_EVENT } from '@notarium/contract/events'
import type { StoreEvent, SyncStatus } from '../../libs/wire'
import { api } from '../../services/api'
import { dropPreviews } from '../../services/previews'
import { useAuth } from '../AuthProvider'
import { useSpaceAccess } from '../SpaceAccessProvider'
import { useSpace } from '../SpaceProvider'
import { advanceConnectionRevisions, advanceObservationEpoch } from './connectionRevision'

// The app's single server-push subscription (#60): one EventSource feeds every
// consumer — the sidebar sync indicator reads `status`, NotesProvider rides
// `changed`/`status` to keep the list fresh, GraphView refetches the graph. A consumer
// may multiplex additional readable spaces onto that SAME socket when its current
// active-space surface intentionally renders cross-space data.
// Components subscribe through this context instead of opening their own
// connections (the indicator must not cost a second SSE stream).
// The channel is rooted in one ACTIVE SPACE (#16): switching spaces closes the old
// stream. Cross-space context rows may explicitly add readable supplemental buses to
// that same socket; ordinary space-scoped consumers never request them.

type Listener = (event: StoreEvent) => void
type ContextListener = (event: StoreEvent, sourceSpace?: string) => void

/** How far back `changedLastMinute` counts — the "+M/min" activity window. */
const RATE_WINDOW_MS = 60_000

/** Delay (ms) a consumer waits after a `changed` event before reloading, so a burst
 *  of changed frames (a delta poll landing many notes) coalesces into one refetch.
 *  One knob for every `changed`-driven reloader (Feed, Notes, Dashboard, Context,
 *  memory tree) so their settle cadence stays consistent. */
export const CHANGED_COALESCE_MS = 1_000

export type SyncContextValue = {
  /** Latest read-model status; null until the first SSE frame arrives. */
  status: SyncStatus | null
  /** Notes the read-model upserted/removed within the last minute — the
   *  engine-activity counter next to `engine.indexed` in the indicator. */
  changedLastMinute: () => number
  /** Raw event tap for consumers with their own reaction logic. Returns the
   *  unsubscribe. Listeners fire after `status` state is updated. */
  subscribe: (listener: Listener) => () => void
  /** Successful SSE connections, including transparent browser reconnects. A
   *  consumer includes the value in snapshot requests so missed `changed`
   *  frames are reconciled by the first response from the new connection. */
  connectionRevision: number
  /** A supplemental watch expansion reached server readiness. Context snapshots
   * reconcile the pre-subscription window without waking unrelated consumers. */
  contextWatchRevision: number
  /** Monotonic truth epoch advanced synchronously before every changed frame
   *  and on every reconnect. Requests capture it before they start. */
  observationEpoch: () => number
  /** Bumps on every server `members` event for the active space (#121-follow-up):
   *  a space-level membership change (add/remove/role). The members tab folds this
   *  into its reload key so an open list re-fetches live for ANY viewer. */
  membersRev: number
  /** Owner-global durable agent-session changes observed on this tab's SSE socket. */
  agentSessionsRev: number
  /** Principal grants changed, including a non-active-space revoke. */
  accessRevision: number
  /** Replace the readable supplemental spaces multiplexed onto the active socket. */
  watchSpaces: (spaces: readonly string[]) => void
  /** Context-only event tap: active changed frames plus supplemental changed ids. */
  subscribeContext: (listener: ContextListener) => () => void
}

const SyncContext = createContext<SyncContextValue | null>(null)

export const useSync = (): SyncContextValue => {
  const ctx = useContext(SyncContext)

  if (!ctx) {
    throw new Error('useSync must be used within SyncProvider')
  }

  return ctx
}

/** Backoff before reopening a stream the browser refused to retry (a non-200
 *  reconnect — CLOSED). Long enough not to hammer a restarting server, short
 *  enough that a transient outage self-heals quickly. */
const REOPEN_DELAY_MS = 3000

export const SyncProvider = ({ children }: { children: ReactNode }) => {
  const { space, reloadSpaces, reloadArchived } = useSpace()
  const { refresh } = useAuth()
  const { verify } = useSpaceAccess()
  const [status, setStatus] = useState<SyncStatus | null>(null)
  const [membersRev, setMembersRev] = useState(0)
  const [agentSessionsRev, setAgentSessionsRev] = useState(0)
  const [accessRevision, setAccessRevision] = useState(0)
  const [connectionRevision, setConnectionRevision] = useState(0)
  const [contextWatchRevision, setContextWatchRevision] = useState(0)
  const [watchedSpaces, setWatchedSpaces] = useState<string[]>([])
  const connectionRevisionRef = useRef(0)
  const openedSpaceRef = useRef<string | null>(null)
  const openedWatchKeyRef = useRef('')
  const activeStreamRef = useRef<(() => void) | null>(null)
  const pendingStreamRef = useRef<(() => void) | null>(null)
  const streamGenerationRef = useRef(0)
  const handoffNeedsReconciliationRef = useRef(false)
  const observationEpochRef = useRef(0)
  const agentSessionsRevisionRef = useRef(0)
  const listeners = useRef(new Set<Listener>())
  const contextListeners = useRef(new Set<ContextListener>())
  const changes = useRef<Array<{ at: number; count: number }>>([])

  useEffect(() => {
    const generation = ++streamGenerationRef.current

    if (openedSpaceRef.current !== null && openedSpaceRef.current !== space) {
      activeStreamRef.current?.()
      activeStreamRef.current = null
    }
    pendingStreamRef.current?.()
    pendingStreamRef.current = null
    if (openedSpaceRef.current !== space) {
      // A fresh space = a fresh read-model: the stale status must not flash
      // while the new stream's first frame is in flight. A watch-only replacement
      // keeps both the active status and its one-minute activity window.
      setStatus(null)
      changes.current = []
    }

    let stopped = false
    let reopen: ReturnType<typeof setTimeout> | null = null

    let unsub: () => void = () => {}
    let openedOnce = false

    const onEvent = (event: StoreEvent) => {
      if (event.type === STORE_EVENT.STATUS) {
        setStatus(event.status)
      } else if (event.type === STORE_EVENT.CHANGED) {
        observationEpochRef.current = advanceObservationEpoch(observationEpochRef.current)
        const now = Date.now()
        changes.current.push({ at: now, count: event.upserts.length + event.removed.length })
        while (changes.current.length && changes.current[0].at < now - RATE_WINDOW_MS) {
          changes.current.shift()
        }
        // Precise preview invalidation (#64): the named notes' previews are
        // stale in this session's dedupe map — covers our own writes and
        // multi-user/external edits alike.
        dropPreviews([...event.upserts, ...event.removed])
      }
      for (const listener of listeners.current) {
        try {
          listener(event)
        } catch {
          // one consumer's bug must not starve the others of events
        }
      }
      if (event.type === STORE_EVENT.CHANGED) {
        for (const listener of contextListeners.current) {
          try {
            listener(event)
          } catch {
            // Context listener isolation matches the ordinary bus.
          }
        }
      }
    }

    const onError = (closed: boolean) => {
      // `closed` = the browser gave up reconnecting (a non-200 reply — the
      // 401/404 a revoked principal now gets, #111). Ask the access detector
      // whether this is a real revocation (→ takeover); a transient blip stays
      // CONNECTING and the browser handles it, so we ignore that here.
      if (stopped) {
        // A controlled replacement retains this stream until the server declares
        // the new watch set ready. If the retained leg becomes unavailable first,
        // the overlap proof is gone and the replacement must reconcile snapshots.
        if (activeStreamRef.current === unsub) {
          handoffNeedsReconciliationRef.current = true
        }
        if (closed) {
          verify()
        }

        return
      }
      if (!closed) {
        return
      }
      verify()
      // The browser won't retry a failed connection — reopen ourselves so a
      // transient server restart recovers without a reload. A confirmed loss
      // unmounts this provider (the takeover), which clears the timer.
      unsub()
      if (activeStreamRef.current === unsub) {
        activeStreamRef.current = null
      }
      if (pendingStreamRef.current === unsub) {
        pendingStreamRef.current = null
      }
      reopen = setTimeout(() => {
        if (!stopped) {
          openedOnce = false
          open()
        }
      }, REOPEN_DELAY_MS)
    }

    // A grant/role change (or a non-active-space revoke) nudged us (#111
    // grant-side): re-sync the principal facts so the new space appears in the
    // switcher and a role change takes — no reload. refresh() updates `me`
    // (grants/role), reloadSpaces() the membership-filtered list.
    const onAccess = () => {
      setAccessRevision((revision) => revision + 1)
      reloadSpaces()
      reloadArchived()
      void refresh()
    }

    // A membership change in THIS space (#121-follow-up): bump the revision so an
    // open members list re-fetches — covers add/remove/role for any viewer, not
    // just the affected principal (that's the addressed `access` nudge above).
    const onMembers = () => setMembersRev((r) => r + 1)

    const onAgentSessions = () => {
      agentSessionsRevisionRef.current += 1
      setAgentSessionsRev(agentSessionsRevisionRef.current)
    }

    const onContextEvent = (event: StoreEvent, sourceSpace: string) => {
      if (event.type !== STORE_EVENT.CHANGED) {
        return
      }
      for (const listener of contextListeners.current) {
        try {
          listener(event, sourceSpace)
        } catch {
          // One Context consumer cannot starve another.
        }
      }
    }

    // This space's slug changed (#100 phase 4 / #123), renamed from another tab: adopt the
    // new slug live. reloadSpaces re-fetches the list (new slug + the old one in
    // aliases) and rename-follows the active slug; refresh updates `me.spaces` so the
    // access classifier keys off the new slug (and never false-flags `space-lost`).
    const onRename = () => {
      reloadSpaces()
      void refresh()
    }

    const watchKey = watchedSpaces.join('\u0000')
    const controlledWatchChange =
      openedSpaceRef.current === space && openedWatchKeyRef.current !== watchKey
    const openedWatches = new Set(
      openedWatchKeyRef.current ? openedWatchKeyRef.current.split('\u0000') : [],
    )
    const expandsWatch =
      controlledWatchChange && watchedSpaces.some((watched) => !openedWatches.has(watched))

    const advanceRevisions = () => {
      const revisions = advanceConnectionRevisions({
        connectionRevision: connectionRevisionRef.current,
        observationEpoch: observationEpochRef.current,
        agentSessionsRevision: agentSessionsRevisionRef.current,
      })

      connectionRevisionRef.current = revisions.connectionRevision
      observationEpochRef.current = revisions.observationEpoch
      agentSessionsRevisionRef.current = revisions.agentSessionsRevision
      setConnectionRevision(revisions.connectionRevision)
      setAgentSessionsRev(agentSessionsRevisionRef.current)
    }

    const onReady = (reconnected: boolean) => {
      if (!openedOnce) {
        openedOnce = true
        if (stopped) {
          unsub()
          return
        }
        const previous = activeStreamRef.current

        activeStreamRef.current = unsub
        if (pendingStreamRef.current === unsub) {
          pendingStreamRef.current = null
        }
        if (previous && previous !== unsub) {
          previous()
        }
      }
      openedSpaceRef.current = space
      openedWatchKeyRef.current = watchKey
      const reconcileHandoff = handoffNeedsReconciliationRef.current

      handoffNeedsReconciliationRef.current = false
      if (!reconnected && controlledWatchChange && !reconcileHandoff) {
        if (expandsWatch) {
          setContextWatchRevision((revision) => revision + 1)
        }

        return
      }
      advanceRevisions()
    }

    const open = () => {
      unsub = api.events(
        space,
        onEvent,
        onError,
        onAccess,
        onMembers,
        onRename,
        onAgentSessions,
        undefined,
        watchedSpaces,
        onContextEvent,
        onReady,
      )
      pendingStreamRef.current = unsub
    }
    open()

    return () => {
      stopped = true
      if (reopen) {
        clearTimeout(reopen)
      }
      queueMicrotask(() => {
        // The live generation is the handoff proof: a newer effect keeps the old
        // socket until its replacement opens; an unmount closes it in this microtask.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        if (streamGenerationRef.current !== generation) {
          return
        }
        const owned = new Set([unsub, pendingStreamRef.current, activeStreamRef.current])

        pendingStreamRef.current = null
        activeStreamRef.current = null
        for (const close of owned) {
          close?.()
        }
      })
    }
  }, [space, verify, reloadSpaces, reloadArchived, refresh, watchedSpaces])

  const subscribe = useCallback((listener: Listener) => {
    listeners.current.add(listener)
    return () => {
      listeners.current.delete(listener)
    }
  }, [])
  const subscribeContext = useCallback((listener: ContextListener) => {
    contextListeners.current.add(listener)
    return () => {
      contextListeners.current.delete(listener)
    }
  }, [])

  const changedLastMinute = useCallback(() => {
    const cutoff = Date.now() - RATE_WINDOW_MS
    let sum = 0

    for (const c of changes.current) {
      if (c.at >= cutoff) {
        sum += c.count
      }
    }

    return sum
  }, [])

  const observationEpoch = useCallback(() => observationEpochRef.current, [])
  const watchSpaces = useCallback((spaces: readonly string[]) => {
    const next = [...new Set(spaces.filter(Boolean))].sort()

    setWatchedSpaces((current) =>
      current.length === next.length && current.every((item, index) => item === next[index])
        ? current
        : next,
    )
  }, [])

  return (
    <SyncContext.Provider
      value={{
        status,
        changedLastMinute,
        subscribe,
        connectionRevision,
        contextWatchRevision,
        observationEpoch,
        membersRev,
        agentSessionsRev,
        accessRevision,
        watchSpaces,
        subscribeContext,
      }}
    >
      {children}
    </SyncContext.Provider>
  )
}
