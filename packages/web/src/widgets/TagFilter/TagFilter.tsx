import { useEffect, useMemo, useState } from 'react'
import type { TagFacet } from '@notarium/contract'
import { FacetChip } from '../../core/FacetChip'
import { IconChevron, IconSearch, IconX } from '../../core/Icons'
import { cx } from '../../libs/cx/cx'
import { nestFolders, type SkeletonNode } from '../../libs/tree/tree'
import styles from './TagFilter.module.scss'

// The tag facet (#109) as the shared, compact tag PANE — used identically in the
// Feed aside and the Graph filters. The full tag tree got unusably tall on a real
// base and the graph's flat chip cloud lost hierarchy, so the middle ground is
// HIERARCHICAL CHIPS: top-level tags as a wrapping, count-sorted chip cloud, each
// parent with a ▾ that reveals its children as an indented sub-row, a search box
// to jump to any tag, and a top-N cut with "show more". The interaction is the
// app's one filter language — INCLUSION: nothing selected = no filter, a click ADDS
// a tag (highlighted), another click removes it; the server/graph match is
// hierarchical (picking `ml` pulls `ml/nlp`) and OR across the selected set.
const DEFAULT_TOP_N = 20
const SEARCH_CAP = 60
// Below this many distinct tags the whole cloud fits at a glance, so a search box
// would just be noise — show it only once the vocabulary is genuinely large.
const SEARCH_THRESHOLD = 12

type TagFilterProps = {
  /** The space's tag facet (folded `tag` path + display `label` + counts). */
  tags: TagFacet[]
  /** The folded tags currently in the filter (a click adds/removes one). */
  selected: ReadonlySet<string>
  /** Toggle a tag (its folded path) in/out of the filter. */
  onToggle: (tag: string) => void
  /** Clear the whole tag filter. */
  onClear: () => void
  /** Self-pad the section on the --gutter (the Feed aside, beside the self-padded
   *  FolderFilter). `false` when the host already pads (the Graph's `.gf` body). */
  padded?: boolean
  /** Skip the "Tags" head + reset — the host owns them (the Graph pairs the chips
   *  with a tri-state under one shared "Tags" section header). */
  hideHead?: boolean
  testId?: string
}

// Count-sorted nesting: nestFolders needs parent-before-child (path order), then
// each level is re-sorted most-used-first (the chip cloud's natural order).
const nestByCount = (tags: TagFacet[]): SkeletonNode[] => {
  const flat = [...tags]
    .map((t) => ({ name: t.label, path: t.tag, count: t.count, direct: t.direct }))
    .sort((a, b) => a.path.localeCompare(b.path))
  const roots = nestFolders(flat)

  const sortRec = (arr: SkeletonNode[]) => {
    arr.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    for (const n of arr) {
      sortRec(n.children)
    }
  }
  sortRec(roots)
  return roots
}

