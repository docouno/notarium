import { useAuth } from '../../composers/AuthProvider'
import { useSpace } from '../../composers/SpaceProvider'
import { SettingsLayout, type SettingsTab } from '../../layouts/SettingsLayout'
import { canManageSpace } from '../../libs/access'
import { workspaceSettingsRoute } from '../../libs/routing/routePaths'

// Workspace (per-space) settings (#28): scoped to the active space, its own page
// (not a modal) so it scales as space settings grow. Members today; General /
// access / integrations land here as their own tabs. Shares the settings chrome
// with the user settings page; the active space leads the breadcrumb (added by
// Breadcrumbs), so this only supplies its own "Management" tail.
export const WorkspaceSettingsPage = () => {
  const { space, personalSpace, canWrite, capabilities } = useSpace()
  const { mode, me } = useAuth()
  // The personal domain (#13) is a manageable space — it holds projects — but it
  // can never gain members (a second principal would see the owner's private
  // about-user memory), so the Members tab is omitted there. The backend refuses
  // the invite regardless (authApi members PUT); this just hides the dead surface.
  const onPersonal = personalSpace?.slug === space
  // General (#100 phase 4 / #123): the space's own identity (rename). An owner-need act,
  // and only where the host actually keeps a space registry to rename in (spaceCreate
  // ⇒ a notarium engine + meta-DB host; an operator-static host has neither, so the
  // PATCH 404s — hide rather than offer a dead form). Excluded on the personal domain (its
  // handle/name are internal). A writer/reader never sees it.
  const canManage = canManageSpace(me, mode, space) && capabilities.spaceCreate
  const groups: SettingsTab[][] = [
    onPersonal
      ? [{ id: 'projects', label: 'Projects' }]
      : [
          ...(canManage ? [{ id: 'general', label: 'General' }] : []),
          { id: 'members', label: 'Members' },
          { id: 'projects', label: 'Projects' },
        ],
    // Export (#17) / Import (#11) are per-space data actions, not management —
    // their own group so a divider separates moving notes in/out from the
    // membership/project rows. Import is a write (#11), so a reader (#111) only
    // gets Export — they can read the space, hence take a copy out, but not in.
    canWrite
      ? [
          { id: 'import', label: 'Import' },
          { id: 'export', label: 'Export' },
        ]
      : [{ id: 'export', label: 'Export' }],
  ]
  return (
    <SettingsLayout
      trail={[{ label: 'Management' }]}
      groups={groups}
      routeFor={(tab) => workspaceSettingsRoute(space, tab)}
    />
  )
}
