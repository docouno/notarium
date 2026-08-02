import { useCallback, useEffect, useState } from 'react'
import type { Connection, ConnectionPatchRequest, Me, PatScope } from '@notarium/contract'
import { PAT_SCOPE } from '@notarium/contract/enums'
import { Button } from '../../core/Button'
import { useDialog } from '../../core/Dialog'
import { EmptyState } from '../../core/EmptyState'
import { IconEdit, IconLink, IconTrash } from '../../core/Icons'
import { Segmented } from '../../core/Segmented'
import { SettingsSection } from '../../core/SettingsSection'
import { cx } from '../../libs/cx/cx'
import { exactDateTime, timeAgo } from '../../libs/datetime'
import { errorText } from '../../libs/errors'
import { sameSpaceSet, SpacesPicker } from '../SpacesPicker'
import styles from './ConnectedApps.module.scss'

// The connected-apps widget (#96): the user's OAuth connections (Claude/ChatGPT
// added Notarium as a custom MCP connector). One row per app, revocable. There is
// no "create" — a connection is born from the OAuth consent flow. The access level
// (#162) AND the per-space narrowing (#181) are editable — read↔write and which
// spaces, no re-consent — through a form, mirroring the API-tokens edit. Props-driven,
// transport via the host-wired source port.

export type ConnectedAppsSource = {
  listConnections: () => Promise<Connection[]>
  updateConnection: (id: string, input: ConnectionPatchRequest) => Promise<unknown>
  revokeConnection: (id: string) => Promise<unknown>
}

const ConnectionEditForm = ({
  me,
  conn,
  source,
  onSaved,
  onCancel,
}: {
  me: Me
  conn: Connection
  source: ConnectedAppsSource
  onSaved: () => void
  onCancel: () => void
}) => {
  // The narrowing the form can REPRESENT: the connection's spaces minus any the
  // owner can no longer see (archived #110 / lost membership) — those have no
  // checkbox, so the form can't round-trip them. This is the dirty baseline AND the
  // seed; the spaces axis counts as changed only when the user edits it away from
  // this, and the patch OMITS spaces when untouched — so a scope-only edit never
  // silently drops a space the form couldn't display. FROZEN at mount (useState init)
  // so a mid-edit `me` change (an SSE access nudge) can't shift the baseline. Mirrors
  // TokenEditForm (#162).
  const [seededSpaces] = useState<string[] | null>(() =>
    conn.spaces == null ? null : conn.spaces.filter((s) => me.spaces.some((ms) => ms.slug === s)),
  )
  const [scope, setScope] = useState<PatScope>(conn.scope)
  const [allSpaces, setAllSpaces] = useState(seededSpaces == null)
  const [picked, setPicked] = useState<Set<string>>(() => new Set(seededSpaces ?? []))
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const toggleSpace = (slug: string) => {
    setPicked((prev) => {
      const nextSet = new Set(prev)

      if (nextSet.has(slug)) {
        nextSet.delete(slug)
      } else {
        nextSet.add(slug)
      }

      return nextSet
    })
  }

  // Disable Save until something actually changed (#162/#181).
  const draftSpaces = allSpaces ? null : [...picked]
  const spacesChanged = !sameSpaceSet(draftSpaces, seededSpaces)
  const dirty = scope !== conn.scope || spacesChanged

  const onSubmit = async () => {
    if (busy) {
      return
    }
    // Only validate / send the narrowing when the user actually edited it.
    if (spacesChanged && !allSpaces && picked.size === 0) {
      setError('Pick at least one space, or allow all.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await source.updateConnection(conn.id, {
        scope,
        ...(spacesChanged ? { spaces: draftSpaces } : {}),
      })
      onSaved()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={styles.editForm} data-testid="conn-edit-form">
      <div className={styles.formHeader}>Edit “{conn.appName || 'Unknown app'}”</div>
      <div className={styles.grid}>
        <label className={styles.field}>
          <span>Name</span>
          {/* The app name comes from the OAuth client (shared, CIMD-refreshed) — shown
              for identity, not editable here (renaming it would leak across users). */}
          <input value={conn.appName || 'Unknown app'} disabled data-testid="conn-edit-name" />
        </label>
        <div className={cx(styles.field, styles.fieldControl)}>
          <span>Access</span>
          <Segmented<PatScope>
            value={scope}
            onChange={setScope}
            ariaLabel="App access level"
            options={[
              { value: PAT_SCOPE.read, label: 'Read' },
              { value: PAT_SCOPE.write, label: 'Write' },
            ]}
          />
        </div>
      </div>
      <SpacesPicker
        me={me}
        allSpaces={allSpaces}
        onAllSpaces={setAllSpaces}
        picked={picked}
        onToggle={toggleSpace}
        switchTestId="conn-all-spaces"
      />
      {error && <p className={styles.error}>{error}</p>}
      <div className={styles.formActions}>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button
          type="button"
          variant="primary"
          data-testid="conn-scope-save"
          disabled={busy || !dirty}
          onClick={() => void onSubmit()}
        >
          {busy ? 'Saving…' : 'Save changes'}
        </Button>
      </div>
    </div>
  )
}

