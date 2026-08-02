import { type HTMLAttributes } from 'react'
import { cx } from '../../libs/cx/cx'
import styles from './StickyBar.module.scss'

// Reusable sticky strip over scrolling content: translucent blurred backdrop,
// hairline bottom border, the topbar's horizontal rhythm (--gutter padding).
// Presentational only — callers lay out their own children (groups pushed to
// opposite edges via flex). First consumer: the revision-view banner (#12).
type StickyBarProps = HTMLAttributes<HTMLDivElement>

export const StickyBar = ({ className, children, ...rest }: StickyBarProps) => (
  <div className={cx(styles.bar, 'glass', 'glass-edge-bottom', className)} {...rest}>
    {children}
  </div>
)
