import { type FormEvent, useState } from 'react'
import type { Me, Pat, PatScope } from '@notarium/contract'
import { Button } from '../../core/Button'
import { Segmented } from '../../core/Segmented'
import { cx } from '../../libs/cx/cx'
import { errorText } from '../../libs/errors'
import { sameSpaceSet, SpacesPicker } from '../SpacesPicker'
import { SCOPE_OPTIONS } from './consts'
import type { AccountSettingsSource } from './types'
import styles from './AccountSettings.module.scss'

const TokenEditForm = ({
  me,
  source,
  pat,
  onSaved,
  onCancel,
}: {
  me: Me
  source: AccountSettingsSource
  pat: Pat
  onSaved: () => void
  onCancel: () => void
}) => {
  // The narrowing the form can REPRESENT: the token's spaces minus any the owner
  // can no longer see (archived #110 / lost membership) — those have no checkbox,
  // so the form can't round-trip them. This is the dirty baseline AND the seed; the
  // spaces axis counts as changed only when the user edits it away from this, and
  // the patch OMITS spaces when untouched — so a name/scope-only edit never silently
  // drops a space the form couldn't display (and a fully-narrowed token whose owner
  // lost every membership stays name/scope-editable instead of being stuck on the
  // "pick at least one space" guard with no visible picker). FROZEN at mount (useState
  // init) so a mid-edit `me` change (an SSE access nudge) can't shift the baseline
  // under the once-seeded picked → no phantom-dirty / spurious 400 on a name-only save.
  const [seededSpaces] = useState<string[] | null>(() =>
    pat.spaces == null ? null : pat.spaces.filter((s) => me.spaces.some((ms) => ms.slug === s)),
  )
  const [name, setName] = useState(pat.name)
  const [scope, setScope] = useState<PatScope>(pat.scope)
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

  // Disable Save until something actually changed (#162).
  const draftSpaces = allSpaces ? null : [...picked]
  const spacesChanged = !sameSpaceSet(draftSpaces, seededSpaces)
  const dirty = name.trim() !== pat.name || scope !== pat.scope || spacesChanged

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy) {
      return
    }
    if (!name.trim()) {
      setError('Name cannot be empty.')
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
      await source.editToken(pat.id, {
        name: name.trim(),
        scope,
        ...(spacesChanged ? { spaces: draftSpaces } : {}),
      })
      onSaved()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      className={styles.createForm}
      data-testid="pat-edit-form"
      onSubmit={(e) => void onSubmit(e)}
    >
      <div className={styles.formHeader}>Edit token</div>
      <div className={styles.patGridEdit}>
        <label className={styles.field}>
          <span>Name</span>
          <input
            data-testid="pat-edit-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
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
      </div>
      <SpacesPicker
        me={me}
        allSpaces={allSpaces}
        onAllSpaces={setAllSpaces}
        picked={picked}
        onToggle={toggleSpace}
        switchTestId="pat-edit-all-spaces"
      />
      {error && <p className={styles.error}>{error}</p>}
      <div className={styles.formActions}>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button
          type="submit"
          variant="primary"
          data-testid="pat-edit-save"
          disabled={busy || !dirty}
        >
          {busy ? 'Saving…' : 'Save changes'}
        </Button>
      </div>
    </form>
  )
}

export { TokenEditForm }
