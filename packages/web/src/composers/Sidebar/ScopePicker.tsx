import { useRef, useState } from 'react'
import type { ProjectRow } from '@notarium/contract'
import { ContextMenu, type MenuItem } from '../../core/ContextMenu'
import { IconFolderKanban, IconLayers, IconStar } from '../../core/Icons'
import { cx } from '../../libs/cx/cx'
import type { ExplorerScope } from '../../libs/tree/tree'
import styles from './Sidebar.module.scss'

// The explorer's view selector (#164): the FILES header doubles as a two-mode
// picker — Files (the whole space) or Projects (only marked projects) — plus up to
// five RECENTLY-FOCUSED projects as quick-jumps (a client-side MRU, so the list
// stays short and scales no matter how many projects exist). It does NOT enumerate
// ALL projects (a flat list doesn't scale); a project not yet in recents is focused
// from its row's context menu ("Focus project"). When focused, the header shows the
// project's name. No chevron — the label's hover pill is the affordance.
export const ScopePicker = ({
  scope,
  projects,
  recent,
  onPick,
  onFocus,
}: {
  scope: ExplorerScope
  projects: ProjectRow[]
  recent: ProjectRow[]
  onPick: (next: ExplorerScope) => void
  onFocus: (path: string) => void
}) => {
  const ref = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const focused = scope.kind === 'project' ? projects.find((p) => p.path === scope.path) : undefined
  const label =
    scope.kind === 'files'
      ? 'Files'
      : scope.kind === 'projects'
        ? 'Projects'
        : scope.kind === 'favorites'
          ? 'Favorites'
          : (focused?.displayName ?? 'Project')
  const items: MenuItem[] = [
    {
      label: 'Files',
      radioGroup: 'Explorer scope',
      icon: <IconLayers size={14} />,
      active: scope.kind === 'files',
      onClick: () => onPick({ kind: 'files' }),
    },
    {
      label: 'Projects',
      radioGroup: 'Explorer scope',
      icon: <IconFolderKanban size={14} />,
      active: scope.kind === 'projects',
      onClick: () => onPick({ kind: 'projects' }),
    },
    {
      label: 'Favorites',
      radioGroup: 'Explorer scope',
      icon: <IconStar size={14} />,
      active: scope.kind === 'favorites',
      onClick: () => onPick({ kind: 'favorites' }),
    },
    ...(recent.length
      ? [
          { divider: true, radioGroup: 'Explorer scope' } as MenuItem,
          ...recent.map((p) => ({
            label: p.displayName,
            radioGroup: 'Explorer scope',
            icon: <IconFolderKanban size={14} />,
            active: scope.kind === 'project' && scope.path === p.path,
            onClick: () => onFocus(p.path),
          })),
        ]
      : []),
  ]
  const rect = open && ref.current ? ref.current.getBoundingClientRect() : null
  return (
    <>
      <button
        ref={ref}
        className={cx(styles.scopePicker, open && styles.menuOpen)}
        data-testid="explorer-scope"
        data-scope={scope.kind}
        title="Switch view: Files / Projects"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={styles.navSectionTitle}>{label}</span>
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
