import { type FormEvent, useCallback, useEffect, useState } from 'react'
import type { InviteLink, User, UserCreateRequest, UserPatchRequest } from '@notarium/contract'
import { Button } from '../../core/Button'
import { ContextMenu, type MenuItem } from '../../core/ContextMenu'
import { useDialog } from '../../core/Dialog'
import { IconEdit, IconKey, IconMore, IconPlus, IconUser } from '../../core/Icons'
import { Notice } from '../../core/Notice'
import { SecretReveal } from '../../core/SecretReveal'
import { SettingsSection } from '../../core/SettingsSection'
import { Switch } from '../../core/Switch'
import { cx } from '../../libs/cx/cx'
import { type ErrorReasonMap, errorText } from '../../libs/errors'
import styles from './UsersAdmin.module.scss'

// The host-admin user management widget (#10), modal-hosted by the Sidebar's
// profile menu. No SMTP on a self-host MVP: creating/re-inviting answers with
// a one-time link the admin copies and hands over out-of-band.

export type UsersAdminSource = {
  list: () => Promise<User[]>
  create: (input: UserCreateRequest) => Promise<InviteLink>
  invite: (username: string) => Promise<InviteLink>
  patch: (username: string, patch: UserPatchRequest) => Promise<User>
}

type UsersAdminProps = {
  /** The acting admin — their own row's destructive actions read differently. */
  meUsername: string
  source: UsersAdminSource
}

// The wire's machine-readable causes, translated for humans; errorText handles
// the fallback (server message, or a generic line for anything illegible).
const REASON_TEXT: ErrorReasonMap = {
  last_admin: 'This is the last admin — promote someone else first.',
  self_lockout: 'You cannot disable your own account.',
  username_taken: 'This username is already taken.',
  email_taken: 'This email is already used by another account.',
}

const USERNAME_HINT = 'lowercase letters, digits, dots, underscores, dashes'

const friendly = (e: unknown): string => errorText(e, REASON_TEXT)

