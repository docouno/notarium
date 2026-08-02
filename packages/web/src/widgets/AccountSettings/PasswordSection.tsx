import { type FormEvent, useState } from 'react'
import { Button } from '../../core/Button'
import { SettingsSection } from '../../core/SettingsSection'
import { errorText } from '../../libs/errors'
import { PASSWORD_REASONS } from './consts'
import type { AccountSettingsSource } from './types'
import styles from './AccountSettings.module.scss'

const PasswordSection = ({ source }: { source: AccountSettingsSource }) => {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const [busy, setBusy] = useState(false)

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy) {
      return
    }
    if (next.length < 8) {
      setError('New password must be at least 8 characters.')
      return
    }
    if (next !== confirm) {
      setError('Passwords do not match.')
      return
    }
    setBusy(true)
    setError(null)
    setDone(false)
    try {
      await source.changePassword(current, next)
      setCurrent('')
      setNext('')
      setConfirm('')
      setDone(true)
    } catch (err) {
      setError(errorText(err, PASSWORD_REASONS))
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingsSection title="Password" testId="account-settings">
      <form className={styles.stack} onSubmit={(e) => void onSubmit(e)}>
        <div className={styles.fieldRow}>
          <label className={styles.field}>
            <span>Current password</span>
            <input
              data-testid="account-password-current"
              type="password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              autoComplete="current-password"
            />
          </label>
          <label className={styles.field}>
            <span>New password</span>
            <input
              data-testid="account-password-new"
              type="password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              autoComplete="new-password"
            />
          </label>
          <label className={styles.field}>
            <span>Confirm new password</span>
            <input
              data-testid="account-password-confirm"
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
            />
          </label>
        </div>
        {error && (
          <p className={styles.error} data-testid="account-password-error">
            {error}
          </p>
        )}
        {done && (
          <p className={styles.ok} data-testid="account-password-done">
            Password changed.
          </p>
        )}
        <div className={styles.formActions}>
          <Button type="submit" disabled={busy || !current || !next || !confirm}>
            {busy ? 'Changing…' : 'Change password'}
          </Button>
        </div>
      </form>
    </SettingsSection>
  )
}

export { PasswordSection }
