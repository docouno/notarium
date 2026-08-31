import type { CSSProperties } from 'react'

import styles from './InsertionPlaceholder.module.scss'

/** A shared list-reorder slot. It occupies the actual destination instead of
 * decorating both neighbouring items with competing edge indicators. */
export const InsertionPlaceholder = ({ height }: { height?: number }) => (
  <div
    className={styles.placeholder}
    data-testid="insertion-placeholder"
    aria-hidden="true"
    style={
      height ? ({ '--insertion-placeholder-height': `${height}px` } as CSSProperties) : undefined
    }
  />
)
