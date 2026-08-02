import { type FormEvent, useEffect, useRef, useState } from 'react'
import type { Member, SpaceRole } from '@notarium/contract'
import { SPACE_ROLE } from '@notarium/contract/enums'
import { Button } from '../../core/Button'
import { ContextMenu, type MenuItem } from '../../core/ContextMenu'
import { useDialog } from '../../core/Dialog'
import { IconMore, IconTrash } from '../../core/Icons'
import { Notice } from '../../core/Notice'
import { Select } from '../../core/Select'
import { cx } from '../../libs/cx/cx'
import { type ErrorReasonMap, errorText } from '../../libs/errors'
import styles from './SpaceMembers.module.scss'

// The space membership widget (#10), a workspace-settings tab. Any member sees
// the list (collaboration transparency); managing rows takes the space's owner
// role or host admin — the host decides and passes `canManage`. Mutations answer
// with the fresh member list, so the widget swaps state from the response instead
// of re-fetching. Per-row role changes + remove live in a ⋮ menu (same pattern as
// the Users table); promoting to owner — which hands over member management — is
// routed through a confirm so it can't happen on a careless click.

export type SpaceMembersSource = {
  list: () => Promise<Member[]>
  put: (username: string, role: SpaceRole) => Promise<Member[]>
  remove: (username: string) => Promise<Member[]>
}

type SpaceMembersProps = {
  /** The active space's display name — this widget is always about ONE space. */
  spaceName: string
  canManage: boolean
  source: SpaceMembersSource
  /** Re-list when this changes (besides `source`). The host passes a counter that
   *  bumps on every membership change in the space (the server's `members` SSE
   *  broadcast, #121-follow-up), so an open list re-fetches live for ANY viewer —
   *  add/remove/role of anyone — not just the viewer's own grant. */
  reloadKey?: number
}

const ROLES: SpaceRole[] = [SPACE_ROLE.owner, SPACE_ROLE.writer, SPACE_ROLE.reader]
const ROLE_LABEL: Record<SpaceRole, string> = {
  owner: 'Owner',
  writer: 'Writer',
  reader: 'Reader',
}

const REASON_TEXT: ErrorReasonMap = {
  last_owner: 'A space needs at least one owner — promote someone else first.',
  no_such_user: 'No user with that username.',
}

const friendly = (e: unknown): string => errorText(e, REASON_TEXT)

