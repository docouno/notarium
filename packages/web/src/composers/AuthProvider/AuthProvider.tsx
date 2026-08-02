import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react'
import type { AuthMode, AuthSession, Me, SpaceRole } from '@notarium/contract'
import { AUTH_MODE } from '@notarium/contract/enums'
import { withGrant } from '../../libs/access'
import { api, setUnauthorizedHandler } from '../../services/api'

// The auth layer's client half (#10): who the cookie says we are and how this
// host authenticates. It sits ABOVE the router and every data provider — the
// app tree only mounts once a session exists (or the host runs mode 'none'),
// so the rest of the boot order (#16 SpaceProvider etc.) keeps working
// unchanged. The render gating itself lives in App.tsx; this provider owns the
// facts and the transitions (refresh after login, logout, the mid-session 401).

export type AuthContextValue = {
  /** 'none' = the single-principal opt-out (no login UI at all). */
  mode: AuthMode
  /** The authenticated principal, with their space grants; null = anonymous. */
  me: Me | null
  /** First-run: the host has zero users and /api/auth/setup is still open. */
  setup: boolean
  /** Re-fetch the session facts (after login/setup/accept-invite — the cookie
   *  is already set, this just adopts what it says). */
  refresh: () => Promise<void>
  /** Reflect a just-acquired space grant in `me` locally, no round-trip — the
   *  creator of a space owns it by construction (#154). Idempotent; a no-op if
   *  `me` is null or the grant is already present. Deliberately NOT a refresh():
   *  a network blip on the session GET must not flip the app to the phantom
   *  mode-'none' principal mid-create. The server's `access` nudge reconciles the
   *  canonical list and the user's OTHER tabs (#155). */
  addLocalGrant: (slug: string, role: SpaceRole) => void
  /** Clear the cookie server-side and drop `me` — the gate falls back to the
   *  login screen and the whole app tree (with its state) unmounts. */
  logout: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export const useAuth = (): AuthContextValue => {
  const ctx = useContext(AuthContext)

  if (!ctx) {
    throw new Error('useAuth must be used within AuthProvider')
  }

  return ctx
}

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  // null = still booting; the provider renders nothing until the session facts
  // arrive (same contract as SpaceProvider's `ready`), so children never see a
  // half-known auth state.
  const [session, setSession] = useState<AuthSession | null>(null)

  const refresh = useCallback(async () => {
    try {
      setSession(await api.authSessionGet())
    } catch {
      // A THROWN error here is a transport failure (network blip, a 5xx from a
      // restarting/proxied server, a 404 on a host without the auth surface) — NOT a
      // logout: a real logout is a 200 with me:null, which doesn't throw. So keep a
      // live session as-is — a hiccup must not flip the app to the phantom mode-'none'
      // principal (me:null, all-access, no personal domain) and silently desync
      // identity. Only at BOOT (no session yet) fall back to 'none' so a host without
      // the auth surface (pre-#10 backend) still comes up. This guards every refresh
      // caller — boot, the 401 handler, the SSE access/rename nudges, post-create.
      setSession((prev) => prev ?? { mode: AUTH_MODE.none, setup: false, me: null })
    }
  }, [])

  const addLocalGrant = useCallback((slug: string, role: SpaceRole) => {
    setSession((s) => {
      if (!s?.me) {
        return s
      }
      const spaces = withGrant(s.me.spaces, slug, role)
      return spaces === s.me.spaces ? s : { ...s, me: { ...s.me, spaces } }
    })
  }, [])

  const logout = useCallback(async () => {
    try {
      await api.logout()
    } catch {
      // The cookie may already be dead — dropping `me` is the part that matters.
    }
    setSession((s) => (s ? { ...s, me: null } : s))
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // A mid-session 401 on any data route (expired cookie, user disabled) →
  // re-fetch the session: the server answers me:null and the gate lands on the
  // login screen. /api/auth/* is exempt inside the api layer, so a failed
  // login attempt never loops through here.
  useEffect(() => {
    setUnauthorizedHandler(() => void refresh())
    return () => setUnauthorizedHandler(null)
  }, [refresh])

  const value = useMemo<AuthContextValue>(
    () => ({
      mode: session?.mode ?? AUTH_MODE.none,
      me: session?.me ?? null,
      setup: session?.setup ?? false,
      refresh,
      addLocalGrant,
      logout,
    }),
    [session, refresh, addLocalGrant, logout],
  )

  if (!session) {
    return null
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
