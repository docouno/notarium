import { type ReactNode } from 'react'
import { cx } from '../../libs/cx/cx'
import { ASIDE_PANEL, usePanelWidth } from '../../libs/hooks/usePanelWidth'
import { Tabs } from '../Tabs'
import styles from './Aside.module.scss'

// Generic right-docked aside: a system panel whose *content* is decided by the
// caller (the local graph while reading, the note's metadata while editing). It
// owns only the shell — width + horizontal resize (persisted) + a header with a
// title and a caller-supplied action (the panel toggle, which doubles as the
// collapse control). Content-specific controls live in `children`.
//
// The header is either a plain `title` or, when the caller passes `tabs`, a tab
// strip ({ id, label }[] + activeTab/onTabChange) — a minimal base for panels that
// host more than one view (the graph's Filters | Search). The caller still swaps
// `children` per active tab; the aside only owns the strip.
type AsideTab = { id: string; label: string }

type AsideProps = {
  title?: ReactNode
  tabs?: AsideTab[] | null
  activeTab?: string | null
  onTabChange?: (id: string) => void
  headerAction?: ReactNode
  children?: ReactNode
}

export const Aside = ({
  title = null,
  tabs = null,
  activeTab = null,
  onTabChange,
  headerAction = null,
  children,
}: AsideProps) => {
  const [width, startResize] = usePanelWidth(ASIDE_PANEL)

  return (
    <aside className={styles.aside} style={{ width }}>
      <div className={styles.asideResize} onMouseDown={startResize} />
      <div className={cx(styles.asideHead, 'glass', 'glass-edge-bottom')}>
        {tabs ? (
          <Tabs
            className={styles.asideTabs}
            variant="header"
            value={activeTab ?? tabs[0]?.id ?? ''}
            options={tabs.map((tab) => ({ value: tab.id, label: tab.label }))}
            onChange={(id) => onTabChange?.(id)}
            ariaLabel="Panel views"
          />
        ) : (
          <span className={styles.asideTitle}>{title}</span>
        )}
        {headerAction && <div className={styles.asideAction}>{headerAction}</div>}
      </div>
      <div className={styles.asideBody}>{children}</div>
    </aside>
  )
}
