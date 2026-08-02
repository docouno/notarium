import { useState } from 'react'
import { Button } from '../Button'
import { IconCopy } from '../Icons'
import styles from './SecretReveal.module.scss'

// A one-time secret reveal (#28): the shared block for "copy this now, it won't
// be shown again" — invite/reset links and freshly minted API tokens. Primary-
// toned (not warning: it's an action to take, not a hazard), and the value sits
// on ONE line (scrolls sideways, never wraps) so a long URL/token stays readable.
export const SecretReveal = ({
  message,
  value,
  copyTitle = 'Copy',
  testId,
  valueTestId,
  copyTestId,
}: {
  message: string
  value: string
  copyTitle?: string
  testId?: string
  valueTestId?: string
  copyTestId?: string
}) => {
  const [copied, setCopied] = useState(false)

  const copy = () => {
    try {
      void navigator.clipboard?.writeText(value)
      setCopied(true)
    } catch {
      // clipboard unavailable — the value stays selectable by hand
    }
  }

  return (
    <div className={styles.reveal} data-testid={testId}>
      <p className={styles.message}>{message}</p>
      <div className={styles.row}>
        <code className={styles.value} data-testid={valueTestId}>
          {value}
        </code>
        <Button icon title={copyTitle} data-testid={copyTestId} onClick={copy}>
          <IconCopy size={14} />
        </Button>
      </div>
      {copied && <p className={styles.copied}>Copied.</p>}
    </div>
  )
}
