import { Link } from 'react-router'
import { Button } from '../../core/Button'
import { Checkbox } from '../../core/Checkbox'
import {
  IconAlertTriangle,
  IconBotMessage,
  IconClock,
  IconDoc,
  IconExternal,
  IconEye,
  IconRefresh,
  IconUser,
  IconWorkspace,
  IconX,
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
  onExplain,
}: {
  entry: TrashEntry
  selectable: boolean
  checked: boolean
  busy: boolean
  disabled: boolean
  isLast: boolean
  onToggle: (on: boolean) => void
  onRestore: () => void
  onExplain: () => void
}) => {
  const who = authorLabel(entry.who) // null → "outside Notarium"
  const checkId = entry.kind === 'space' ? 'trash-space-check' : 'trash-row-check'
  const restoreId = entry.kind === 'space' ? 'trash-space-restore' : 'trash-restore'
  const kindTitle =
    entry.kind === 'space'
      ? 'A deleted space'
      : entry.memory
        ? "An agent-memory note — the agent's private memory"
        : 'A deleted note'
  const body = (
    <>
      <div className={styles.titleRow}>
        <span className={styles.kind} title={kindTitle}>
          {entry.kind === 'space' ? (
            <IconWorkspace size={14} />
          ) : entry.memory ? (
            <IconBotMessage size={14} />
          ) : (
            <IconDoc size={14} />
          )}
        </span>
        <span className={styles.title} title={entry.title}>
          {entry.title}
        </span>
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
        {entry.external ? (
          <>
            <IconExternal size={12} />
            <span>removed outside Notarium</span>
          </>
        ) : (
          <>
            {who.agent ? <IconBotMessage size={12} /> : <IconUser size={12} />}
            <span>{who.text}</span>
          </>
        )}
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
      {entry.recovery.kind !== 'complete' && entry.recovery.kind !== 'host-unavailable' && (
        <button
          type="button"
          className={cx(
            styles.recoveryStatus,
            entry.recovery.kind === 'partial' ? styles.recoveryPartial : styles.recoveryUnavailable,
          )}
          title={entry.recovery.reason}
          aria-label={`${entry.recovery.label}. ${entry.recovery.reason}`}
          onClick={onExplain}
          data-testid="trash-recovery-status"
        >
          {entry.recovery.kind === 'partial' ? (
            <IconAlertTriangle size={13} />
          ) : entry.recovery.kind === 'record-only' ? (
            <IconX size={13} />
          ) : (
            <IconEye size={13} />
          )}
          <span>{entry.recovery.label}</span>
        </button>
      )}
      {selectable && entry.restorable && (
        <Button
          variant="ghost"
          icon
          onClick={onRestore}
          disabled={disabled || busy}
          title={entry.recovery.reason}
          data-testid={restoreId}
        >
          <IconRefresh size={15} />
        </Button>
      )}
    </div>
  )
}
