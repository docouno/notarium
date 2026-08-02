import { useEffect, useState } from 'react'
import { Navigate } from 'react-router'
import { AUTH_MODE } from '@notarium/contract/enums'
import { useAuth } from '../../composers/AuthProvider'
import { Button } from '../../core/Button'
import { Notice } from '../../core/Notice'
import { SettingsSection } from '../../core/SettingsSection'
import { SkeletonText } from '../../core/Skeleton'
import { useToast } from '../../core/Toast'
import { errorText } from '../../libs/errors'
import { settingsRoute } from '../../libs/routing/routePaths'
import { api } from '../../services/api'
import styles from './ProfileTab.module.scss'

// Profile (#13): the human-authored half of the personal layer — the identity
// agents load at session start (an `always-load` note in the personal domain)
// plus the display name. The opposite of the Memory tab (agent-authored). It
// lives in Settings, not the Agents page, because it is the USER curating
// themselves — keeping "about me" here and "what agents recorded" under Agents
// is the whole point of the split (provenance is the dividing line).

export const ProfileTab = () => {
  const { mode, me, refresh } = useAuth()
  const toast = useToast()
  const user = mode === AUTH_MODE.password ? me : null

  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [displayName, setDisplayName] = useState('')
  const [content, setContent] = useState('')
  const [versionToken, setVersionToken] = useState<string | null>(null)
  // The values last persisted — dirty = the form diverged from them.
  const [saved, setSaved] = useState({ displayName: '', content: '' })
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!user) {
      return
    }
    void (async () => {
      try {
        const p = await api.profileGet()
        setDisplayName(p.displayName)
        setContent(p.content)
        setVersionToken(p.versionToken)
        setSaved({ displayName: p.displayName, content: p.content })
      } catch (e) {
        setError(errorText(e))
      } finally {
        setLoaded(true)
      }
    })()
  }, [user])

  // No profile without a signed-in user (mode 'none') — bounce to the prefs tab.
  if (!user) {
    return <Navigate to={settingsRoute()} replace />
  }

  const dirty = displayName.trim() !== saved.displayName || content !== saved.content
  const canSave = loaded && !busy && dirty && displayName.trim().length > 0

  const onSave = async () => {
    if (!canSave) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      const p = await api.profilePut({
        displayName: displayName.trim(),
        content,
        ...(versionToken ? { versionToken } : {}),
      })
      setVersionToken(p.versionToken)
      setSaved({ displayName: p.displayName, content: p.content })
      setDisplayName(p.displayName)
      setContent(p.content)
      await refresh() // the new display name rides me → sidebar/profile button update
      toast.success('Profile saved')
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingsSection
      title="Profile"
      testId="profile"
      description="Who you are, for the agents you work with. Your display name and an always-loaded note agents read at the start of every session."
    >
      {error && (
        <Notice variant="error" data-testid="profile-error">
          {error}
        </Notice>
      )}

      {!loaded ? (
        <SkeletonText lines={4} />
      ) : (
        <div className={styles.form}>
          <label className={styles.field}>
            <span className={styles.label}>Display name</span>
            <input
              className={styles.input}
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              spellCheck={false}
              maxLength={200}
              data-testid="profile-display-name"
            />
          </label>

          <label className={styles.field}>
            <span className={styles.label}>About you</span>
            <span className={styles.hint}>
              Markdown. Context an agent should always have — how you like to work, who you are,
              standing preferences.
            </span>
            <textarea
              className={styles.textarea}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              spellCheck={false}
              rows={10}
              placeholder="e.g. I lead a small team. Prefer short answers with concrete examples."
              data-testid="profile-content"
            />
          </label>

          {/* Primary action under the form, not in the section header — a form's
              Save belongs below its fields (matches the Account tab's submit row). */}
          <div className={styles.formActions}>
            <Button
              variant="primary"
              onClick={() => void onSave()}
              disabled={!canSave}
              data-testid="profile-save"
            >
              {busy ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </div>
      )}
    </SettingsSection>
  )
}
