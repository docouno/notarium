import { type ReactNode } from 'react'
import styles from './MiniStat.module.scss'

// A "big number + label" tile, shared by the Feed aside and the graph Filters
// tab. `of` renders a muted "/total" after the value (a count narrowed by
// filters). `MiniStats` is the reflowing row container; callers that need their
// own padded row drop bare <MiniStat> tiles into it instead.

export const MiniStat = ({
  value,
  of,
  label,
}: {
  value: ReactNode
  of?: ReactNode
  label: ReactNode
}) => (
  <div className={styles.miniStat}>
    <span className={styles.miniStatNum}>
      {value}
      {of != null && <span className={styles.miniStatOf}>/{of}</span>}
    </span>
    <span className={styles.miniStatLabel}>{label}</span>
  </div>
)

export const MiniStats = ({ children }: { children: ReactNode }) => (
  <div className={styles.miniStats}>{children}</div>
)
