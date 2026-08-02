import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { classifyAccess, fallbackSpace } from '../../libs/access'
import { api, setSpaceAccessProbe } from '../../services/api'
import { useAuth } from '../AuthProvider'
import { useSpace } from '../SpaceProvider'
import { SpaceLostScreen } from './SpaceLostScreen'

// Runtime access-loss detector (#111). The pain it removes: when a principal's
// membership is revoked (or the space is archived/deleted, or they're disabled)
// WHILE working, the SSE socket is torn and the data routes start 401/404-ing —
// to the user, "everything silently stopped loading". This turns that silent
// breakage into an explicit, distinguishable state.
//
// Two halves (the style of the fix is structural, not another banner):
//   • TRIGGERS — a dead SSE stream (SyncProvider reports it) and a 403/404 on the
//     active space's scoped routes (the api-layer probe). Both are only hints.
//   • AUTHORITY — one `authSessionGet`: the server recomputes the live grants on
//     every request, so the freshly-fetched session is the truth. We never guess
//     from a status code (anti-enumeration #16 makes 404s ambiguous by design).
//
// Verdicts:
//   • session-lost (me === null: expired cookie / disabled account) → adopt the
//     session via AuthProvider.refresh; the existing AuthGate lands on login.
//   • space-lost (still signed in, active space not in grants) → take the app
//     over (the gate unmounts the data subtree, so the dead space's content is
//     gone from RAM/DOM — immediate revoke honoured, #111 security) and offer a
//     switch to a space that still works.
//   • ok → a transient blip (engine restart, network). Nothing unmounts; the
//     stream reconnects and the user never notices. Confirmed-only takeover is
//     what keeps a false alarm from nuking in-flight work.

type SpaceAccess =
  | { kind: 'ok' }
  /** Active space is gone; `target` is where to switch (null = nothing left). */
  | { kind: 'space-lost'; target: string | null }

type SpaceAccessContextValue = {
  /** Re-check the live grants for the active space and route to the verdict.
   *  Idempotent and single-flight; safe to call on every trigger. */
  verify: () => void
}

const SpaceAccessContext = createContext<SpaceAccessContextValue | null>(null)

export const useSpaceAccess = (): SpaceAccessContextValue => {
  const ctx = useContext(SpaceAccessContext)

  if (!ctx) {
    throw new Error('useSpaceAccess must be used within SpaceAccessProvider')
  }

  return ctx
}

export const SpaceAccessProvider = ({ children }: { children: ReactNode }) => {
  const { refresh } = useAuth()
  const { space, reloadSpaces } = useSpace()
  const spaceRef = useRef(space)
  spaceRef.current = space

  const [access, setAccess] = useState<SpaceAccess>({ kind: 'ok' })
  const verifyingRef = useRef(false)

  const verify = useCallback(() => {
    if (verifyingRef.current) {
      return
    }
    verifyingRef.current = true
    void (async () => {
      try {
        // The boot endpoint is public (never 401s itself) and cheap. A network
        // failure here is NOT loss — bail and leave the app running; a real
        // revoke answers definitively.
        let session

        try {
          session = await api.authSessionGet()
        } catch {
          return
        }
        const active = spaceRef.current
        const verdict = classifyAccess(session, active)

        if (verdict.kind === 'session-lost') {
          // AuthProvider adopts me:null → AuthGate swaps in the login screen and
          // the whole app tree (this provider included) unmounts.
          await refresh()
          return
        }
        if (verdict.kind === 'ok') {
          setAccess({ kind: 'ok' })
          return
        }
        // Confirmed space-lost (classifyAccess only returns this with a principal).
        // Refresh the chrome's space list so the dead space de-lists from the
        // switcher, adopt the fresh grants, then take over.
        const me = session.me

        if (!me) {
          return
        }
        reloadSpaces()
        void refresh()
        setAccess({ kind: 'space-lost', target: fallbackSpace(me, active) })
      } finally {
        verifyingRef.current = false
      }
    })()
  }, [refresh, reloadSpaces])

  // The api layer reports a 403/404 on ANY space-scoped route; only the ACTIVE
  // space's loss is a takeover (a foreign/missing note 404 must stay a per-note
  // not-found). verify() re-checks the grants, so a real note-404 resolves to ok.
  useEffect(() => {
    setSpaceAccessProbe((slug) => {
      if (slug === spaceRef.current) {
        verify()
      }
    })
    return () => setSpaceAccessProbe(null)
  }, [verify])

  // A space switch (incl. the takeover's own "switch") is a fresh footing: assume
  // access until proven otherwise, so the gate shows the app again.
  useEffect(() => {
    setAccess({ kind: 'ok' })
  }, [space])

  const value = useMemo<SpaceAccessContextValue>(() => ({ verify }), [verify])

  return (
    <SpaceAccessContext.Provider value={value}>
      {access.kind === 'space-lost' ? <SpaceLostScreen target={access.target} /> : children}
    </SpaceAccessContext.Provider>
  )
}
