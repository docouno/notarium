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

// The app's single server-push subscription (#60): one EventSource feeds every
// consumer — the sidebar sync indicator reads `status`, NotesProvider rides
// `changed`/`status` to keep the list fresh, GraphView refetches the graph.
// Components subscribe through this context instead of opening their own
// connections (the indicator must not cost a second SSE stream).
// The channel is PER SPACE (#16): switching spaces closes the old stream and
// opens the new one — an event from another space physically cannot arrive.

type Listener = (event: StoreEvent) => void

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
  /** Bumps on every server `members` event for the active space (#121-follow-up):
   *  a space-level membership change (add/remove/role). The members tab folds this
   *  into its reload key so an open list re-fetches live for ANY viewer. */
  membersRev: number
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
  const listeners = useRef(new Set<Listener>())
  const changes = useRef<Array<{ at: number; count: number }>>([])

  useEffect(() => {
    // A fresh space = a fresh read-model: the stale status must not flash
    // while the new stream's first frame is in flight.
    setStatus(null)
    changes.current = []

    let stopped = false
    let reopen: ReturnType<typeof setTimeout> | null = null

    let unsub: () => void = () => {}

    const onEvent = (event: StoreEvent) => {
      if (event.type === STORE_EVENT.STATUS) {
        setStatus(event.status)
      } else if (event.type === STORE_EVENT.CHANGED) {
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
    }

    const onError = (closed: boolean) => {
      // `closed` = the browser gave up reconnecting (a non-200 reply — the
      // 401/404 a revoked principal now gets, #111). Ask the access detector
      // whether this is a real revocation (→ takeover); a transient blip stays
      // CONNECTING and the browser handles it, so we ignore that here.
      if (!closed || stopped) {
        return
      }
      verify()
      // The browser won't retry a failed connection — reopen ourselves so a
      // transient server restart recovers without a reload. A confirmed loss
      // unmounts this provider (the takeover), which clears the timer.
      unsub()
      reopen = setTimeout(() => {
        if (!stopped) {
          open()
        }
      }, REOPEN_DELAY_MS)
    }

    // A grant/role change (or a non-active-space revoke) nudged us (#111
    // grant-side): re-sync the principal facts so the new space appears in the
    // switcher and a role change takes — no reload. refresh() updates `me`
    // (grants/role), reloadSpaces() the membership-filtered list.
    const onAccess = () => {
      reloadSpaces()
      reloadArchived()
      void refresh()
    }

    // A membership change in THIS space (#121-follow-up): bump the revision so an
    // open members list re-fetches — covers add/remove/role for any viewer, not
    // just the affected principal (that's the addressed `access` nudge above).
    const onMembers = () => setMembersRev((r) => r + 1)

    // This space's slug changed (#100 phase 4 / #123), renamed from another tab: adopt the
    // new slug live. reloadSpaces re-fetches the list (new slug + the old one in
    // aliases) and rename-follows the active slug; refresh updates `me.spaces` so the
    // access classifier keys off the new slug (and never false-flags `space-lost`).
    const onRename = () => {
      reloadSpaces()
      void refresh()
    }

    const open = () => {
      unsub = api.events(space, onEvent, onError, onAccess, onMembers, onRename)
    }
    open()

    return () => {
      stopped = true
      if (reopen) {
        clearTimeout(reopen)
      }
      unsub()
    }
  }, [space, verify, reloadSpaces, reloadArchived, refresh])

  const subscribe = useCallback((listener: Listener) => {
    listeners.current.add(listener)
    return () => {
      listeners.current.delete(listener)
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

  return (
    <SyncContext.Provider value={{ status, changedLastMinute, subscribe, membersRev }}>
      {children}
    </SyncContext.Provider>
  )
}
