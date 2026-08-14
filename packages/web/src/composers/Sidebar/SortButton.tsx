import { useRef, useState } from 'react'
import type { NoteSort, SortDir } from '@notarium/contract'
import { NOTE_SORT, SORT_DIR } from '@notarium/contract/enums'
import { ContextMenu, type MenuItem } from '../../core/ContextMenu'
import { IconArrowUpDown } from '../../core/Icons'
import { cx } from '../../libs/cx/cx'
import styles from './Sidebar.module.scss'

const FIELD_LABEL: Record<NoteSort, string> = {
  [NOTE_SORT.title]: 'Name',
  [NOTE_SORT.modified]: 'Modified',
  [NOTE_SORT.created]: 'Created',
}

export const SortButton = ({
  sort,
  dir,
  onSort,
  onDir,
}: {
  sort: NoteSort
  dir: SortDir
  onSort: (sort: NoteSort) => void
  onDir: (dir: SortDir) => void
}) => {
  const ref = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const items: MenuItem[] = [
    {
      label: 'Name',
      radioGroup: 'Sort field',
      active: sort === NOTE_SORT.title,
      onClick: () => onSort(NOTE_SORT.title),
    },
    {
      label: 'Modified',
      radioGroup: 'Sort field',
      active: sort === NOTE_SORT.modified,
      onClick: () => onSort(NOTE_SORT.modified),
    },
    {
      label: 'Created',
      radioGroup: 'Sort field',
      active: sort === NOTE_SORT.created,
      onClick: () => onSort(NOTE_SORT.created),
    },
    { divider: true },
    {
      label: 'Ascending',
      radioGroup: 'Sort direction',
      active: dir === SORT_DIR.asc,
      onClick: () => onDir(SORT_DIR.asc),
    },
    {
      label: 'Descending',
      radioGroup: 'Sort direction',
      active: dir === SORT_DIR.desc,
      onClick: () => onDir(SORT_DIR.desc),
    },
  ]
  const rect = open && ref.current ? ref.current.getBoundingClientRect() : null
  const direction = dir === SORT_DIR.asc ? 'ascending' : 'descending'

  return (
    <>
      <button
        ref={ref}
        className={cx(styles.iconBtn, open && styles.menuOpen)}
        title={`Sort: ${FIELD_LABEL[sort]}, ${direction}`}
        aria-label={`Sort explorer: ${FIELD_LABEL[sort]}, ${direction}`}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="explorer-sort"
        onClick={() => setOpen((current) => !current)}
      >
        <IconArrowUpDown size={16} />
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
