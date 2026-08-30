import { Navigate } from 'react-router'
import { useAuth } from '../../composers/AuthProvider'
import { ProviderAttachments } from '../../composers/ProviderManagement'
import { useSpace } from '../../composers/SpaceProvider'
import { canManageSpace } from '../../libs/access'
import { workspaceSettingsRoute } from '../../libs/routing/routePaths'

export const ProviderAttachmentsTab = () => {
  const { space, personalSpace } = useSpace()
  const { mode, me } = useAuth()

  if (personalSpace?.slug === space) {
    return <Navigate to={workspaceSettingsRoute(space, 'projects')} replace />
  }
  if (!canManageSpace(me, mode, space)) {
    return <Navigate to={workspaceSettingsRoute(space, 'members')} replace />
  }

  return <ProviderAttachments />
}
