import { Link } from 'react-router'
import { Button } from '../../core/Button'
import { Checkbox } from '../../core/Checkbox'
import { Chip } from '../../core/Chips'
import {
  IconBotMessage,
  IconClock,
  IconDoc,
  IconExternal,
  IconRefresh,
  IconUser,
  IconWorkspace,
} from '../../core/Icons'
import { authorLabel } from '../../libs/author'
import { cx } from '../../libs/cx/cx'
import { absoluteDate } from '../../libs/datetime'
import { ROW_H } from './consts'
import type { TrashEntry } from './types'
import styles from './TrashPage.module.scss'

/** ONE row for a deleted item — a note or a space render identically through it. */
export const TrashRow = ({
  entry,
  selectable,
  checked,
  busy,
  disabled,
  isLast,
  onToggle,
  onRestore,
}: {
  entry: TrashEntry
  selectable: boolean
  checked: boolean
  busy: boolean
  disabled: boolean
  isLast: boolean
  onToggle: (on: boolean) => void
  onRestore: () => void
}) => {
  const who = authorLabel(entry.who) // null → "outside Notarium"
  const checkId = entry.kind === 'space' ? 'trash-space-check' : 'trash-row-check'
  const restoreId = entry.kind === 'space' ? 'trash-space-restore' : 'trash-restore'
  const body = (
    <>
      <div className={styles.titleRow}>
        <span
          className={styles.kind}
          title={entry.kind === 'space' ? 'A deleted space' : 'A deleted note'}
        >
          {entry.kind === 'space' ? <IconWorkspace size={14} /> : <IconDoc size={14} />}
        </span>
        <span className={styles.title} title={entry.title}>
          {entry.title}
        </span>
        {entry.memory && (
          <Chip
            icon={<IconBotMessage size={11} />}
            className={styles.tagMemory}
            title="An agent-memory note — the agent's private memory, deleted here"
          >
            memory
          </Chip>
        )}
        {entry.external && (
          <Chip
            icon={<IconExternal size={11} />}
            className={styles.tagExternal}
            title="Removed outside Notarium — the journal caught it"
          >
            outside Notarium
          </Chip>
        )}
      </div>
      <span className={styles.meta}>
        {entry.pathText && (
          <>
            <span className={styles.path} title={entry.pathText}>
              {entry.pathText}
            </span>
            <span className={styles.dot}>·</span>
          </>
        )}
        {who.agent ? <IconBotMessage size={12} /> : <IconUser size={12} />}
        <span>{who.text}</span>
        {entry.date && (
          <>
            <span className={styles.dot}>·</span>
            <IconClock size={12} />
            <span>{absoluteDate(entry.date)}</span>
          </>
        )}
      </span>
    </>
  )
  return (
    <div
      className={cx(styles.row, isLast && styles.rowLast)}
      style={{ height: ROW_H }}
      data-testid={entry.kind === 'space' ? 'trash-space-row' : 'trash-row'}
    >
      {selectable && (
        <span className={styles.check}>
          <Checkbox
            checked={checked}
            disabled={disabled}
            onChange={onToggle}
            aria-label={`Select ${entry.title}`}
            data-testid={checkId}
          />
        </span>
      )}
      {entry.href ? (
        <Link to={entry.href} className={styles.body} data-testid="trash-row-open">
          {body}
        </Link>
      ) : (
        <div className={styles.body}>{body}</div>
      )}
      {selectable && (
        <Button
          variant="ghost"
          icon
          onClick={onRestore}
          disabled={disabled || busy || !entry.restorable}
          title={entry.restoreTitle}
          data-testid={restoreId}
        >
          <IconRefresh size={15} />
        </Button>
      )}
    </div>
  )
}
