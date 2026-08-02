import { type FormEvent, useState } from 'react'
import type { Me, PatCreateResponse, PatScope } from '@notarium/contract'
import { PAT_SCOPE } from '@notarium/contract/enums'
import { Button } from '../../core/Button'
import { Segmented } from '../../core/Segmented'
import { cx } from '../../libs/cx/cx'
import { errorText } from '../../libs/errors'
import { SpacesPicker } from '../SpacesPicker'
import { EXPIRY_DAYS, SCOPE_OPTIONS } from './consts'
import type { AccountSettingsSource } from './types'
import styles from './AccountSettings.module.scss'

const TokenCreateForm = ({
  me,
  source,
  onCreated,
  onCancel,
}: {
  me: Me
  source: AccountSettingsSource
  onCreated: (result: PatCreateResponse) => void
  onCancel: () => void
}) => {
  const [name, setName] = useState('')
  const [scope, setScope] = useState<PatScope>(PAT_SCOPE.read)
  const [allSpaces, setAllSpaces] = useState(true)
  const [picked, setPicked] = useState<Set<string>>(() => new Set())
  const [expiry, setExpiry] = useState<'30d' | '90d' | 'never'>('30d')
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

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy || !name.trim()) {
      return
    }
    if (!allSpaces && picked.size === 0) {
      setError('Pick at least one space, or allow all.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const days = EXPIRY_DAYS[expiry]
      onCreated(
        await source.createToken({
          name: name.trim(),
          scope,
          spaces: allSpaces ? null : [...picked],
          expiresAt: days == null ? null : new Date(Date.now() + days * 86_400_000).toISOString(),
        }),
      )
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      className={styles.createForm}
      data-testid="pat-create-form"
      onSubmit={(e) => void onSubmit(e)}
    >
      <div className={styles.formHeader}>New token</div>
      <div className={styles.patGrid}>
        <label className={styles.field}>
          <span>Name</span>
          <input
            data-testid="pat-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. research agent"
            spellCheck={false}
            autoFocus
          />
        </label>
        <div className={cx(styles.field, styles.fieldControl)}>
          <span>Scope</span>
          <Segmented<PatScope>
            value={scope}
            onChange={setScope}
            ariaLabel="Token scope"
            options={SCOPE_OPTIONS}
          />
        </div>
        <div className={cx(styles.field, styles.fieldControl)}>
          <span>Expires</span>
          <Segmented<'30d' | '90d' | 'never'>
            value={expiry}
            onChange={setExpiry}
            ariaLabel="Token expiry"
            options={[
              { value: '30d', label: '30 days' },
              { value: '90d', label: '90 days' },
              { value: 'never', label: 'Never' },
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
        switchTestId="pat-all-spaces"
      />
      {error && <p className={styles.error}>{error}</p>}
      <div className={styles.formActions}>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button
          type="submit"
          variant="primary"
          data-testid="pat-create"
          disabled={busy || !name.trim()}
        >
          {busy ? 'Creating…' : 'Create token'}
        </Button>
      </div>
    </form>
  )
}

export { TokenCreateForm }