const CreateUserForm = ({
  source,
  onCreated,
}: {
  source: UsersAdminSource
  onCreated: (link: InviteLink) => void
}) => {
  const [username, setUsername] = useState('')
  const [email, setEmail] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [admin, setAdmin] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy || !username.trim()) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      onCreated(
        await source.create({
          username: username.trim(),
          email: email.trim() || undefined,
          displayName: displayName.trim() || undefined,
          admin: admin || undefined,
        }),
      )
      setUsername('')
      setEmail('')
      setDisplayName('')
      setAdmin(false)
    } catch (err) {
      setError(friendly(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      className={styles.createForm}
      data-testid="user-create-form"
      onSubmit={(e) => void onSubmit(e)}
    >
      <div className={styles.fieldRow}>
        <label className={styles.field}>
          <span>Username</span>
          <input
            data-testid="user-create-username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder={USERNAME_HINT}
            spellCheck={false}
            autoFocus
          />
        </label>
        <label className={styles.field}>
          <span>Display name (optional)</span>
          <input
            data-testid="user-create-display-name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            spellCheck={false}
          />
        </label>
        <label className={styles.field}>
          <span>Email (optional)</span>
          <input
            data-testid="user-create-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            spellCheck={false}
          />
        </label>
      </div>
      <Switch checked={admin} onChange={setAdmin} label="Admin" data-testid="user-create-admin" />
      {error && (
        <Notice variant="error" data-testid="user-create-error">
          {error}
        </Notice>
      )}
      <div className={styles.formActions}>
        <Button
          type="submit"
          variant="primary"
          data-testid="user-create"
          disabled={busy || !username.trim()}
        >
          {busy ? 'Creating…' : 'Create & get invite link'}
        </Button>
      </div>
    </form>
  )
}

// Editing a user is a new surface, not a widening of the row menu: the handle,
// the address and the display name are typed, not toggled. The route is addressed
// by the CURRENT handle; the answer carries the new one.
const EditUserForm = ({
  user,
  source,
  onSaved,
  onCancel,
}: {
  user: User
  source: UsersAdminSource
  onSaved: () => void
  onCancel: () => void
}) => {
  const [username, setUsername] = useState(user.username)
  const [email, setEmail] = useState(user.email ?? '')
  const [displayName, setDisplayName] = useState(user.displayName)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const nextUsername = username.trim()
  const nextEmail = email.trim()
  const nextDisplayName = displayName.trim()
  const changed =
    nextUsername !== user.username ||
    nextEmail !== (user.email ?? '') ||
    (nextDisplayName !== '' && nextDisplayName !== user.displayName)

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy || !changed || !nextUsername) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      await source.patch(user.username, {
        ...(nextUsername !== user.username ? { username: nextUsername } : {}),
        ...(nextEmail !== (user.email ?? '') ? { email: nextEmail || null } : {}),
        ...(nextDisplayName && nextDisplayName !== user.displayName
          ? { displayName: nextDisplayName }
          : {}),
      })
      onSaved()
    } catch (err) {
      setError(friendly(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      className={styles.createForm}
      data-testid="user-edit-form"
      onSubmit={(e) => void onSubmit(e)}
    >
      <div className={styles.fieldRow}>
        <label className={styles.field}>
          <span>Username</span>
          <input
            data-testid="user-edit-username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder={USERNAME_HINT}
            spellCheck={false}
            autoFocus
          />
        </label>
        <label className={styles.field}>
          <span>Display name</span>
          <input
            data-testid="user-edit-display-name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            spellCheck={false}
          />
        </label>
        <label className={styles.field}>
          <span>Email (optional)</span>
          <input
            data-testid="user-edit-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="not set"
            spellCheck={false}
          />
        </label>
      </div>
      {nextUsername !== user.username && (
        <Notice variant="info" data-testid="user-edit-rename-note">
          They sign in with the new username right away; the old one is free for anyone to take.
          Memberships, tokens and history stay with the account.
        </Notice>
      )}
      {error && (
        <Notice variant="error" data-testid="user-edit-error">
          {error}
        </Notice>
      )}
      <div className={styles.formActions}>
        <Button type="button" variant="ghost" data-testid="user-edit-cancel" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="submit"
          variant="primary"
          data-testid="user-edit-save"
          disabled={busy || !changed || !nextUsername}
        >
          {busy ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </form>
  )
}

export const UsersAdmin = ({ meUsername, source }: UsersAdminProps) => {
  const { confirm } = useDialog()
  const [users, setUsers] = useState<User[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<User | null>(null)
  // The freshly minted one-time link — single-use, so it shows until dismissed
  // or superseded by the next invite/create.
  const [link, setLink] = useState<{ username: string; url: string } | null>(null)
  // The per-row actions live in an overflow menu (one ⋮ per row) so the action
  // column is a fixed width — no jiggle as labels change length row to row.
  const [menu, setMenu] = useState<{ user: User; x: number; y: number } | null>(null)

  const load = useCallback(async () => {
    try {
      setUsers(await source.list())
      setError(null)
    } catch (e) {
      setError(friendly(e))
    }
  }, [source])

  useEffect(() => {
    void load()
  }, [load])

  const showLink = (invite: InviteLink) => {
    // The server hands the SPA path with the token in the fragment; this
    // client's origin completes it.
    setLink({ username: invite.user.username, url: `${window.location.origin}${invite.path}` })
  }

  const onCreated = (invite: InviteLink) => {
    setCreating(false)
    showLink(invite)
    void load()
  }

  const onInvite = async (user: User) => {
    try {
      showLink(await source.invite(user.username))
      setError(null)
    } catch (e) {
      setError(friendly(e))
    }
  }

  const onPatch = async (user: User, patch: UserPatchRequest) => {
    try {
      await source.patch(user.username, patch)
      setError(null)
      void load()
    } catch (e) {
      setError(friendly(e))
    }
  }

  const onToggleDisabled = async (user: User) => {
    if (!user.disabled) {
      const ok = await confirm({
        title: `Disable ${user.username}?`,
        message:
          'Their sessions end immediately and their tokens stop working. Memberships are kept — re-enabling restores access untouched.',
        confirmLabel: 'Disable',
        danger: true,
      })

      if (!ok) {
        return
      }
    }
    await onPatch(user, { disabled: !user.disabled })
  }

  // Both directions change host-wide power and are easy to misclick → confirm
  // each with what it does. Danger-styled so it reads as a weighty change.
  const onToggleAdmin = async (user: User) => {
    const ok = await confirm(
      user.admin
        ? {
            title: `Revoke admin from ${user.username}?`,
            message:
              'They lose host-wide management — users, members, spaces and minting invite/reset links. Their own memberships and data access are unchanged.',
            confirmLabel: 'Revoke admin',
            danger: true,
          }
        : {
            title: `Make ${user.username} an admin?`,
            message:
              'Admins manage every user, member and space on this host, and can mint invite/reset links for anyone. They still can’t read note content in spaces they aren’t a member of.',
            confirmLabel: 'Make admin',
            danger: true,
          },
    )

    if (!ok) {
      return
    }
    await onPatch(user, { admin: !user.admin })
  }

  const rowMenu = (user: User): MenuItem[] => [
    {
      label: 'Edit…',
      icon: <IconEdit size={14} />,
      onClick: () => {
        setCreating(false)
        setLink(null)
        setEditing(user)
      },
    },
    {
      label: user.hasPassword ? 'Reset link' : 'Invite link',
      icon: <IconKey size={14} />,
      onClick: () => void onInvite(user),
    },
    {
      label: user.admin ? 'Revoke admin' : 'Make admin',
      icon: <IconUser size={14} />,
      onClick: () => void onToggleAdmin(user),
    },
    { divider: true },
    {
      label: user.disabled ? 'Enable' : 'Disable',
      danger: !user.disabled,
      onClick: () => void onToggleDisabled(user),
    },
  ]

  return (
    <SettingsSection
      title="Users"
      testId="users-admin"
      action={
        !creating && (
          <Button
            data-testid="user-new"
            onClick={() => {
              setCreating(true)
              setLink(null)
            }}
          >
            <IconPlus size={14} /> New user
          </Button>
        )
      }
    >
      {creating && <CreateUserForm source={source} onCreated={onCreated} />}
      {editing && (
        <EditUserForm
          key={editing.username}
          user={editing}
          source={source}
          onSaved={() => {
            setEditing(null)
            setError(null)
            void load()
          }}
          onCancel={() => setEditing(null)}
        />
      )}

      {link && (
        <SecretReveal
          message={`One-time link for ${link.username} — hand it over yourself, it won’t be shown again.`}
          value={link.url}
          copyTitle="Copy link"
          testId="invite-link"
          valueTestId="invite-link-url"
          copyTestId="invite-link-copy"
        />
      )}

      {error && (
        <p className={styles.error} data-testid="users-error">
          {error}
        </p>
      )}

      {users && (
        <table className={styles.table} data-testid="users-list">
          <thead>
            <tr>
              <th>User</th>
              <th>Email</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr
                key={u.username}
                data-testid="user-row"
                className={cx(u.disabled && styles.rowDisabled)}
              >
                <td>
                  <div className={styles.cellName}>{u.displayName}</div>
                  <div className={styles.cellUsername}>
                    @{u.username}
                    {u.username === meUsername ? ' (you)' : ''}
                  </div>
                </td>
                <td className={cx(!u.email && styles.cellMuted)} data-testid="user-email">
                  {u.email ?? 'not set'}
                </td>
                <td>
                  {u.admin && <span className={cx(styles.badge, styles.badgeAccent)}>admin</span>}
                  {u.disabled && (
                    <span className={cx(styles.badge, styles.badgeDanger)}>disabled</span>
                  )}
                  {!u.hasPassword && !u.disabled && (
                    // No password yet = the invite hasn't been accepted.
                    <span className={styles.badge}>invited</span>
                  )}
                </td>
                <td className={styles.cellActions}>
                  <Button
                    icon
                    variant="ghost"
                    data-testid="user-actions"
                    title={`Actions for ${u.username}`}
                    onClick={(e) => {
                      const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                      setMenu({ user: u, x: r.right, y: r.bottom + 4 })
                    }}
                  >
                    <IconMore size={15} />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={rowMenu(menu.user)}
          onClose={() => setMenu(null)}
        />
      )}
    </SettingsSection>
  )
}
