import { type KeyboardEvent, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { effectiveSlug } from '@notarium/core/slug'
import { EmptyState } from '../../core/EmptyState'
import { IconDoc, IconSearch } from '../../core/Icons'
import { SearchField } from '../../core/SearchField'
import { Skeleton } from '../../core/Skeleton'
import { cx } from '../../libs/cx/cx'
import { highlightMatch } from '../../libs/highlight'
import { useDismiss } from '../../libs/hooks/useDismiss'
import { feedQueryRoute, feedRoute, noteRoute } from '../../libs/routing/routePaths'
import { type NoteSuggestion, useNoteSuggestions } from '../search'
import { useSpace } from '../SpaceProvider'
import styles from './OmniSearch.module.scss'

// OmniSearch (#190) — the cross-cutting topbar search: ONE field that does both
// halves of the search story without the old rail panel's mode-confusion.
//   • Type → a Spotlight-like dropdown of note suggestions (quick JUMP to a note).
//   • Enter (or the top "Search …" row) → the detailed search: land on the Feed
//     with `?q=` applied, where folder/tag filters, grouping and buckets compose
//     with the query (the q axis lives in the URL, see useFeedState).
// Suggestions ride the shared useNoteSuggestions hook (same data as Cmd+P); the
// Feed itself supplies `value`/`onSubmit` so editing the field drives its q in
// place, while Home (and anywhere else) falls back to navigating to the Feed.

const dirOf = (p: string | null | undefined): string => {
  const i = (p || '').lastIndexOf('/')
  return i === -1 ? '' : (p as string).slice(0, i)
}

type Row = { kind: 'submit' } | { kind: 'note'; sug: NoteSuggestion }

export const OmniSearch = ({
  value,
  onSubmit,
  placeholder = 'Search notes…',
  className,
}: {
  /** The current query to reflect (the Feed passes its URL `q`); '' elsewhere. */
  value?: string
  /** Apply the detailed search in place (the Feed sets its `q`). Absent ⇒ submit
   *  navigates to `/s/<space>/feed?q=…`. */
  onSubmit?: (q: string) => void
  placeholder?: string
  className?: string
}) => {
  const { space } = useSpace()
  const navigate = useNavigate()
  const [text, setText] = useState(value ?? '')
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listId = useId()

  // Reflect an externally-changed query (Feed q via back/forward, a tag-chip
  // navigation, another tab) — but NOT while the user is mid-edit in this field:
  // if it has focus, a `value` change is our own submit's echo (or a stray external
  // change we must not let clobber in-progress typing), so skip the sync until blur.
  useEffect(() => {
    if (document.activeElement !== inputRef.current) {
      setText(value ?? '')
    }
  }, [value])

  const trimmed = text.trim()
  // Idle until the field is opened (focused) — it's mounted on every page's topbar.
  const { results, recent, searching } = useNoteSuggestions(space, text, open)

  const rows = useMemo<Row[]>(() => {
    const notes = trimmed ? (results ?? []) : recent
    return [
      ...(trimmed ? [{ kind: 'submit' as const }] : []),
      ...notes.map((sug) => ({ kind: 'note' as const, sug })),
    ]
  }, [trimmed, results, recent])

  // Keep the highlight on the first row whenever the visible list changes.
  useEffect(() => {
    setSelected(0)
  }, [trimmed, results, recent])

  useDismiss(open, () => setOpen(false), { inside: [rootRef] })

  const submit = useCallback(
    (q: string) => {
      const t = q.trim()
      setOpen(false)
      inputRef.current?.blur()
      if (onSubmit) {
        onSubmit(t)
        return
      }
      navigate(t ? feedQueryRoute(space, t) : feedRoute(space))
    },
    [onSubmit, navigate, space],
  )

  const openNote = useCallback(
    (sug: NoteSuggestion, newTab: boolean) => {
      const href = noteRoute(sug.id, effectiveSlug(sug.slug, sug.title))

      if (!href) {
        return
      }
      setOpen(false)
      if (newTab) {
        window.open(href, '_blank', 'noopener,noreferrer')
        return
      }
      inputRef.current?.blur()
      navigate(href)
    },
    [navigate],
  )

  const activate = useCallback(
    (row: Row | undefined, newTab: boolean) => {
      if (!row) {
        submit(text)
        return
      }
      if (row.kind === 'submit') {
        submit(text)
      } else {
        openNote(row.sug, newTab)
      }
    },
    [submit, openNote, text],
  )

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (!open) {
        setOpen(true)
        return
      }
      if (rows.length) {
        setSelected((s) => (s + 1) % rows.length)
      }

      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (rows.length) {
        setSelected((s) => (s - 1 + rows.length) % rows.length)
      }

      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      activate(rows[selected], e.metaKey || e.ctrlKey)
      return
    }
    if (e.key === 'Escape') {
      if (open) {
        e.preventDefault()
        setOpen(false)
      }
    }
  }

  const clear = () => {
    setText('')
    if (onSubmit) {
      onSubmit('')
    }
    inputRef.current?.focus()
    setOpen(true)
  }

  const showDropdown = open && (trimmed.length > 0 || recent.length > 0 || searching)
  const loading = trimmed && searching && !(results && results.length)

  return (
    <div ref={rootRef} className={cx(styles.omni, className)}>
      <SearchField
        ref={inputRef}
        className={styles.field}
        value={text}
        onChange={(v) => {
          setText(v)
          setOpen(true)
        }}
        onClear={clear}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        inputProps={{
          role: 'combobox',
          'aria-expanded': showDropdown,
          'aria-controls': listId,
          'aria-activedescendant':
            showDropdown && rows.length ? `${listId}-opt-${selected}` : undefined,
          'data-testid': 'omni-search',
        }}
      />

      {showDropdown && (
        <div className={styles.dropdown} id={listId} role="listbox" data-testid="omni-results">
          {loading ? (
            <div className={styles.skeleton} aria-hidden="true">
              {Array.from({ length: 5 }, (_, i) => (
                <div key={i} className={styles.skeletonRow}>
                  <Skeleton w={`${50 + ((i * 13) % 34)}%`} h={12} radius={4} />
                </div>
              ))}
            </div>
          ) : rows.length === 0 ? (
            <EmptyState
              variant="bare"
              icon={<IconSearch size={16} />}
              title={trimmed ? 'No matches' : 'Search your notes'}
              hint={trimmed ? `Nothing matches “${trimmed}”.` : 'Find by title, path or content.'}
              testId="omni-empty"
            />
          ) : (
            <>
              {!trimmed && (
                <div className={styles.sectionLabel} aria-hidden="true">
                  Recent
                </div>
              )}
              {rows.map((row, i) => {
                const active = i === selected
                const id = `${listId}-opt-${i}`

                if (row.kind === 'submit') {
                  return (
                    <div
                      key="submit"
                      id={id}
                      role="option"
                      aria-selected={active}
                      className={cx(styles.row, styles.rowSubmit, active && styles.rowActive)}
                      onMouseMove={() => selected !== i && setSelected(i)}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => submit(text)}
                      data-testid="omni-submit"
                    >
                      <IconSearch size={15} className={styles.rowIcon} />
                      <div className={styles.rowText}>
                        <div className={styles.rowTitle}>
                          Search for “<span className={styles.q}>{trimmed}</span>” in Feed
                        </div>
                      </div>
                      <kbd className={styles.rowEnter}>↵</kbd>
                    </div>
                  )
                }
                const { sug } = row
                return (
                  <div
                    key={sug.id}
                    id={id}
                    role="option"
                    aria-selected={active}
                    className={cx(styles.row, active && styles.rowActive)}
                    onMouseMove={() => selected !== i && setSelected(i)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={(e) => openNote(sug, e.metaKey || e.ctrlKey)}
                    data-testid="omni-result"
                    data-id={sug.id}
                  >
                    <IconDoc size={15} className={styles.rowIcon} />
                    <div className={styles.rowText}>
                      <div className={styles.rowTitle}>{highlightMatch(sug.title, trimmed)}</div>
                      {sug.snippet ? (
                        <div className={styles.rowSub}>{highlightMatch(sug.snippet, trimmed)}</div>
                      ) : dirOf(sug.filePath) ? (
                        <div className={styles.rowSub}>{dirOf(sug.filePath)}</div>
                      ) : null}
                    </div>
                  </div>
                )
              })}
            </>
          )}
        </div>
      )}
    </div>
  )
}
