import { AUTH_MODE } from '@notarium/contract/enums'
import { useAuth } from '../../composers/AuthProvider'
import { useSpace } from '../../composers/SpaceProvider'
import { SettingsLayout, type SettingsTab } from '../../layouts/SettingsLayout'
import { settingsRoute } from '../../libs/routing/routePaths'

// User settings (#28): personal, space-free. Appearance first; Account (password
// + tokens) and Users (admin) are their own tabs — both gated on a signed-in
// principal, so a mode-'none' host shows only Appearance.
export const SettingsPage = () => {
  const { mode, me } = useAuth()
  const { capabilities } = useSpace()
  const user = mode === AUTH_MODE.password ? me : null
  const groups: SettingsTab[][] = [
    [
      { id: 'appearance', label: 'Appearance' },
      // Keyboard shortcuts (#30) — personal, space-free; visible to everyone including
      // a mode-'none' host (the keymap is client-side).
      { id: 'keyboard', label: 'Keyboard' },
      ...(user
        ? [
            { id: 'profile', label: 'Profile' },
            { id: 'account', label: 'Account' },
            { id: 'connected-apps', label: 'Connected apps' },
          ]
        : []),
      ...(capabilities.providers
        ? [
            { id: 'credentials', label: 'Credentials' },
            { id: 'providers', label: 'Model providers' },
          ]
        : []),
      // About is general info — visible to everyone, including a mode-'none' host.
      { id: 'about', label: 'About' },
    ],
    ...(user?.admin ? [[{ id: 'users', label: 'Users' }]] : []),
  ]
  return (
    <SettingsLayout
      trail={[{ label: 'Settings' }]}
      spaceLess
      groups={groups}
      routeFor={settingsRoute}
    />
  )
}
