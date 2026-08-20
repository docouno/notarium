import {
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Link } from 'react-router'
import type { MemoryCategory, ProjectRow } from '@notarium/contract'
import { comparatorFor, type SortFields } from '@notarium/core'
import { EmptyState } from '../../core/EmptyState'
import { IconBotMessage, IconChevron, IconDoc, IconFolderKanban, IconUser } from '../../core/Icons'
import { cx } from '../../libs/cx/cx'
import { memoryNoteRoute } from '../../libs/routing/routePaths'
import { api } from '../../services/api'
import { TreeState } from '../../widgets/TreeState'
import { useAgentsExplorer } from '../AgentsExplorerProvider'
import { useNotes } from '../NotesProvider'
import { useProjects } from '../ProjectsProvider'
import { useSpace } from '../SpaceProvider'
import { ExplorerVirtualRows } from './ExplorerVirtualRows'
import styles from './MemoryTree.module.scss'
import tree from './Sidebar.module.scss'

// The agent-memory audit in the explorer (#165): the «Memory» scope of the same
// explorer, rendered with the SAME tree rows as the file tree — no bespoke styling
// per case. It just shows the ACTIVE memory content: the Personal (about-user) axis
// and each project that HAS memory, as plain folder rows; their categories beneath
// as plain note rows linking to the note (the reader owns read/edit/history). No
// counters, no per-project empty buckets, no muted dimming — steering (mute/load)
// lives in the Context constructor, not the explorer.

const USER_KEY = '__user__'
const MEMORY_SORT_FIELDS: SortFields<MemoryCategory> = {
  title: (category) => category.category,
  stableKey: (category) => category.noteId,
  createdAt: (category) => category.createdAt,
  modifiedAt: (category) => category.modifiedAt,
}
type Axis = {
  key: string
  contextScope: string
  label: string
  icon: 'user' | 'project'
  cats: MemoryCategory[]
  failed?: boolean
}
type MemoryRow =
  | { kind: 'axis'; axis: Axis; depth: number }
  | { kind: 'leaf'; axis: Axis; cat: MemoryCategory; depth: number }
  | { kind: 'error'; axis: Axis; depth: number }

const projectAxisLabel = (project: ProjectRow) => {
  if (!project.path) {
    return 'Space root'
  }

  return project.displayName || project.path.split('/').filter(Boolean).at(-1) || project.slug
}

