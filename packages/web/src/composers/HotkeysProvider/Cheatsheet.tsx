import { Link } from 'react-router'
import { Modal } from '../../core/Modal'
import {
  ACTIONS,
  type Binding,
  formatChord,
  IS_MAC,
  type ResolvedKeymap,
  SECTIONS,
} from '../../libs/hotkeys'
import { settingsRoute } from '../../libs/routing/routePaths'
import styles from './Cheatsheet.module.scss'

// The `?` cheat sheet (#30) — every active shortcut, grouped by section, read STRAIGHT
// from the resolved keymap so it can never drift from what the dispatcher actually
// fires (and it reflects the user's preset + overrides live). Built on core/Modal
// (portal, backdrop, Escape, focus-trap, scroll-lock), like the Spotlight overlay.

/** Render one binding as <kbd> chips; sequence steps are separated by a quiet "then". */
const OneBinding = ({ binding }: { binding: Binding }) => (
  <span className={styles.keys}>
    {binding.map((chord, i) => (
      <span key={i} className={styles.step}>
        {i > 0 && <span className={styles.then}>then</span>}
        <kbd className={styles.kbd}>{formatChord(chord, IS_MAC)}</kbd>
      </span>
    ))}
  </span>
)

/** All of an action's bindings, separated by a quiet "or" (Save = Cmd+Enter or Cmd+S). */
const Keys = ({ bindings }: { bindings: Binding[] }) => {
  if (bindings.length === 0) {
    return <span className={styles.unbound}>—</span>
  }

  return (
    <span className={styles.keys}>
      {bindings.map((b, i) => (
        <span key={i} className={styles.step}>
          {i > 0 && <span className={styles.then}>or</span>}
          <OneBinding binding={b} />
        </span>
      ))}
    </span>
  )
}

export const Cheatsheet = ({
  resolved,
  onClose,
}: {
  resolved: ResolvedKeymap
  onClose: () => void
}) => (
  <Modal onClose={onClose} size="lg" labelledBy="cheatsheet-title">
    <div className={styles.head} data-testid="cheatsheet">
      <h2 id="cheatsheet-title" className={styles.title}>
        Keyboard shortcuts
      </h2>
      <Link to={settingsRoute('keyboard')} className={styles.customise} onClick={onClose}>
        Customise…
      </Link>
    </div>
    <div className={styles.grid}>
      {SECTIONS.map((section) => {
        const rows = ACTIONS.filter((a) => a.section === section.id)

        if (!rows.length) {
          return null
        }

        return (
          <section key={section.id} className={styles.section}>
            <h3 className={styles.sectionTitle}>{section.label}</h3>
            <dl className={styles.rows}>
              {rows.map((a) => (
                <div key={a.id} className={styles.row}>
                  <dt className={styles.label}>{a.label}</dt>
                  <dd className={styles.binding}>
                    <Keys bindings={resolved.byAction[a.id] ?? []} />
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        )
      })}
    </div>
    <p className={styles.foot}>
      Single keys work when you’re not typing in a field. Modifier chords (like{' '}
      {formatChord({ code: 'KeyP', mod: true }, IS_MAC)}) work anywhere.
    </p>
  </Modal>
)
