import { type ReactNode, useRef, useState } from 'react'
import { ContextMenu, type MenuItem } from '../../core/ContextMenu'
import { IconAward, IconBotMessage, IconDrama, IconHistory } from '../../core/Icons'
import { cx } from '../../libs/cx/cx'
import { type AgentsExplorerDataset, useAgentsExplorer } from '../AgentsExplorerProvider'
import styles from './Sidebar.module.scss'

/** How each dataset presents itself — the button caption and the menu row are the
 *  SAME answer, so they read it from one place. Exhaustive by type: a dataset added
 *  to the explorer cannot reach this picker without a word and an icon. */
const DATASETS: ReadonlyArray<{
  id: AgentsExplorerDataset
  label: string
  icon: ReactNode
}> = [
  { id: 'roles', label: 'Roles', icon: <IconDrama size={14} /> },
  { id: 'skills', label: 'Skills', icon: <IconAward size={14} /> },
  { id: 'memory', label: 'Memory', icon: <IconBotMessage size={14} /> },
  { id: 'sessions', label: 'Sessions', icon: <IconHistory size={14} /> },
]

export const AgentsExplorerPicker = () => {
  const { dataset, mode, selectManual } = useAgentsExplorer()
  const ref = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const items: MenuItem[] = DATASETS.map((entry) => ({
    label: entry.label,
    radioGroup: 'Explorer dataset',
    icon: entry.icon,
    active: dataset === entry.id,
    onClick: () => selectManual(entry.id),
  }))
  const rect = open && ref.current ? ref.current.getBoundingClientRect() : null

  return (
    <>
      <button
        ref={ref}
        className={cx(styles.scopePicker, open && styles.menuOpen)}
        data-testid="agents-explorer-picker"
        data-dataset={dataset}
        data-mode={mode}
        title="Switch Agents explorer dataset"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className={styles.navSectionTitle}>
          {DATASETS.find((entry) => entry.id === dataset)?.label ?? dataset}
        </span>
      </button>
      {rect && (
        <ContextMenu
          x={rect.left}
          y={rect.bottom + 4}
          ignoreRef={ref}
          items={items}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}
