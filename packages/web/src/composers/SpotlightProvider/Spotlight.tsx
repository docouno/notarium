import {
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useNavigate } from 'react-router'
import { DEFAULT_NOTE_TYPE } from '@notarium/core'
import { effectiveSlug } from '@notarium/core/slug'
import { EmptyState } from '../../core/EmptyState'
import { IconDoc, IconSearch } from '../../core/Icons'
import { Modal } from '../../core/Modal'
import { Skeleton } from '../../core/Skeleton'
import { cx } from '../../libs/cx/cx'
import { compactDate, exactDateTime } from '../../libs/datetime'
import { highlightMatch } from '../../libs/highlight'
import { noteRoute } from '../../libs/routing/routePaths'
import { useNoteSuggestions } from '../search'
import styles from './Spotlight.module.scss'

// Spotlight — the centred quick-switcher overlay (#31). Replaces the rail's inline
// search: one keyboard-first surface (Cmd/Ctrl+P) over the hybrid backend (#81),
// with recents as the empty state. v1 is a NOTE switcher; the section/item model
// is the seam for a command-palette layer (decision #1) — a 'command' kind + a
// run() handler, not a reshape. Mounted in core/Modal (portal, backdrop, Escape,
// scroll-lock); selection lives here, keyboard drives everything. Its suggestions
// share useNoteSuggestions with the topbar OmniSearch (#190) — one search+recents
// data layer, two chromes.

type SpotlightItem = {
  kind: 'note' // the seam: a future 'command' kind lands a second section
  id: string
  title: string
  slug?: string
  filePath?: string
  modifiedAt: string | null
  createdAt: string | null
  noteType?: string
  snippet?: string
}

type Section = { key: string; label: string; items: SpotlightItem[] }

const dirOf = (p: string | null | undefined): string => {
  const i = (p || '').lastIndexOf('/')
  return i === -1 ? '' : (p as string).slice(0, i)
}

