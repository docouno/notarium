import { type ReactNode } from 'react'
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
  className,
  'data-testid': testId,
}: {
  children: ReactNode
  variant?: NoticeVariant
  className?: string
  'data-testid'?: string
}) => (
  <div
    role={variant === 'error' ? 'alert' : 'status'}
    className={cx(styles.notice, styles[variant], className)}
    data-testid={testId}
  >
    {children}
  </div>
)
