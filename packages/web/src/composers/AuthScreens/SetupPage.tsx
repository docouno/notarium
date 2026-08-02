import { type FormEvent, useState } from 'react'
import { Button } from '../../core/Button'
import { IconBrain } from '../../core/Icons'
import { errorText } from '../../libs/errors'
import { api } from '../../services/api'
import { useAuth } from '../AuthProvider'
import styles from './AuthScreens.module.scss'

// First-run setup (#10): the host has zero users, so whoever reaches it first
// mints the owner (admin) account. The server closes /api/auth/setup forever
// once a user exists — this screen can't reappear later.
export const SetupPage = () => {
  const { refresh } = useAuth()
  const [username, setUsername] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy) {
      return
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters.')
      return
    }
    if (password !== confirm) {
      setError('Passwords do not match.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await api.setup({
        username: username.trim(),
        displayName: displayName.trim() || undefined,
        password,
      })
      await refresh()
    } catch (err) {
      setError(errorText(err))
      setBusy(false)
    }
  }

  return (
    <div className={styles.authScreen}>
      <form className={styles.card} data-testid="auth-setup" onSubmit={(e) => void onSubmit(e)}>
        <div className={styles.head}>
          <span className={styles.mark}>
            <IconBrain size={36} />
          </span>
          <h1>Welcome to Notarium</h1>
          <p>Create the owner account for this host. You can invite others later.</p>
        </div>
        <div className={styles.form}>
          <label className={styles.field}>
            <span>Username</span>
            <input
              data-testid="auth-username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="lowercase letters, digits, dashes"
              autoComplete="username"
              autoFocus
              spellCheck={false}
            />
          </label>
          <label className={styles.field}>
            <span>Display name (optional)</span>
            <input
              data-testid="auth-display-name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              autoComplete="name"
              spellCheck={false}
            />
          </label>
          <label className={styles.field}>
            <span>Password</span>
            <input
              data-testid="auth-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="at least 8 characters"
              autoComplete="new-password"
            />
          </label>
          <label className={styles.field}>
            <span>Confirm password</span>
            <input
              data-testid="auth-password-confirm"
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
            />
          </label>
          {error && (
            <p className={styles.error} data-testid="auth-error">
              {error}
            </p>
          )}
          <Button
            type="submit"
            variant="primary"
            className={styles.submit}
            data-testid="auth-submit"
            disabled={busy || !username.trim() || !password || !confirm}
          >
            {busy ? 'Creating…' : 'Create account'}
          </Button>
        </div>
      </form>
    </div>
  )
}
