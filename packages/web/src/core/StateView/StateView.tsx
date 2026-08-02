import { type ReactNode } from 'react'
import { cx } from '../../libs/cx/cx'
import styles from './StateView.module.scss'

// A full-area status screen (#65) — the shared answer to "this whole region
// can't show its normal content right now: here's why and what to do". One
// vocabulary for every such case: a 404 route, a note that doesn't exist, the
// knowledge engine being unreachable, a generic transport failure, a crash
// fallback. Distinct from EmptyState (a small dashed card *inside* a populated
// panel) — StateView owns the area and centres in it.
//
// Anatomy: a glyph in a tone-tinted disc, a short uppercase `code` eyebrow
// (e.g. "404", "Engine offline") for character and quick scanning, a title, a
// description, and `actions` (usually <Button>s) as the next step. `tone` is the
// only skin: 'muted' for expected/benign states, 'error' for something wrong.

type StateTone = 'muted' | 'error'

export const StateView = ({
  icon,
  code,
  title,
  description,
  tone = 'muted',
  actions,
  testId,
}: {
  icon?: ReactNode
  /** Short uppercase eyebrow above the title — "404", "Not found", "Offline". */
  code?: string
  title: string
  description?: ReactNode
  tone?: StateTone
  actions?: ReactNode
  testId?: string
}) => (
  <div
    className={cx(styles.state, styles[tone])}
    role={tone === 'error' ? 'alert' : 'status'}
    data-testid={testId}
  >
    {icon && <span className={styles.figure}>{icon}</span>}
    {code && <span className={styles.code}>{code}</span>}
    <h2 className={styles.title}>{title}</h2>
    {description && <p className={styles.description}>{description}</p>}
    {actions && <div className={styles.actions}>{actions}</div>}
  </div>
)
