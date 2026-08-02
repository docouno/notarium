import { type ReactNode, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { ContextMenu, type MenuItem } from '../../core/ContextMenu'
import { useDialog } from '../../core/Dialog'
import { IconKey, IconLogout, IconUser } from '../../core/Icons'
import { cx } from '../../libs/cx/cx'
import { settingsRoute } from '../../libs/routing/routePaths'
import { SYNC_LABEL, SyncBadge, SyncDetails, syncStateOf } from '../../widgets/SyncIndicator'
import { useAuth } from '../AuthProvider'
import { useHotkeys } from '../HotkeysProvider'
import { useSync } from '../SyncProvider'
import styles from './Sidebar.module.scss'

// The avatar disc — a future profile image, the user glyph by default. Sized to
// sit in the chrome-band footer (--chrome-h) like the brand mark up top.
const Avatar = ({ glyph }: { glyph: ReactNode }) => <span className={styles.avatar}>{glyph}</span>

// Bottom-of-rail profile control (auth hosts only): the avatar opens a dropdown
// that LEADS with the sync block — status + Last check/change details (#112) —
// over a Profile shortcut and Sign out (with a confirm). The avatar reads as
// "you", so its menu goes to YOUR settings (the Profile tab) — distinct from the
// abstract Settings on the rail gear, which you might not know also holds your
// profile. The avatar also absorbs the sync indicator: its corner badge carries
// the staleness signal (the same cadence scale as #98) and the dropdown explains
// it. A no-auth host has no profile, so the footer shows the standalone SyncButton.
export const ProfileButton = () => {
  const { me, logout } = useAuth()
  const { status: syncStatus, changedLastMinute } = useSync()
  const { confirm } = useDialog()
  const { openCheatsheet } = useHotkeys()
  const navigate = useNavigate()
  const ref = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)

  // Gated to password mode by the footer, so `me` is present; guard defensively.
  if (!me) {
    return null
  }

  // The avatar absorbs the sync indicator (#112), so it must also absorb its
  // accessible signal — the standalone SyncButton (gone in auth mode) carried an
  // `aria-label`/`title` for sync, and the corner badge is aria-hidden. Without
  // this, a screen-reader/keyboard user in auth mode loses the sync/staleness
  // state entirely. Also surfaced as `data-state` for an auth-mode readiness gate
  // (mirrors the none-mode sync-indicator the visual suite polls).
  const syncState = syncStateOf(syncStatus)

  const onSignOut = async () => {
    if (
      await confirm({
        title: 'Sign out?',
        message: 'You’ll need to sign back in to reach your spaces.',
        confirmLabel: 'Sign out',
        danger: true,
      })
    ) {
      void logout()
    }
  }
  const items: MenuItem[] = [
    {
      label: 'Profile',
      icon: <IconUser size={14} />,
      onClick: () => navigate(settingsRoute('profile')),
    },
    { label: 'Keyboard shortcuts', icon: <IconKey size={14} />, onClick: openCheatsheet },
    { divider: true },
    { label: 'Sign out', icon: <IconLogout size={14} />, onClick: () => void onSignOut() },
  ]
  const rect = open && ref.current ? ref.current.getBoundingClientRect() : null
  return (
    <>
      <button
        ref={ref}
        // `menu-open` keeps the trigger highlighted while its dropdown is open.
        className={cx(styles.avatarBtn, open && styles.menuOpen)}
        title={me.displayName}
        aria-label={`${me.displayName} · Sync: ${SYNC_LABEL[syncState]}`}
        data-testid="profile-menu"
        data-state={syncState}
        onClick={() => setOpen((o) => !o)}
      >
        <Avatar glyph={<IconUser size={16} />} />
        <SyncBadge status={syncStatus} />
      </button>
      {rect && (
        // Bottom-docked trigger → open the menu *above* it (placement="up"),
        // left-aligned with the button. The sync block leads as the header.
        <ContextMenu
          x={rect.left}
          y={rect.top}
          placement="up"
          minWidth={240}
          ignoreRef={ref}
          header={<SyncDetails status={syncStatus} changed={changedLastMinute()} />}
          items={items}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}