export const ConnectedApps = ({ me, source }: { me: Me; source: ConnectedAppsSource }) => {
  const { confirm } = useDialog()
  const [conns, setConns] = useState<Connection[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  // The connection being edited (#162/#181) — through a form above the table.
  const [editing, setEditing] = useState<Connection | null>(null)

  const load = useCallback(async () => {
    try {
      setConns(await source.listConnections())
      setError(null)
    } catch (e) {
      setError(errorText(e))
    }
  }, [source])

  useEffect(() => {
    void load()
  }, [load])

  const onEdited = () => {
    setEditing(null)
    void load()
  }

  const onRevoke = async (c: Connection) => {
    const name = c.appName || 'This app'
    const ok = await confirm({
      title: 'Disconnect app?',
      message: `${name} will lose access immediately and must reconnect to use Notarium again. This cannot be undone.`,
      confirmLabel: 'Disconnect',
      danger: true,
    })

    if (!ok) {
      return
    }
    try {
      await source.revokeConnection(c.id)
      // Close the edit form if it was bound to the app just disconnected — a stale
      // Save would PATCH a dead client id and 404.
      if (editing?.id === c.id) {
        setEditing(null)
      }
      void load()
    } catch (e) {
      setError(errorText(e))
    }
  }

  return (
    <SettingsSection
      title="Connected apps"
      description="Apps you’ve connected over OAuth (like Claude or ChatGPT) can use the MCP API as you, within the access you granted — never to manage users, members or tokens. Change an app’s access level or the spaces it can reach, or disconnect any you no longer use."
    >
      {error && <p className={styles.error}>{error}</p>}

      {editing && (
        // key by client id: switching the edited row while the form is open must
        // remount it so the seeded scope + spaces re-initialise for the new app.
        <ConnectionEditForm
          key={editing.id}
          me={me}
          conn={editing}
          source={source}
          onSaved={onEdited}
          onCancel={() => setEditing(null)}
        />
      )}

      {conns && conns.length === 0 && (
        <EmptyState
          icon={<IconLink size={22} />}
          title="No connected apps"
          hint="Add Notarium as a custom connector in Claude or ChatGPT to connect an app."
          testId="conn-empty"
        />
      )}
      {conns && conns.length > 0 && (
        <table className={styles.table} data-testid="conn-list">
          <thead>
            <tr>
              <th>App</th>
              <th>Access</th>
              <th>Spaces</th>
              <th>Connected</th>
              <th>Last used</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {conns.map((c) => (
              <tr key={c.id} data-testid="conn-row">
                <td className={styles.cellName}>{c.appName || 'Unknown app'}</td>
                <td>
                  <span
                    className={cx(styles.badge, c.scope === PAT_SCOPE.write && styles.badgeAccent)}
                  >
                    {c.scope}
                  </span>
                </td>
                {/* null = all grants; [] = narrowed to spaces the registry no longer lists
                    (fail-closed, reaches none) — distinct from a rendering gap. */}
                <td data-testid="conn-spaces">
                  {c.spaces == null ? 'all' : c.spaces.length ? c.spaces.join(', ') : 'none'}
                </td>
                <td title={exactDateTime(c.createdAt)}>{timeAgo(c.createdAt)}</td>
                <td title={c.lastUsedAt ? exactDateTime(c.lastUsedAt) : undefined}>
                  {c.lastUsedAt ? timeAgo(c.lastUsedAt) : '—'}
                </td>
                <td className={styles.cellActions}>
                  <Button
                    icon
                    variant="ghost"
                    title="Change access"
                    data-testid="conn-edit"
                    onClick={() => setEditing(c)}
                  >
                    <IconEdit size={14} />
                  </Button>
                  <Button
                    icon
                    variant="ghost"
                    title="Disconnect app"
                    data-testid="conn-revoke"
                    onClick={() => void onRevoke(c)}
                  >
                    <IconTrash size={14} />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </SettingsSection>
  )
}
