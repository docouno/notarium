import { type ReactNode } from 'react'
import { Navigate } from 'react-router'
import { settingsRoute, workspaceSettingsRoute } from '../../libs/routing/routePaths'
import { useSpace } from '../SpaceProvider'

/** Tabs alone are not a capability boundary: settings routes are registered
 *  statically, so a bookmarked direct URL must pass the same host-capability gate.
 *  The provider fact comes from /api/config through SpaceProvider, never auth/about. */
export const ProviderSurfaceGate = ({
  scope,
  children,
}: {
  scope: 'settings' | 'workspace'
  children: ReactNode
}) => {
  const { capabilities, space } = useSpace()

  if (!capabilities.providers) {
    return (
      <Navigate
        to={scope === 'settings' ? settingsRoute() : workspaceSettingsRoute(space)}
        replace
      />
    )
  }

  return children
}
