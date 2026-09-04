import { type FormEvent, useState } from 'react'
import { HTTP_STATUS } from '@notarium/contract/http'
import { Button } from '../../core/Button'
import { IconBrain } from '../../core/Icons'
import { errorText } from '../../libs/errors'
import { api, type ApiError } from '../../services/api'
import { useAuth } from '../AuthProvider'
import styles from './AuthScreens.module.scss'

// The login screen (#10). On success the cookie is already set — refresh()
// adopts the session and the gate swaps this screen for the app tree.
export const LoginPage = () => {
  const { refresh } = useAuth()
  const [identifier, setIdentifier] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy || !identifier.trim() || !password) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      await api.login(identifier.trim(), password)
      await refresh()
    } catch (err) {
      const status = (err as ApiError).status
      // Deliberately generic on 401 — which half was wrong is exactly what an
      // enumeration attempt wants to learn. An exhausted per-account budget is the
      // same 401 on purpose; only the per-ip gate says 429.
      setError(
        status === HTTP_STATUS.TOO_MANY_REQUESTS
          ? 'Too many attempts — try again in a minute.'
          : status === HTTP_STATUS.UNAUTHORIZED
            ? 'Invalid username, email or password.'
            : errorText(err),
      )
      setBusy(false)
    }
  }

  return (
    <div className={styles.authScreen}>
      <form className={styles.card} data-testid="auth-login" onSubmit={(e) => void onSubmit(e)}>
        <div className={styles.head}>
          <span className={styles.mark}>
            <IconBrain size={36} />
          </span>
          <h1>Sign in to Notarium</h1>
        </div>
        <div className={styles.form}>
          <label className={styles.field}>
            <span>Username or email</span>
            <input
              data-testid="auth-username"
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              autoComplete="username"
              autoFocus
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
              autoComplete="current-password"
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
            disabled={busy || !identifier.trim() || !password}
          >
            {busy ? 'Signing in…' : 'Sign in'}
          </Button>
        </div>
      </form>
    </div>
  )
}
