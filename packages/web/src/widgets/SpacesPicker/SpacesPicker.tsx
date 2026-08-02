import type { Me } from '@notarium/contract'
import { Checkbox } from '../../core/Checkbox'
import { Switch } from '../../core/Switch'
import styles from './SpacesPicker.module.scss'

// The per-space narrowing picker, shared by the API-token forms (#10/#162) and the
// connected-app form (#181): an "All spaces" switch that, when off, reveals a
// checkbox per space the owner can see. The narrowing wire value is null when All
// is on (every grant, future ones included) or the ticked slugs otherwise — the
// hosting form owns that mapping; this is pure presentation. Renders nothing when
// the owner has no spaces (there is nothing to narrow to).

export const SpacesPicker = ({
  me,
  allSpaces,
  onAllSpaces,
  picked,
  onToggle,
  switchTestId,
}: {
  me: Me
  allSpaces: boolean
  onAllSpaces: (v: boolean) => void
  picked: Set<string>
  onToggle: (slug: string) => void
  switchTestId: string
}) => {
  if (me.spaces.length === 0) {
    return null
  }

  return (
    <div className={styles.field}>
      <span>Spaces</span>
      <Switch
        checked={allSpaces}
        onChange={onAllSpaces}
        label="All spaces"
        data-testid={switchTestId}
      />
      {!allSpaces && (
        <div className={styles.pick} role="group" aria-label="Spaces">
          {me.spaces.map((s) => (
            <Checkbox
              key={s.slug}
              checked={picked.has(s.slug)}
              onChange={() => onToggle(s.slug)}
              label={s.slug}
            />
          ))}
        </div>
      )}
    </div>
  )
}

/** Order-insensitive equality of two space narrowings (null = all spaces) — an
 *  edit form's dirty/Save gate compares the draft against its seed with this. */
export const sameSpaceSet = (a: string[] | null, b: string[] | null): boolean => {
  if (a == null || b == null) {
    return a === b
  }
  if (a.length !== b.length) {
    return false
  }
  const bs = new Set(b)
  return a.every((s) => bs.has(s))
}