export const Spotlight = ({ space, onClose }: { space: string; onClose: () => void }) => {
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const optionRefs = useRef(new Map<number, HTMLDivElement>())

  const q = query.trim()
  // Search + recents come from the shared data layer (#190) — the debounce,
  // out-of-order guard, MRU∪recently-modified dedupe all live there.
  const { results, recent, searching } = useNoteSuggestions(space, query)

  const sections = useMemo<Section[]>(() => {
    if (q) {
      const items = (results ?? []).map<SpotlightItem>((r) => ({
        kind: 'note',
        id: r.id,
        title: r.title,
        filePath: r.filePath,
        modifiedAt: r.modifiedAt,
        createdAt: r.createdAt,
        noteType: r.noteType,
        snippet: r.snippet,
      }))
      return [{ key: 'notes', label: 'Notes', items }]
    }
    const items = recent.map<SpotlightItem>((n) => ({
      kind: 'note',
      id: n.id,
      title: n.title || n.filePath || 'Untitled',
      slug: n.slug,
      filePath: n.filePath,
      modifiedAt: n.modifiedAt,
      createdAt: n.createdAt,
      noteType: n.noteType,
    }))
    return [{ key: 'recent', label: 'Recent', items }]
  }, [q, results, recent])

  // One global running index across all sections — selection + scroll key on it.
  const indexed = useMemo(() => {
    let i = 0
    return sections.map((s) => ({ ...s, items: s.items.map((item) => ({ item, i: i++ })) }))
  }, [sections])
  const flat = useMemo(() => sections.flatMap((s) => s.items), [sections])
  const count = flat.length

  // Reset the highlight to the top whenever the visible list changes.
  useEffect(() => {
    setSelected(0)
  }, [q, results, recent])

  // Keep the highlighted row in view as ↑/↓ walk past the scroll edges.
  useEffect(() => {
    optionRefs.current.get(selected)?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  const openItem = useCallback(
    (item: SpotlightItem | undefined, newTab: boolean) => {
      if (!item) {
        return
      }
      const href = noteRoute(item.id, effectiveSlug(item.slug, item.title))

      if (!href) {
        return
      }
      if (newTab) {
        // Native new tab (#29) — the canonical /n/<id> route resolves on its own.
        window.open(href, '_blank', 'noopener,noreferrer')
        onClose()
        return
      }
      onClose()
      navigate(href) // the router's unsaved-edits blocker covers the transition
    },
    [navigate, onClose],
  )

  const onInputKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (count) {
        setSelected((s) => (s + 1) % count)
      }

      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (count) {
        setSelected((s) => (s - 1 + count) % count)
      }

      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      openItem(flat[selected], e.metaKey || e.ctrlKey)
      return
    }
    // Escape closes — Modal owns it at the window level (no per-key handling here).
  }

  const loading = q && searching && !(results && results.length)

  return (
    <Modal onClose={onClose} size="md" className={styles.panel} overlayClassName={styles.overlay}>
      <div className={styles.spotlight}>
        <div className={styles.head}>
          <IconSearch size={18} className={styles.headIcon} />
          <input
            className={styles.input}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder="Search notes…"
            spellCheck={false}
            autoComplete="off"
            autoFocus
            role="combobox"
            aria-label="Search notes"
            aria-expanded
            aria-controls="spotlight-list"
            aria-activedescendant={count ? `spotlight-opt-${selected}` : undefined}
            data-testid="spotlight-input"
          />
        </div>

        <div
          className={styles.body}
          id="spotlight-list"
          role="listbox"
          data-testid="spotlight-results"
        >
          {loading ? (
            <div className={styles.skeleton} aria-hidden="true" data-testid="spotlight-skeleton">
              {Array.from({ length: 6 }, (_, i) => (
                <div key={i} className={styles.skeletonRow}>
                  <Skeleton w={`${50 + ((i * 13) % 34)}%`} h={13} radius={4} />
                </div>
              ))}
            </div>
          ) : count === 0 ? (
            q ? (
              <EmptyState
                variant="bare"
                icon={<IconSearch size={18} />}
                title="No matches"
                hint={`Nothing matches “${q}”.`}
                testId="spotlight-empty"
              />
            ) : (
              <EmptyState
                variant="bare"
                icon={<IconSearch size={18} />}
                title="Search your notes"
                hint="Find by title, path or content."
                testId="spotlight-empty"
              />
            )
          ) : (
            indexed.map((section) => (
              // role=presentation so the listbox owns the option rows THROUGH this
              // grouping wrapper (otherwise AT may not expose the option set/position).
              <div key={section.key} className={styles.section} role="presentation">
                <div className={styles.sectionLabel} aria-hidden="true">
                  {section.label}
                </div>
                {section.items.map(({ item, i }) => {
                  const active = i === selected
                  const metaDate = item.createdAt ?? item.modifiedAt
                  const dir = dirOf(item.filePath)
                  const dateLabel = compactDate(metaDate)
                  const typeLabel = spotlightTypeLabel(item.noteType)
                  return (
                    <div
                      key={item.id}
                      id={`spotlight-opt-${i}`}
                      role="option"
                      aria-selected={active}
                      ref={(el) => {
                        if (el) {
                          optionRefs.current.set(i, el)
                        } else {
                          optionRefs.current.delete(i)
                        }
                      }}
                      className={cx(styles.row, active && styles.rowActive)}
                      onMouseMove={() => {
                        if (selected !== i) {
                          setSelected(i)
                        }
                      }}
                      onMouseDown={(e) => e.preventDefault()} // keep focus in the input
                      onClick={(e) => openItem(item, e.metaKey || e.ctrlKey)}
                      data-testid="spotlight-result"
                      data-id={item.id}
                    >
                      <IconDoc size={15} className={styles.rowIcon} />
                      <div className={styles.rowText}>
                        <div className={styles.rowTitle}>{highlightMatch(item.title, q)}</div>
                        {(dateLabel || dir || typeLabel) && (
                          <div className={styles.rowMeta}>
                            {dateLabel && (
                              <time
                                className={styles.rowMetaDate}
                                dateTime={metaDate ?? undefined}
                                title={exactDateTime(metaDate)}
                              >
                                {dateLabel}
                              </time>
                            )}
                            {dateLabel && dir && <span className={styles.rowMetaSep}>·</span>}
                            {dir && (
                              <span className={styles.rowMetaPath} title={item.filePath}>
                                {dir}
                              </span>
                            )}
                            {typeLabel && <span className={styles.rowMetaType}>{typeLabel}</span>}
                          </div>
                        )}
                        {item.snippet ? (
                          <div className={styles.rowSub}>{highlightMatch(item.snippet, q)}</div>
                        ) : null}
                      </div>
                    </div>
                  )
                })}
              </div>
            ))
          )}
        </div>

        <div className={styles.foot}>
          <span className={styles.hint}>
            <kbd>↑</kbd>
            <kbd>↓</kbd> navigate
          </span>
          <span className={styles.hint}>
            <kbd>↵</kbd> open
          </span>
          <span className={styles.hint}>
            <kbd>⌘</kbd>
            <kbd>↵</kbd> new tab
          </span>
          <span className={styles.hint}>
            <kbd>esc</kbd> close
          </span>
        </div>
      </div>
    </Modal>
  )
}

const spotlightTypeLabel = (noteType: string | undefined): string => {
  const t = (noteType || '').trim()
  return t && t.toLowerCase() !== DEFAULT_NOTE_TYPE ? t : ''
}