export const SpaceMembers = ({ spaceName, canManage, source, reloadKey }: SpaceMembersProps) => {
  const { confirm } = useDialog()
  const [members, setMembers] = useState<Member[] | null>(null)
  // Two error surfaces: `error` covers loading the list and the row actions and
  // shows at the top, visible to every member (a reader can view the list, so a
  // load failure must not be silent); `addError` belongs to the add-member form
  // and shows by its input.
  const [error, setError] = useState<string | null>(null)
  const [addError, setAddError] = useState<string | null>(null)
  const [addName, setAddName] = useState('')
  const [addRole, setAddRole] = useState<SpaceRole>(SPACE_ROLE.writer)
  const [busy, setBusy] = useState(false)
  // Per-row actions live in an overflow menu (one ⋮ per row), so the row layout
  // stays fixed no matter the role label's length.
  const [menu, setMenu] = useState<{ member: Member; x: number; y: number } | null>(null)

  // Order responses by a monotonic id so a superseded fetch can't paint over a
  // newer one — a fast burst of membership events (or a space switch changing
  // `source`) leaves several list() calls in flight; only the latest wins.
  const seq = useRef(0)
  useEffect(() => {
    const my = ++seq.current
    source
      .list()
      .then((m) => {
        if (my === seq.current) {
          setMembers(m)
        }
      })
      .catch((e: unknown) => {
        if (my === seq.current) {
          setError(friendly(e))
        }
      })
    // `reloadKey` rides the deps deliberately (it isn't read in the body): a
    // membership change in this space re-lists so badges match the live chrome.
    // The old list stays visible until the new one resolves (no flash).
  }, [source, reloadKey])

  const onRole = async (member: Member, role: SpaceRole) => {
    if (role === member.role) {
      return
    }
    // Owner is the powerful role (manage members, change roles, remove people),
    // so granting it asks first — everything else applies straight away.
    if (role === SPACE_ROLE.owner) {
      const ok = await confirm({
        title: `Make ${member.displayName} an owner?`,
        message: `Owners can add and remove members of “${spaceName}”, change their roles, and manage the workspace. This is the space's highest level of access.`,
        confirmLabel: 'Make owner',
        danger: true,
      })

      if (!ok) {
        return
      }
    }
    try {
      setMembers(await source.put(member.username, role))
      setError(null)
    } catch (e) {
      setError(friendly(e))
    }
  }

  const onRemove = async (member: Member) => {
    const ok = await confirm({
      title: `Remove ${member.displayName}?`,
      message: `They lose access to “${spaceName}” immediately (open tabs included).`,
      confirmLabel: 'Remove',
      danger: true,
    })

    if (!ok) {
      return
    }
    try {
      setMembers(await source.remove(member.username))
      setError(null)
    } catch (e) {
      setError(friendly(e))
    }
  }

  const onAdd = async (e: FormEvent) => {
    e.preventDefault()
    if (busy || !addName.trim()) {
      return
    }
    setBusy(true)
    try {
      setMembers(await source.put(addName.trim(), addRole))
      setAddError(null)
      setAddName('')
    } catch (err) {
      setAddError(friendly(err))
    } finally {
      setBusy(false)
    }
  }

  const rowMenu = (member: Member): MenuItem[] => [
    ...ROLES.map((r) => ({
      label: ROLE_LABEL[r],
      active: r === member.role,
      onClick: () => void onRole(member, r),
    })),
    { divider: true },
    {
      label: 'Remove',
      icon: <IconTrash size={14} />,
      danger: true,
      onClick: () => void onRemove(member),
    },
  ]

  return (
    <div className={styles.members} data-testid="space-members">
      <div className={styles.head}>
        <h2>Members of {spaceName}</h2>
      </div>

      {error && (
        <Notice variant="error" data-testid="members-error">
          {error}
        </Notice>
      )}

      {members && (
        <ul className={styles.list} data-testid="members-list">
          {members.map((m) => (
            <li key={m.username} className={styles.row} data-testid="member-row">
              <div className={styles.who}>
                <span className={styles.name}>{m.displayName}</span>
                <span className={styles.username}>@{m.username}</span>
              </div>
              <span
                className={cx(
                  styles.roleBadge,
                  m.role === SPACE_ROLE.owner && styles.roleBadgeOwner,
                )}
                data-testid="member-role"
              >
                {ROLE_LABEL[m.role]}
              </span>
              {canManage && (
                <Button
                  icon
                  variant="ghost"
                  data-testid="member-actions"
                  title={`Actions for ${m.username}`}
                  onClick={(e) => {
                    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                    setMenu({ member: m, x: r.right, y: r.bottom + 4 })
                  }}
                >
                  <IconMore size={15} />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {canManage && (
        <form
          className={styles.addForm}
          data-testid="member-add-form"
          onSubmit={(e) => void onAdd(e)}
        >
          {addError && (
            <Notice variant="error" data-testid="member-add-error">
              {addError}
            </Notice>
          )}
          <div className={styles.addRow}>
            <input
              data-testid="member-add-username"
              value={addName}
              onChange={(e) => setAddName(e.target.value)}
              placeholder="username"
              spellCheck={false}
            />
            <Select<SpaceRole>
              value={addRole}
              onChange={setAddRole}
              aria-label="Role for new member"
              data-testid="member-add-role"
              options={ROLES.map((r) => ({ value: r, label: ROLE_LABEL[r] }))}
            />
            <Button type="submit" data-testid="member-add" disabled={busy || !addName.trim()}>
              Add member
            </Button>
          </div>
        </form>
      )}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={rowMenu(menu.member)}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  )
}