export const TagFilter = ({
  tags,
  selected,
  onToggle,
  onClear,
  padded = true,
  hideHead = false,
  testId,
}: TagFilterProps) => {
  const roots = useMemo(() => nestByCount(tags), [tags])

  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [showAll, setShowAll] = useState(false)

  // Reveal the ancestor chain of every selected tag, so a deep-linked `?tag=a/b`
  // (or a graph selection of a child) shows its chip even when the parent's
  // sub-row started collapsed. Never auto-collapses the user's own expansions.
  useEffect(() => {
    if (selected.size === 0) {
      return
    }
    setExpanded((prev) => {
      const next = new Set(prev)

      for (const sel of selected) {
        let acc = ''

        for (const seg of sel.split('/')) {
          acc = acc ? `${acc}/${seg}` : seg
          next.add(acc)
        }
      }

      return next
    })
  }, [selected])

  const toggleExpand = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)

      if (next.has(path)) {
        next.delete(path)
      } else {
        next.add(path)
      }

      return next
    })

  // Search collapses the hierarchy to a flat, count-sorted match list (folded path
  // OR label substring) — the fast path to any tag on a big base.
  const q = query.trim().toLowerCase()
  const matches = useMemo(() => {
    if (!q) {
      return []
    }

    return [...tags]
      .filter((t) => t.tag.includes(q) || t.label.toLowerCase().includes(q))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
      .slice(0, SEARCH_CAP)
  }, [tags, q])

  if (!roots.length) {
    return null
  }

  // Search earns its keep only on a large vocabulary (a handful of tags fits at a
  // glance). Below the threshold it's hidden and `q` stays empty (the tree path).
  const showSearch = tags.length > SEARCH_THRESHOLD

  // One chip: a pill that toggles the tag, plus a separate ▾ action when it has children.
  const Chip = ({ node }: { node: SkeletonNode }) => {
    const on = selected.has(node.path)
    const hasKids = node.children.length > 0
    const open = expanded.has(node.path)
    return (
      <FacetChip
        icon="#"
        label={node.name}
        count={node.count}
        selected={on}
        onClick={() => onToggle(node.path)}
        title={node.path}
        trailingAction={
          hasKids
            ? {
                icon: <IconChevron size={12} />,
                ariaLabel: `${open ? 'Collapse' : 'Expand'} ${node.name}`,
                expanded: open,
                onClick: () => toggleExpand(node.path),
              }
            : undefined
        }
      />
    )
  }

  // An expanded parent's children render as a labelled, indented sub-row below the
  // cloud; a child that's itself expanded recurses one level deeper. Depth-first so
  // the blocks read top-down in the same order the parent chips appear.
  const renderExpandedBlocks = (nodes: SkeletonNode[], depth: number): React.ReactNode =>
    nodes
      .filter((n) => n.children.length > 0 && expanded.has(n.path))
      .map((n) => (
        <div
          key={n.path}
          className={styles.sub}
          style={{ '--depth': depth } as React.CSSProperties}
        >
          <div className={styles.subHead}>
            <span className={styles.subBranch}>↳</span>
            <span className={styles.subHash}>#</span>
            {n.name}
          </div>
          <div className={styles.cloud}>
            {n.children.map((c) => (
              <Chip key={c.path} node={c} />
            ))}
          </div>
          {renderExpandedBlocks(n.children, depth + 1)}
        </div>
      ))

  const visibleRoots = showAll ? roots : roots.slice(0, DEFAULT_TOP_N)
  const hiddenCount = roots.length - visibleRoots.length

  return (
    <div className={cx(styles.tagFilter, padded && styles.padded)} data-testid={testId}>
      {!hideHead && (
        <div className={styles.head}>
          Tags
          <button
            className="gf-section-reset"
            onClick={onClear}
            disabled={selected.size === 0}
            title="Clear tag filter"
            aria-label="Clear tag filter"
            data-testid={testId ? `${testId}-reset` : undefined}
          >
            <IconX size={13} />
          </button>
        </div>
      )}

      {showSearch && (
        <div className={styles.search}>
          <IconSearch size={13} className={styles.searchIcon} />
          <input
            type="text"
            className={styles.searchInput}
            placeholder="Search tags…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            data-testid={testId ? `${testId}-search` : undefined}
          />
          {query && (
            <button
              type="button"
              className={styles.searchClear}
              onClick={() => setQuery('')}
              aria-label="Clear search"
            >
              <IconX size={12} />
            </button>
          )}
        </div>
      )}

      {showSearch && q ? (
        matches.length ? (
          <div className={styles.cloud}>
            {matches.map((m) => {
              const on = selected.has(m.tag)
              return (
                <FacetChip
                  key={m.tag}
                  icon="#"
                  label={m.tag}
                  count={m.count}
                  selected={on}
                  onClick={() => onToggle(m.tag)}
                  title={m.tag}
                />
              )
            })}
          </div>
        ) : (
          <div className={styles.empty}>No tags match “{query}”.</div>
        )
      ) : (
        <>
          <div className={styles.cloud}>
            {visibleRoots.map((n) => (
              <Chip key={n.path} node={n} />
            ))}
            {hiddenCount > 0 && (
              <button type="button" className={styles.more} onClick={() => setShowAll(true)}>
                show {hiddenCount} more
              </button>
            )}
            {showAll && roots.length > DEFAULT_TOP_N && (
              <button type="button" className={styles.more} onClick={() => setShowAll(false)}>
                show less
              </button>
            )}
          </div>
          {renderExpandedBlocks(visibleRoots, 0)}
        </>
      )}
    </div>
  )
}