export const MemoryTree = ({
  activeId,
  scrollRef,
  visible,
  headH,
}: {
  activeId: string | null
  scrollRef: RefObject<HTMLDivElement | null>
  visible: boolean
  headH: number
}) => {
  const { space } = useSpace()
  const { projects } = useProjects()
  const { versions } = useAgentsExplorer()
  const { explorerSort, explorerSortDir } = useNotes()
  const [axes, setAxes] = useState<Axis[] | null>(null)
  // Track only the CLOSED axes — everything is open by default so the content is
  // visible the moment the surface loads.
  const [closed, setClosed] = useState<Set<string>>(new Set())
  const seq = useRef(0)

  const load = useCallback(async () => {
    const my = ++seq.current
    // During a note-driven space switch (#16), ProjectsProvider may still hold
    // the previous space's rows for one render. Never query memory endpoints with
    // a project id that belongs to another space — it only produces anti-enum 404s.
    const projList = (projects ?? []).filter((p) => p.space === space)
    const user = api
      .meMemoryGet({ sort: explorerSort, dir: explorerSortDir })
      .then((cats): Axis => ({
        key: USER_KEY,
        contextScope: 'personal',
        label: 'Personal',
        icon: 'user',
        cats,
      }))
      .catch((): Axis => ({
        key: USER_KEY,
        contextScope: 'personal',
        label: 'Personal',
        icon: 'user',
        cats: [],
        failed: true,
      }))
    const projAxes = projList.map((p) =>
      api
        .projectMemoryGet(space, p.id, { sort: explorerSort, dir: explorerSortDir })
        .then((cats): Axis => ({
          key: p.id,
          contextScope: p.slug,
          label: projectAxisLabel(p),
          icon: 'project',
          cats,
        }))
        .catch((): Axis => ({
          key: p.id,
          contextScope: p.slug,
          label: projectAxisLabel(p),
          icon: 'project',
          cats: [],
          failed: true,
        })),
    )
    const next = await Promise.all([user, ...projAxes])

    if (my !== seq.current) {
      return
    }
    // The explorer shows what EXISTS: keep an axis only when it has memory (or
    // failed to load — that we must surface, not silently hide).
    setAxes(next.filter((ax) => ax.cats.length > 0 || ax.failed))
  }, [space, projects, explorerSort, explorerSortDir])

  // Changing the shared explorer order must not flash a loading state or wait
  // for the network. Reorder the held categories before paint, invalidate any
  // response issued under the old preference, then let load() reconcile.
  useLayoutEffect(() => {
    seq.current += 1
    setAxes(
      (current) =>
        current?.map((axis) => ({
          ...axis,
          cats: [...axis.cats].sort(
            comparatorFor(explorerSort, explorerSortDir, MEMORY_SORT_FIELDS),
          ),
        })) ?? null,
    )
  }, [explorerSort, explorerSortDir])

  useEffect(() => {
    void load()
  }, [load, versions.memory])

  useEffect(() => {
    if (!activeId || !axes) {
      return
    }
    const owner = axes.find((ax) => ax.cats.some((cat) => cat.noteId === activeId))?.key

    if (!owner) {
      return
    }
    setClosed((prev) => {
      if (!prev.has(owner)) {
        return prev
      }
      const next = new Set(prev)
      next.delete(owner)
      return next
    })
  }, [activeId, axes])

  const toggle = (key: string) =>
    setClosed((prev) => {
      const n = new Set(prev)

      if (n.has(key)) {
        n.delete(key)
      } else {
        n.add(key)
      }

      return n
    })

  const rows = useMemo(() => {
    if (!axes) {
      return []
    }
    const next: MemoryRow[] = []

    for (const ax of axes) {
      next.push({ kind: 'axis', axis: ax, depth: 0 })
      if (closed.has(ax.key)) {
        continue
      }
      if (ax.failed) {
        next.push({ kind: 'error', axis: ax, depth: 1 })
      } else {
        for (const cat of ax.cats) {
          next.push({ kind: 'leaf', axis: ax, cat, depth: 1 })
        }
      }
    }

    return next
  }, [axes, closed])

  // The memory tree wears the same lifecycle skin as the file tree (#220): a
  // still-loading fetch shows shimmer rows, no memory yet shows the shared empty.
  // A per-AXIS load failure is NOT a whole-tree error — it stays an inline row
  // below its axis (the `error` row), so a failed Personal axis doesn't blank a
  // healthy project axis; hence no `error` status here.
  const status = !axes ? 'loading' : axes.length === 0 ? 'empty' : 'ready'

  return (
    <TreeState
      status={status}
      skeletonRows={4}
      empty={
        <EmptyState
          variant="bare"
          icon={<IconBotMessage size={18} />}
          title="Nothing remembered yet."
          testId="memory-tree-empty"
        />
      }
    >
      <div data-testid="memory-tree">
        <ExplorerVirtualRows
          rows={rows}
          scrollRef={scrollRef}
          visible={visible}
          headH={headH}
          activeId={activeId}
          getKey={(row) =>
            row.kind === 'axis'
              ? `axis:${row.axis.key}`
              : row.kind === 'leaf'
                ? `leaf:${row.cat.noteId}`
                : `error:${row.axis.key}`
          }
          isActive={(row, id) => row.kind === 'leaf' && row.cat.noteId === id}
          renderRow={(row) => {
            if (row.kind === 'axis') {
              const isOpen = !closed.has(row.axis.key)
              return (
                <div
                  className={tree.navItem}
                  data-testid="memory-axis"
                  role="treeitem"
                  aria-level={row.depth + 1}
                  aria-expanded={isOpen}
                >
                  <button
                    className={tree.chevBtn}
                    onClick={() => toggle(row.axis.key)}
                    aria-label="Toggle"
                  >
                    <span className={cx(tree.chev, isOpen && tree.open)}>
                      <IconChevron size={13} />
                    </span>
                  </button>
                  <button className={tree.navItemBtn} onClick={() => toggle(row.axis.key)}>
                    {row.axis.icon === 'user' ? (
                      <IconUser size={15} />
                    ) : (
                      <IconFolderKanban size={15} />
                    )}
                    <span className={tree.navLabel} title={row.axis.label}>
                      {row.axis.label}
                    </span>
                  </button>
                </div>
              )
            }
            if (row.kind === 'error') {
              return (
                <div
                  className={tree.navItem}
                  style={{ paddingLeft: row.depth * 12 }}
                  role="treeitem"
                  aria-level={row.depth + 1}
                >
                  <span className={tree.chevSpacer} />
                  <span className={cx(tree.navItemBtn, tree.noteRow, styles.failedRow)}>
                    <IconBotMessage size={14} />
                    <span className={tree.navLabel}>Couldn’t load.</span>
                  </span>
                </div>
              )
            }
            const active = activeId === row.cat.noteId
            return (
              <div
                className={cx(tree.navItem, active && tree.active)}
                style={{ paddingLeft: row.depth * 12 }}
                data-testid="memory-leaf"
                role="treeitem"
                aria-level={row.depth + 1}
              >
                <span className={tree.chevSpacer} />
                <Link
                  to={memoryNoteRoute(row.cat.noteId, undefined, row.axis.contextScope) ?? '#'}
                  className={cx(tree.navItemBtn, tree.noteRow)}
                  aria-current={active ? 'page' : undefined}
                  title={row.cat.summary || row.cat.category}
                >
                  <IconDoc size={14} />
                  <span className={tree.navLabel}>{row.cat.category}</span>
                </Link>
              </div>
            )
          }}
        />
      </div>
    </TreeState>
  )
}
