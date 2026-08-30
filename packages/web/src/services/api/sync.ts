import type { StoreEvent, SyncStatus } from '@notarium/contract'
import { SSE_EVENT } from '@notarium/contract/events'
import { req, sp } from './client'

export const syncApi = {
  statusGet: (space: string) => req<SyncStatus>(`${sp(space)}/status`),
  /** Server-push channel (#60), per space (#16): `status` on read-model
   *  lifecycle/poll moves, `changed` with the affected note ids when content
   *  moved. EventSource auto-reconnects on drops; malformed frames are
   *  skipped, not thrown. Returns the unsubscribe.
   *
   *  `onError` (#111) reports a connection failure with `closed` = the browser
   *  gave up reconnecting (readyState CLOSED). Per the EventSource spec a non-200
   *  reconnect (the 401/404 a revoked principal now gets) FAILS the connection —
   *  CLOSED — whereas a network blip stays CONNECTING and self-heals. So `closed`
   *  is the reliable "access may have changed" signal; transient blips are not.
   *
   *  `onAccess` (#111 grant-side) fires on the server's NAMED `access` event — a
   *  principal-level "your grants changed, re-sync" nudge (a new space granted, a
   *  role changed, a non-active space revoked). It rides the same socket under a
   *  distinct SSE event name, so it never collides with the read-model frames.
   *
   *  `onMembers` (#121-follow-up) fires on the NAMED `members` event — a
   *  space-level "this space's membership changed" broadcast (someone added,
   *  removed, or re-roled). Any viewer of the space gets it, so an open members
   *  list can re-fetch live, not just the affected principal.
   *
   *  `onRename` (#100 phase 4 / #123) fires on the NAMED `rename` event — this space's
   *  slug changed. Every live viewer of the space gets it, so a second tab adopts the
   *  new slug live (re-fetch /api/spaces, canonicalise the URL, relabel the switcher)
   *  without a reload.
   *
   *  `onAgentSessions` fires on the owner-scoped `agent-sessions` event. It is a
   *  nudge only; the owner-gated session REST routes remain the source of truth.
   *  `onReady` fires only after the server acquired every authorised active and
   *  supplemental bus; unlike browser `open`, it is safe as a watch handoff barrier.
   *  `watchSpaces` multiplexes explicitly rendered cross-space context rows onto this
   *  same EventSource; the server re-checks read access for every requested slug. */
  events: (
    space: string,
    onEvent: (event: StoreEvent) => void,
    onError?: (closed: boolean) => void,
    onAccess?: () => void,
    onMembers?: () => void,
    onRename?: () => void,
    onAgentSessions?: () => void,
    onOpen?: (reconnected: boolean) => void,
    watchSpaces: readonly string[] = [],
    onContextEvent?: (event: StoreEvent, sourceSpace: string) => void,
    onReady?: (reconnected: boolean) => void,
  ): (() => void) => {
    const candidates = [
      ...new Set(watchSpaces.filter((candidate) => candidate && candidate !== space)),
    ]
      .sort()
      .slice(0, 250)
    let watch = ''

    for (const candidate of candidates) {
      const next = watch ? `${watch},${candidate}` : candidate

      if (encodeURIComponent(next).length > 4_096) {
        break
      }
      watch = next
    }
    const es = new EventSource(
      `${sp(space)}/events${watch ? `?watch=${encodeURIComponent(watch)}` : ''}`,
    )

    let opened = false
    let currentOpenIsReconnect = false

    es.onopen = () => {
      currentOpenIsReconnect = opened
      onOpen?.(currentOpenIsReconnect)
      opened = true
    }
    es.onmessage = (m) => {
      try {
        onEvent(JSON.parse(m.data as string) as StoreEvent)
      } catch {
        // a torn frame mid-reconnect is noise, not an error
      }
    }
    es.onerror = () => onError?.(es.readyState === EventSource.CLOSED)
    if (onAccess) {
      es.addEventListener(SSE_EVENT.ACCESS, () => onAccess())
    }
    if (onMembers) {
      es.addEventListener(SSE_EVENT.MEMBERS, () => onMembers())
    }
    if (onRename) {
      es.addEventListener(SSE_EVENT.RENAME, () => onRename())
    }
    if (onAgentSessions) {
      es.addEventListener(SSE_EVENT.AGENT_SESSIONS, () => onAgentSessions())
    }
    if (onContextEvent) {
      es.addEventListener(SSE_EVENT.CONTEXT_CHANGED, (event) => {
        try {
          const payload = JSON.parse((event as MessageEvent).data as string) as {
            sourceSpace: string
            event: StoreEvent
          }

          onContextEvent(payload.event, payload.sourceSpace)
        } catch {
          // A malformed supplemental frame is dropped like an ordinary data frame.
        }
      })
    }
    if (onReady) {
      es.addEventListener(SSE_EVENT.READY, () => onReady(currentOpenIsReconnect))
    }

    return () => es.close()
  },
}
