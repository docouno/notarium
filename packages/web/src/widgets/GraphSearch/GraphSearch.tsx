import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useRef, useState } from 'react'
import { IconSearch, IconX } from '../../core/Icons'
import { cx } from '../../libs/cx/cx'
import styles from './GraphSearch.module.scss'

// Graph locator panel (the aside's "Search" tab). Typing spotlights every match on
// the canvas (driven by the parent); the full ranked list lives here for pick-by-name
// — field pinned at top, results scroll below. ↑/↓ + Enter (or a click) jumps the
// camera to one and keeps it focused. The list sits in the aside on purpose: a
// dropdown over the canvas hid the very nodes it was lighting up. It's a navigation
// tool, separate from the global note search (#31), which opens notes in the editor.
// Structural node shape this panel renders (a slice of the graph node). Kept
// local so the widget stays decoupled from the GraphView composer that derives it.
type GraphSearchNode = { id: string; title?: string; folder?: string; ghost?: boolean }

type GraphSearchProps<N extends GraphSearchNode> = {
  query: string
  onQueryChange: (value: string) => void
  onClear: () => void
  results: N[]
  matchCount: number
  hiddenCount: number
  colorOf: (n: N) => string
  onPick: (n: N) => void
  activeId?: string | null
  focusNode?: N | null
  focusNeighbors?: N[]
  onClearFocus?: () => void
  onRowHover?: (id: string | null) => void
}

export const GraphSearch = <N extends GraphSearchNode>({
  query,
  onQueryChange,
  onClear,
  results,
  matchCount,
  hiddenCount,
  colorOf,
  onPick,
  activeId,
  focusNode,
  focusNeighbors = [],
  onClearFocus,
  onRowHover,
}: GraphSearchProps<N>) => {
  const [active, setActive] = useState(0)
  // Mouse hover is pure CSS (:hover) — transient, gone when the cursor leaves. The
  // keyboard cursor (`active`) is a separate, persistent thing, shown only while
  // actually navigating by keyboard; otherwise a hovered row would stay lit after
  // the mouse left the panel.
  const [kbd, setKbd] = useState(true)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)

  // Focus the field when the tab opens (this component mounts with the tab).
  useEffect(() => {
    inputRef.current?.focus()
  }, [])
  // A fresh result set: reset the cursor to the top match (the Enter target) and
  // show it, since typing is keyboard input.
  useEffect(() => {
    setActive(0)
    setKbd(true)
  }, [results])
  // Follow the keyboard cursor through a long, scrolling list.
  useEffect(() => {
    if (kbd) {
      listRef.current
        ?.querySelector(`.${styles.gsearchResult}.${styles.active}`)
        ?.scrollIntoView({ block: 'nearest' })
    }
  }, [active, kbd])

  const pick = (n: N) => {
    if (n) {
      onPick(n)
    }
  }

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setKbd(true)
      setActive((i) => Math.min(i + 1, results.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setKbd(true)
      setActive((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      pick(results[active])
    } else if (e.key === 'Escape' && query) {
      e.preventDefault()
      onClear()
    }
  }

  const hasQuery = query.trim().length > 0

  // One node row — shared by the search results and the focus connections list, so
  // both read identically (swatch + title + folder, picked-state highlight).
  const nodeRow = (n: N, isActive = false) => (
    <button
      className={cx(
        styles.gsearchResult,
        isActive && styles.active,
        n.id === activeId && styles.picked,
      )}
      onClick={() => pick(n)}
      onMouseEnter={() => onRowHover?.(n.id)}
    >
      <span
        className={styles.gsearchSwatch}
        style={
          n.ghost
            ? { background: 'transparent', border: '1px dashed var(--text-faint)' }
            : { background: colorOf(n) }
        }
      />
      <span className={styles.gsearchText}>
        <span className={styles.gsearchTitle}>{n.title || n.id}</span>
        <span className={styles.gsearchPath}>{n.ghost ? 'Unresolved link' : n.folder || '—'}</span>
      </span>
    </button>
  )

  return (
    <div className={styles.gsearch}>
      <div className={styles.gsearchHead}>
        <div className={styles.gsearchField}>
          <IconSearch size={15} />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Find in graph…"
            spellCheck={false}
          />
          {hasQuery && (
            <button
              className={styles.gsearchClear}
              onClick={onClear}
              title="Clear (Esc)"
              aria-label="Clear search"
            >
              <IconX size={13} />
            </button>
          )}
        </div>
      </div>

      {/* Head holds only the field; below it, BOTH search and focus build the same way
          — gf-section header(s) + list(s) in one scrolling body — so the two views sit
          on an identical grid and gap under the input. */}
      {hasQuery ? (
        results.length === 0 ? (
          <div className={styles.gsearchEmpty}>
            <p>No matches in view{hiddenCount > 0 ? `, ${hiddenCount} hidden by filters` : ''}.</p>
          </div>
        ) : (
          <div className={styles.gsearchBody} onMouseLeave={() => onRowHover?.(null)}>
            <div className="gf-section">
              <span>
                {matchCount} {matchCount === 1 ? 'match' : 'matches'}
                {hiddenCount > 0 && (
                  <span className="muted">&nbsp;·&nbsp;{hiddenCount} hidden</span>
                )}
              </span>
            </div>
            <ul
              className={styles.gsearchList}
              ref={listRef}
              onMouseMove={() => kbd && setKbd(false)}
              onMouseLeave={() => onRowHover?.(null)}
            >
              {results.map((n, i) => (
                <li key={n.id}>{nodeRow(n, kbd && i === active)}</li>
              ))}
            </ul>
          </div>
        )
      ) : focusNode ? (
        // No active search but a note is pinned: the tab becomes its control panel —
        // the focused note + the notes it connects to (the canvas "star" as a navigable
        // list; click walks the focus), with its own clear action.
        <div className={styles.gsearchBody} onMouseLeave={() => onRowHover?.(null)}>
          <div className="gf-section">
            <span>Focused</span>
            <button
              className="gf-section-reset"
              onClick={onClearFocus}
              title="Clear focus"
              aria-label="Clear focus"
            >
              <IconX size={13} />
            </button>
          </div>
          <ul className={styles.gsearchList} onMouseLeave={() => onRowHover?.(null)}>
            <li>{nodeRow(focusNode)}</li>
          </ul>
          {focusNeighbors.length > 0 && (
            <>
              <div className="gf-section">
                <span>
                  Connections<span className="muted">&nbsp;·&nbsp;{focusNeighbors.length}</span>
                </span>
              </div>
              <ul className={styles.gsearchList} onMouseLeave={() => onRowHover?.(null)}>
                {focusNeighbors.map((n) => (
                  <li key={n.id}>{nodeRow(n)}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      ) : (
        <div className={styles.gsearchEmpty}>
          <IconSearch size={22} />
          <p>Matches light up on the graph as you type.</p>
        </div>
      )}
    </div>
  )
}
