import { useCallback, useEffect, useState } from 'react'
import type { Me, Pat, PatCreateResponse } from '@notarium/contract'
import { PAT_SCOPE } from '@notarium/contract/enums'
import { Button } from '../../core/Button'
import { useDialog } from '../../core/Dialog'
import { EmptyState } from '../../core/EmptyState'
import { IconEdit, IconKey, IconTrash } from '../../core/Icons'
import { SecretReveal } from '../../core/SecretReveal'
import { SettingsSection } from '../../core/SettingsSection'
import { cx } from '../../libs/cx/cx'
import { absoluteDate, exactDateTime, timeAgo } from '../../libs/datetime'
import { errorText } from '../../libs/errors'
import { TokenCreateForm } from './TokenCreateForm'
import { TokenEditForm } from './TokenEditForm'
import type { AccountSettingsSource } from './types'
import styles from './AccountSettings.module.scss'

const TokensSection = ({ me, source }: { me: Me; source: AccountSettingsSource }) => {
  const { confirm } = useDialog()
  const [tokens, setTokens] = useState<Pat[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  // The token currently being re-scoped (#162) — mutually exclusive with creating.
  const [editing, setEditing] = useState<Pat | null>(null)
  // The one-time secret of the token just created — gone forever on dismiss.
  const [fresh, setFresh] = useState<PatCreateResponse | null>(null)

  const load = useCallback(async () => {
    try {
      setTokens(await source.listTokens())
      setError(null)
    } catch (e) {
      setError(errorText(e))
    }
  }, [source])

  useEffect(() => {
    void load()
  }, [load])

  const onCreated = (result: PatCreateResponse) => {
    setCreating(false)
    setFresh(result)
    void load()
  }

  const onEdited = () => {
    setEditing(null)
    void load()
  }

  const onRevoke = async (pat: Pat) => {
    const ok = await confirm({
      title: 'Revoke token?',
      message: `“${pat.name}” will stop working immediately. This cannot be undone.`,
      confirmLabel: 'Revoke',
      danger: true,
    })

    if (!ok) {
      return
    }
    try {
      await source.revokeToken(pat.id)
      if (fresh?.pat.id === pat.id) {
        setFresh(null)
      }
      // Close the edit form if it was bound to the token just revoked — otherwise a
      // stale Save would PATCH a dead id and 404.
      if (editing?.id === pat.id) {
        setEditing(null)
      }
      void load()
    } catch (e) {
      setError(errorText(e))
    }
  }

  return (
    <SettingsSection
      title="API tokens"
      description="Personal access tokens let agents and scripts use the API as you. A token can never manage users, members or other tokens."
      action={
        !creating && (
          <Button
            data-testid="pat-new"
            onClick={() => {
              setCreating(true)
              setEditing(null)
              setFresh(null)
            }}
          >
            <IconKey size={14} /> New token
          </Button>
        )
      }
    >
      {fresh && (
        <SecretReveal
          message="Copy this token now — it won’t be shown again."
          value={fresh.token}
          copyTitle="Copy token"
          testId="pat-fresh"
          valueTestId="pat-fresh-token"
          copyTestId="pat-fresh-copy"
        />
      )}

      {creating && (
        <TokenCreateForm
          me={me}
          source={source}
          onCreated={onCreated}
          onCancel={() => setCreating(false)}
        />
      )}

      {editing && (
        // key by token id: switching the edited row while the form is open must
        // remount it so the seeded form state (name/scope/spaces) re-initialises
        // for the new token — otherwise a Save would write the old token's values.
        <TokenEditForm
          key={editing.id}
          me={me}
          source={source}
          pat={editing}
          onSaved={onEdited}
          onCancel={() => setEditing(null)}
        />
      )}

      {error && <p className={styles.error}>{error}</p>}
      {tokens && tokens.length === 0 && !creating && (
        <EmptyState
          icon={<IconKey size={22} />}
          title="No tokens yet"
          hint="Create a personal access token to let an agent or script use the API as you."
          testId="pat-empty"
        />
      )}
      {tokens && tokens.length > 0 && (
        <table className={styles.table} data-testid="pat-list">
          <thead>
            <tr>
              <th>Name</th>
              <th>Scope</th>
              <th>Spaces</th>
              <th>Created</th>
              <th>Expires</th>
              <th>Last used</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {tokens.map((t) => (
              <tr key={t.id} data-testid="pat-row">
                <td className={styles.cellName}>{t.name}</td>
                <td>
                  <span
                    className={cx(styles.badge, t.scope === PAT_SCOPE.write && styles.badgeAccent)}
                  >
                    {t.scope}
                  </span>
                </td>
                {/* null = all grants; [] = narrowed to spaces the registry no longer lists
                    (fail-closed, reaches none) — distinct from a rendering gap. */}
                <td>{t.spaces == null ? 'all' : t.spaces.length ? t.spaces.join(', ') : 'none'}</td>
                {/* Created / last used are past instants → relative + exact tooltip
                    (same pattern as Connected apps). Expiry is a FUTURE (or already
                    lapsed) instant → an absolute date; timeAgo can't express "in N
                    days" and would collapse the future to "just now". */}
                <td title={exactDateTime(t.createdAt)}>{timeAgo(t.createdAt)}</td>
                <td title={t.expiresAt ? exactDateTime(t.expiresAt) : undefined}>
                  {t.expiresAt ? absoluteDate(t.expiresAt) : 'Never'}
                </td>
                <td title={t.lastUsedAt ? exactDateTime(t.lastUsedAt) : undefined}>
                  {t.lastUsedAt ? timeAgo(t.lastUsedAt) : '—'}
                </td>
                <td className={styles.cellActions}>
                  <Button
                    icon
                    variant="ghost"
                    title="Edit token"
                    data-testid="pat-edit"
                    onClick={() => {
                      setEditing(t)
                      setCreating(false)
                      setFresh(null)
                    }}
                  >
                    <IconEdit size={14} />
                  </Button>
                  <Button
                    icon
                    variant="ghost"
                    title="Revoke token"
                    data-testid="pat-revoke"
                    onClick={() => void onRevoke(t)}
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

export { TokensSection }
