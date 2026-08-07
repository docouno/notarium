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
   *  without a reload. */
  events: (
    space: string,
    onEvent: (event: StoreEvent) => void,
    onError?: (closed: boolean) => void,
    onAccess?: () => void,
    onMembers?: () => void,
    onRename?: () => void,
    onOpen?: () => void,
  ): (() => void) => {
    const es = new EventSource(`${sp(space)}/events`)

    es.onopen = () => onOpen?.()
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

    return () => es.close()
  },
}
