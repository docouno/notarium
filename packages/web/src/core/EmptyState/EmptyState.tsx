import { type ReactNode } from 'react'
import { cx } from '../../libs/cx/cx'
import styles from './EmptyState.module.scss'

// A designed empty-block placeholder (#28): the shared answer to "this region is
// empty — here's what it holds and how to fill it". Two skins for two framings,
// so the same vocabulary fits both without per-call hacks:
//
//  - 'card' (default): a dashed, muted card. Empty reads as a fillable state of a
//    block that sits among OTHER content — a settings section, the feed canvas.
//    Pass an optional `action` (e.g. the same "New …" button) as the next step.
//  - 'bare': no border or background, content centred and width-capped (~75%, up
//    to 300px). For when the panel ITSELF is the frame — the aside (graph /
//    backlinks / history) and the rail — where a card would be a frame inside a
//    frame (#68). Horizontal centring is built in (auto margins); vertical
//    centring is the container's to grant (a full-height flex parent).
type EmptyVariant = 'card' | 'bare'

export const EmptyState = ({
  icon,
  title,
  hint,
  action,
  variant = 'card',
  testId,
}: {
  icon?: ReactNode
  title: string
  hint?: ReactNode
  action?: ReactNode
  variant?: EmptyVariant
  testId?: string
}) => (
  <div className={cx(styles.empty, styles[variant])} data-testid={testId}>
    {icon && <span className={styles.icon}>{icon}</span>}
    <span className={styles.title}>{title}</span>
    {hint && <span className={styles.hint}>{hint}</span>}
    {action && <div className={styles.action}>{action}</div>}
  </div>
)
