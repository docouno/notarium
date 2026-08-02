import { Navigate } from 'react-router'
import { AUTH_MODE } from '@notarium/contract/enums'
import { useAuth } from '../../composers/AuthProvider'
import { settingsRoute } from '../../libs/routing/routePaths'
import { api } from '../../services/api'
import { ConnectedApps, type ConnectedAppsSource } from '../../widgets/ConnectedApps'

// Connected apps section (#96): the user's OAuth connections (Claude/ChatGPT).
// The widget never imports services (boundaries) — this host hands it the api
// edge, the same source-port pattern Account uses.
const SOURCE: ConnectedAppsSource = {
  listConnections: api.connectionsGet,
  updateConnection: api.connectionUpdate,
  revokeConnection: api.connectionRevoke,
}

export const ConnectedAppsTab = () => {
  const { mode, me } = useAuth()
  const user = mode === AUTH_MODE.password ? me : null

  // OAuth connections only exist in password mode (a 'none' host has no users /
  // no facade) — bounce to the prefs tab. The narrowing picker (#181) needs `me`
  // (the owner's spaces), so pass it through.
  if (!user) {
    return <Navigate to={settingsRoute()} replace />
  }

  return <ConnectedApps me={user} source={SOURCE} />
}
