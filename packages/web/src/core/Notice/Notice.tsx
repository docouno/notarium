import { type CSSProperties, type ReactNode } from 'react'
import type { FieldColor } from '@notarium/contract'
import { cx } from '../../libs/cx/cx'
import styles from './Notice.module.scss'

export type NoticeVariant = 'error' | 'info' | 'success' | 'warning'

// A tinted inline banner (#28) — the shared strip for a short status/feedback
// line that sits in the page flow (form errors, hints), as opposed to a modal
// (Dialog.alert) or the one-time SecretReveal. Tone via `variant`; an error reads
// to assistive tech as an alert, the rest as a polite status.
export const Notice = ({
  children,
  variant = 'info',
  color,
  className,
  id,
  'data-testid': testId,
}: {
  children: ReactNode
  variant?: NoticeVariant
  color?: FieldColor
  className?: string
  id?: string
  'data-testid'?: string
}) => (
  <div
    id={id}
    role={variant === 'error' ? 'alert' : 'status'}
    className={cx(styles.notice, styles[variant], color && styles.colored, className)}
    style={
      color
        ? ({
            '--notice-solid': `var(--field-color-${color})`,
            '--notice-fg': `var(--field-color-${color}-fg)`,
            '--notice-surface': `var(--field-color-${color}-surface)`,
            '--notice-border': `var(--field-color-${color}-border)`,
          } as CSSProperties)
        : undefined
    }
    data-testid={testId}
  >
    {children}
  </div>
)
