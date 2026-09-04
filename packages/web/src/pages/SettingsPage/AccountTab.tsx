import { useMemo } from 'react'
import { Navigate } from 'react-router'
import { AUTH_MODE } from '@notarium/contract/enums'
import { useAuth } from '../../composers/AuthProvider'
import { settingsRoute } from '../../libs/routing/routePaths'
import { api } from '../../services/api'
import { AccountSettings, type AccountSettingsSource } from '../../widgets/AccountSettings'

// Account section (#28): identity, password and personal access tokens, moved off
// its modal into a settings tab. The widget never imports services (boundaries) —
// this host hands it the api edge, the same source-port pattern the modal used.
export const AccountTab = () => {
  const { mode, me, refresh } = useAuth()
  const user = mode === AUTH_MODE.password ? me : null
  const source = useMemo<AccountSettingsSource>(
    () => ({
      // The answer already carries the new handle; the refresh makes every consumer
      // of `me` (chrome, member lists keyed by it) see it without waiting for SSE.
      updateIdentity: async (patch) => {
        const next = await api.mePatch(patch)
        await refresh()
        return next
      },
      changePassword: api.passwordChange,
      listTokens: api.patsGet,
      createToken: api.patCreate,
      editToken: api.patPatch,
      revokeToken: api.patRevoke,
    }),
    [refresh],
  )

  // No account without a signed-in user (mode 'none') — bounce to the prefs tab.
  if (!user) {
    return <Navigate to={settingsRoute()} replace />
  }

  return <AccountSettings me={user} source={source} />
}
