import { Navigate } from 'react-router'
import { AUTH_MODE } from '@notarium/contract/enums'
import { useAuth } from '../../composers/AuthProvider'
import { settingsRoute } from '../../libs/routing/routePaths'
import { api } from '../../services/api'
import { UsersAdmin, type UsersAdminSource } from '../../widgets/UsersAdmin'

// Users section (#28): host-admin user management, moved off its modal into a
// settings tab (its own group in the nav). Admin-only — a non-admin who deep-
// links here bounces back to the prefs tab.
const SOURCE: UsersAdminSource = {
  list: api.usersGet,
  create: api.userCreate,
  invite: api.userInvite,
  patch: api.userPatch,
}

export const UsersTab = () => {
  const { mode, me } = useAuth()
  const user = mode === AUTH_MODE.password ? me : null

  if (!user?.admin) {
    return <Navigate to={settingsRoute()} replace />
  }

  return <UsersAdmin meUsername={user.username} source={SOURCE} />
}
