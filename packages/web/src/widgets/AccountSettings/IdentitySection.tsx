import { type FormEvent, useEffect, useState } from 'react'
import type { Me } from '@notarium/contract'
import { isUsername, USERNAME_MAX } from '@notarium/contract/enums'
import { Button } from '../../core/Button'
import { SettingsSection } from '../../core/SettingsSection'
import { errorText } from '../../libs/errors'
import { IDENTITY_REASONS } from './consts'
import type { AccountSettingsSource } from './types'
import styles from './AccountSettings.module.scss'

// Who I am: the handle I sign in with and the address an admin can reach me at. The
// first block of the account, above how I change my password — an account starts
// with who you are. A rename keeps everything: memberships, tokens, agent memory and
// history follow the account's stable id, so the form does not warn about loss —
// only that the OLD handle stops signing in at once and can be taken by someone else.
const IdentitySection = ({ me, source }: { me: Me; source: AccountSettingsSource }) => {
  const [username, setUsername] = useState(me.username)
  const [email, setEmail] = useState(me.email ?? '')
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const [busy, setBusy] = useState(false)

  // A rename elsewhere (another tab, an admin) arrives through `me`; an untouched form
  // follows it rather than offering the stale handle back for saving.
  useEffect(() => {
    setUsername(me.username)
    setEmail(me.email ?? '')
  }, [me.username, me.email])

  const nextUsername = username.trim()
  const nextEmail = email.trim()
  const changed = nextUsername !== me.username || nextEmail !== (me.email ?? '')
  // `isUsername` is the alphabet the wire schema is built from — the same rule, without
  // dragging zod and the schema barrel into this chunk. The form therefore refuses
  // exactly what the route would, and says it in the product's words instead of
  // shipping a 400 whose message was written for an API client. The address is left to
  // the browser: `type="email"` below, like the admin form.
  const invalid =
    nextUsername !== me.username && !isUsername(nextUsername)
      ? 'A username is lowercase letters and digits, with dots, underscores or dashes inside — up to 32 characters.'
      : null

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy || !changed || !nextUsername || invalid) {
      return
    }
    setBusy(true)
    setError(null)
    setDone(false)
    try {
      await source.updateIdentity({
        ...(nextUsername !== me.username ? { username: nextUsername } : {}),
        ...(nextEmail !== (me.email ?? '') ? { email: nextEmail || null } : {}),
      })
      setDone(true)
    } catch (err) {
      setError(errorText(err, IDENTITY_REASONS))
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingsSection title="Identity" testId="account-identity">
      <form className={styles.stack} onSubmit={(e) => void onSubmit(e)}>
        <div className={styles.fieldRow}>
          <label className={styles.field}>
            <span>Username</span>
            <input
              data-testid="account-username"
              type="text"
              value={username}
              onChange={(e) => {
                // A server answer belongs to the values that were sent; once they change
                // it is no longer the reason anything is refused, and leaving it up would
                // put the wrong cause beside a button disabled for another one.
                setError(null)
                setUsername(e.target.value)
              }}
              autoComplete="username"
              maxLength={USERNAME_MAX}
              spellCheck={false}
            />
          </label>
          <label className={styles.field}>
            <span>Email</span>
            <input
              data-testid="account-email"
              type="email"
              value={email}
              onChange={(e) => {
                setError(null)
                setEmail(e.target.value)
              }}
              placeholder="not set"
              autoComplete="email"
              spellCheck={false}
            />
          </label>
        </div>
        {nextUsername !== me.username && (
          <p className={styles.ok} data-testid="account-rename-note">
            You sign in with the new username right away; the old one is free for anyone to take.
            Everything else — spaces, tokens, history — stays yours.
          </p>
        )}
        {(error ?? invalid) && (
          <p className={styles.error} data-testid="account-identity-error">
            {error ?? invalid}
          </p>
        )}
        {done && !changed && (
          <p className={styles.ok} data-testid="account-identity-saved">
            Saved.
          </p>
        )}
        <div className={styles.formActions}>
          <Button
            type="submit"
            data-testid="account-identity-save"
            disabled={busy || !changed || !nextUsername || Boolean(invalid)}
          >
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </form>
    </SettingsSection>
  )
}

export { IdentitySection }
