import { useMemo } from 'react'
import { Navigate } from 'react-router'
import type { SpaceRole } from '@notarium/contract'
import { AUTH_MODE, SPACE_ROLE } from '@notarium/contract/enums'
import { useAuth } from '../../composers/AuthProvider'
import { useSpace } from '../../composers/SpaceProvider'
import { useSync } from '../../composers/SyncProvider'
import { spaceRoute, workspaceSettingsRoute } from '../../libs/routing/routePaths'
import { api } from '../../services/api'
import { SpaceMembers, type SpaceMembersSource } from '../../widgets/SpaceMembers'

// Members section (#10, #28): the per-space member list + role management, moved
// off its modal into the workspace settings page. Members is an auth concept —
// without a signed-in user (mode 'none') there's nothing here, so bounce home.
// The widget never imports services; this host binds the api edge to the ACTIVE
// space, and re-derives the source if the space switches under it.
export const MembersTab = () => {
  const { space, spaces, personalSpace } = useSpace()
  const { mode, me } = useAuth()
  const { membersRev } = useSync()
  const user = mode === AUTH_MODE.password ? me : null
  const active = spaces.find((s) => s.slug === space)
  const source = useMemo<SpaceMembersSource>(
    () => ({
      list: () => api.membersGet(space),
      put: (username: string, role: SpaceRole) => api.memberPut(space, username, role),
      remove: (username: string) => api.memberRemove(space, username),
    }),
    [space],
  )

  // The personal domain (#13) has no members surface (inviting is refused — a
  // second principal would see private about-user memory). It IS manageable
  // though, so send a stray /management or /management/members there to Projects
  // rather than bouncing home.
  if (personalSpace?.slug === space) {
    return <Navigate to={workspaceSettingsRoute(space, 'projects')} replace />
  }
  if (!user || !active) {
    return <Navigate to={spaceRoute(space)} replace />
  }
  const myRole = user.spaces.find((s) => s.slug === space)?.role
  const canManage = user.admin || myRole === SPACE_ROLE.owner
  // Re-fetch the list on every membership change in this space (#121-follow-up):
  // the server's `members` broadcast reaches every viewer — including the subject
  // of a role change — so `membersRev` alone covers add/remove/role for any
  // viewer. The chrome/gating react separately via `me` (the addressed `access`
  // refresh), so the list badges and the affordances stay in sync.
  return (
    <SpaceMembers
      spaceName={active.displayName}
      canManage={canManage}
      source={source}
      reloadKey={membersRev}
    />
  )
}
