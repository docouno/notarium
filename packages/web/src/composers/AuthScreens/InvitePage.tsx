import { type FormEvent, useEffect, useState } from 'react'
import type { InviteInfo } from '@notarium/contract'
import { TOKEN_PURPOSE } from '@notarium/contract/enums'
import { Button } from '../../core/Button'
import { IconBrain } from '../../core/Icons'
import { api } from '../../services/api'
import styles from './AuthScreens.module.scss'

// The invite/reset landing (#10): /invite#<token>. The token rides the URL
// FRAGMENT (never reaches server logs) and is read here, client-side; the
// greeting comes from invite-info so the user sees WHO the link activates
// before typing a password. Works logged-in or not — accepting simply replaces
// the session, and the hard reload re-boots the app as the new principal.
export const InvitePage = () => {
  const [token] = useState(() => window.location.hash.slice(1))
  const [info, setInfo] = useState<InviteInfo | null>(null)
  const [dead, setDead] = useState(false)
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!token) {
      setDead(true)
      return
    }
    api
      .inviteInfo(token)
      .then(setInfo)
      .catch(() => setDead(true)) // 404 = used/expired/never existed — one answer
  }, [token])

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
      await api.acceptInvite(token, password)
      // Full reload, not a refresh(): the link may have been opened mid-session
      // as someone else — rebooting adopts the new cookie cleanly.
      window.location.replace('/')
    } catch {
      // The single-use token may have just been spent (or expired in between).
      setDead(true)
    }
  }

  return (
    <div className={styles.authScreen}>
      <div className={styles.card} data-testid="auth-invite">
        <div className={styles.head}>
          <span className={styles.mark}>
            <IconBrain size={36} />
          </span>
          {dead ? (
            <>
              <h1>This link is no longer valid</h1>
              <p data-testid="auth-invite-dead">
                Invite and reset links are single-use and expire. Ask your admin for a fresh one.
              </p>
            </>
          ) : !info ? (
            <h1>Checking link…</h1>
          ) : info.purpose === TOKEN_PURPOSE.invite ? (
            <>
              <h1>Welcome, {info.displayName}</h1>
              <p>Set a password to activate your account ({info.username}).</p>
            </>
          ) : (
            <>
              <h1>Reset your password</h1>
              <p>Choose a new password for {info.username}.</p>
            </>
          )}
        </div>
        {!dead && info && (
          <form className={styles.form} onSubmit={(e) => void onSubmit(e)}>
            <label className={styles.field}>
              <span>Password</span>
              <input
                data-testid="auth-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="at least 8 characters"
                autoComplete="new-password"
                autoFocus
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
              disabled={busy || !password || !confirm}
            >
              {busy
                ? 'Saving…'
                : info.purpose === TOKEN_PURPOSE.invite
                  ? 'Activate account'
                  : 'Set new password'}
            </Button>
          </form>
        )}
      </div>
    </div>
  )
}
