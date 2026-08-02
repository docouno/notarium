import { useVirtualizer } from '@tanstack/react-virtual'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import type { Space, TrashItem } from '@notarium/contract'
import { NOTE_CLASS } from '@notarium/contract/enums'
import { STORE_EVENT } from '@notarium/contract/events'
import { useChrome } from '../../composers/ChromeProvider'
import { useSpace } from '../../composers/SpaceProvider'
import { useSync } from '../../composers/SyncProvider'
import { Button } from '../../core/Button'
import { Checkbox } from '../../core/Checkbox'
import { useDialog } from '../../core/Dialog'
import { IconArchive, IconPanelLeft, IconTrash } from '../../core/Icons'
import { IconToggle } from '../../core/IconToggle'
import { SearchField } from '../../core/SearchField'
import { SkeletonText } from '../../core/Skeleton'
import { useToast } from '../../core/Toast'
import { Breadcrumbs } from '../../layouts/Breadcrumbs'
import { cx } from '../../libs/cx/cx'
import { errorText } from '../../libs/errors'
import { memoryNoteRoute, noteRoute, TRASH_URL_PARAMS } from '../../libs/routing/routePaths'
import { api } from '../../services/api'
import { PAGE, ROW_H } from './consts'
import { restoreSummary } from './helpers/restoreSummary'
import { useTrashChrome } from './hooks/useTrashChrome'
import { TrashRow } from './TrashRow'
import type { BatchFailure, TrashEntry } from './types'
import styles from './TrashPage.module.scss'

// The Trash page (#79): a per-space manager over the revision journal — deleted
// notes (newest first), windowed + virtualized so it scales to a huge trash.
// Search filters by title server-side. Restore is a quick per-row action; delete-
// forever is deliberate (pick rows / select-all-N) and commits from the sticky
// bottom bar only AFTER a selection exists — the safe action stays light, the
// destructive one is fenced by multi-select + danger confirm.
// A row's title opens the deleted note read-only (/n/<id>) under a banner.

export const TrashPage = () => {
  const {
    space,
    canWrite,
    capabilities,
    archivedSpaces,
    restoreSpace,
    purgeSpace,
    reloadSpaces,
    reloadArchived,
  } = useSpace()
  const { subscribe } = useSync()
  const { confirm } = useDialog()
  const { railOpen, toggleRail } = useChrome()
  const toast = useToast()

  // Tabs (#110): the Trash is the ONE place for everything deleted — notes (#79) and
  // whole spaces — with ONE shared search across both. `?tab=…` deep-links a tab; the
  // effective tab is resolved BELOW, once we know which kinds actually have content
  // (we only show a tab strip when there's something to filter between).
  const [searchParams, setSearchParams] = useSearchParams()
  const spacesEnabled = capabilities.spaceCreate
  const urlTab = searchParams.get(TRASH_URL_PARAMS.tab)

  const setTab = (next: 'all' | 'notes' | 'spaces') => {
    if (bulkBusy) {
      return
    }
    // Leaving a view drops the current selection. Hidden selected rows would have no
    // visible footer/clear affordance on the next tab, yet still block deferred SSE reloads.
    setSelected(new Set())
    setAllMatching(false)
    scrollRef.current?.scrollTo({ top: 0 })
    setSearchParams(next === 'all' ? {} : { [TRASH_URL_PARAMS.tab]: next }, { replace: true })
  }

  const [items, setItems] = useState<TrashItem[]>([])
  const [total, setTotal] = useState(0)
  const [restorableTotal, setRestorableTotal] = useState(0)
  const [loaded, setLoaded] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [failed, setFailed] = useState(false)
  const [qInput, setQInput] = useState('')
  const [q, setQ] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [allMatching, setAllMatching] = useState(false) // "delete all N matching"
  const [busy, setBusy] = useState<string | null>(null) // a per-row action in flight
  const [bulkBusy, setBulkBusy] = useState(false) // a footer purge in flight
  const scrollRef = useRef<HTMLDivElement>(null)
  const seq = useRef(0)

  // Show a tab strip ONLY when there are BOTH kinds to filter between — a tab with no
  // content is noise. With only notes (or only spaces) the strip is hidden and the single
  // list shows everything (effective `all`). NOTE: `total` is the SEARCH-FILTERED note
  // count (from reload with `q`), so a search that narrows notes to zero hides the strip
  // and falls back to `all` — acceptable (the spaces are still shown); the strip is for
  // filtering between populated kinds, not a fixed chrome.
  const hasNotes = total > 0
  const hasSpaces = spacesEnabled && archivedSpaces.length > 0
  const showTabs = hasNotes && hasSpaces
  const tab: 'all' | 'notes' | 'spaces' =
    showTabs && (urlTab === 'spaces' || urlTab === 'notes') ? urlTab : 'all'
  const showSpaces = spacesEnabled && tab !== 'notes'
  const showNotes = tab !== 'spaces'
  // "Select all N matching" counts NOTES, so it only applies while notes are in view
  // AND the principal can write notes in this space. On the Spaces tab / read-only notes
  // it must be INERT — otherwise the footer would offer to permanently purge notes the
  // user can't explicitly select. setTab also clears the underlying flag.
  const effAllMatching = showNotes && canWrite && allMatching

  // Debounce the search box into the applied query.
  useEffect(() => {
    const t = setTimeout(() => setQ(qInput.trim()), 250)
    return () => clearTimeout(t)
  }, [qInput])

  const reload = useCallback(async () => {
    const my = ++seq.current
    setLoaded(false)
    setFailed(false)
    setSelected(new Set())
    setAllMatching(false)
    try {
      const res = await api.trashGet(space, { offset: 0, limit: PAGE, q: q || undefined })

      if (my !== seq.current) {
        return
      }
      setItems(res.items)
      setTotal(res.total)
      setRestorableTotal(res.restorableTotal)
      setLoaded(true)
      scrollRef.current?.scrollTo({ top: 0 })
    } catch {
      if (my !== seq.current) {
        return
      }
      setItems([])
      setTotal(0)
      setRestorableTotal(0)
      setLoaded(true)
      setFailed(true)
    }
  }, [space, q])

  // Reload on space / search change.
  useEffect(() => {
    void reload()
  }, [reload])

  const loadMore = useCallback(async () => {
    if (loadingMore || !loaded || items.length >= total) {
      return
    }
    const my = seq.current
    setLoadingMore(true)
    try {
      const res = await api.trashGet(space, {
        offset: items.length,
        limit: PAGE,
        q: q || undefined,
      })

      if (my !== seq.current) {
        return
      }
      setItems((prev) => [...prev, ...res.items])
      setTotal(res.total)
      setRestorableTotal(res.restorableTotal)
      // A writable select-all-N selection should cover the freshly loaded rows too.
      if (effAllMatching) {
        setSelected((prev) => new Set([...prev, ...res.items.map((i) => i.noteId)]))
      }
    } catch {
      // keep what we have; the next scroll retries
    } finally {
      if (my === seq.current) {
        setLoadingMore(false)
      }
    }
  }, [space, q, items.length, total, loadingMore, loaded, effAllMatching])

  // Live freshness (#60): a delete/restore anywhere bumps the space's SSE stream; coalesce
  // a burst into one reload. But a reload clears the selection (reload() resets it), so in
  // an agent-native space — where the agent writes/deletes constantly — it would yank a
  // user's in-progress destructive multi-select out from under them. Defer the reload while
  // a selection or bulk purge is live (re-check every interval), flushing once it's idle.
  const reloadGuard = useRef(false)
  reloadGuard.current = selected.size > 0 || bulkBusy
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null

    const arm = () => {
      timer = setTimeout(() => {
        timer = null
        if (reloadGuard.current) {
          arm() // user is mid-gesture — hold the refresh, try again shortly
          return
        }
        void reload()
      }, 1500)
    }
    const unsub = subscribe((event) => {
      if (event.type !== STORE_EVENT.CHANGED || timer) {
        return
      }
      arm()
    })

    return () => {
      if (timer) {
        clearTimeout(timer)
      }
      unsub()
    }
  }, [subscribe, reload])

  // Deleted spaces (#110), client-filtered by the SHARED search (host-level list,
  // already loaded in SpaceProvider). Notes are filtered server-side by the same `q`.
  const filteredSpaces = useMemo(() => {
    if (!showSpaces) {
      return []
    }
    const needle = q.trim().toLowerCase()

    if (!needle) {
      return archivedSpaces
    }

    return archivedSpaces.filter(
      (s) => s.displayName.toLowerCase().includes(needle) || s.slug.includes(needle),
    )
  }, [showSpaces, archivedSpaces, q])

  // ONE virtualized list over both kinds: space rows first (few, fixed), then notes
  // (windowed). An index < spaceRows.length is a space; the rest are notes.
  const spaceRows = filteredSpaces
  const noteRows = showNotes ? items : []
  const virt = useVirtualizer({
    count: spaceRows.length + noteRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H, // every deleted item is one fixed-height row
    overscan: 10,
  })
  const vItems = virt.getVirtualItems()

  // Infinite scroll: when the window reaches the tail (a note), pull the next page.
  useEffect(() => {
    const last = vItems[vItems.length - 1]

    if (last && showNotes && last.index >= spaceRows.length + noteRows.length - 1) {
      void loadMore()
    }
  }, [vItems, spaceRows.length, noteRows.length, showNotes, loadMore])

  // ── selection — notes AND deleted spaces share ONE model (identical mechanic to
  //    the notes manager: tick rows, then the bulk footer deletes them). One Set of
  //    ids (note-ids and space-ids are distinct namespaces); the delete partitions. ──
  const selectableNoteIds = canWrite ? noteRows.map((i) => i.noteId) : []
  const allSelectable = [...spaceRows.map((s) => s.id), ...selectableNoteIds]
  const anyLoadedSelected = allSelectable.some((id) => selected.has(id))
  const allLoadedSelected =
    allSelectable.length > 0 && allSelectable.every((id) => selected.has(id))
  const headerChecked = effAllMatching || allLoadedSelected
  const headerIndeterminate = !effAllMatching && anyLoadedSelected && !allLoadedSelected
  // "Select all N" appears ONLY when writable notes are in view (showNotes + canWrite)
  // and there are more on the server than loaded — never on the Spaces tab (where
  // total/items are stale notes) nor when only space rows are selectable.
  const canSelectAllMatching =
    showNotes && canWrite && allLoadedSelected && !allMatching && total > items.length
  const selSpaces = spaceRows.filter((s) => selected.has(s.id))
  const selectedNoteRows = noteRows.filter((i) => selected.has(i.noteId))
  const selectedRestorableNoteIds = selectedNoteRows
    .filter((i) => i.restorable)
    .map((i) => i.noteId)
  const selNoteCount = effAllMatching
    ? total
    : selectableNoteIds.filter((id) => selected.has(id)).length
  const effectiveCount = selSpaces.length + selNoteCount
  const restorableCount =
    selSpaces.length + (effAllMatching ? restorableTotal : selectedRestorableNoteIds.length)

  const toggleRow = (id: string, on: boolean) => {
    setAllMatching(false)
    setSelected((prev) => {
      const next = new Set(prev)

      if (on) {
        next.add(id)
      } else {
        next.delete(id)
      }

      return next
    })
  }

  const toggleHeader = () => {
    if (headerChecked) {
      setSelected(new Set())
      setAllMatching(false)
    } else {
      setSelected(new Set(allSelectable))
    }
  }

  const clearSelection = () => {
    setSelected(new Set())
    setAllMatching(false)
  }

  // ── actions ──
  const restore = async (item: TrashItem) => {
    setBusy(item.noteId)
    try {
      await api.trashRestore(space, item.noteId)
      setItems((prev) => prev.filter((i) => i.noteId !== item.noteId))
      setTotal((t) => Math.max(0, t - 1))
      if (item.restorable) {
        setRestorableTotal((t) => Math.max(0, t - 1))
      }
      setSelected((prev) => {
        const next = new Set(prev)
        next.delete(item.noteId)
        return next
      })
      toast.success(`Restored “${item.title || 'Untitled'}”`)
    } catch (e) {
      toast.error((e as Error).message)
      void reload()
    } finally {
      setBusy(null)
    }
  }

  const restoreSelected = async () => {
    if (!effectiveCount || !restorableCount || bulkBusy) {
      return
    }
    const noteAttempted = showNotes
      ? effAllMatching
        ? restorableTotal
        : selectedRestorableNoteIds.length
      : 0
    const spaceIds = selSpaces.map((s) => s.id)
    setBulkBusy(true)
    try {
      const noteResult =
        noteAttempted > 0
          ? await api.trashRestoreMany(
              space,
              effAllMatching
                ? { all: true, q: q || undefined, onlyRestorable: true }
                : { ids: selectedRestorableNoteIds },
            )
          : { ok: true as const, restored: [], failed: [] }
      const spaceResult =
        spaceIds.length > 0
          ? await api.restoreSpaces(spaceIds)
          : { ok: true as const, restored: [], failed: [] }

      const noteRemovedIds = new Set<string>()

      for (const r of noteResult.restored) {
        noteRemovedIds.add(r.id)
      }
      for (const f of noteResult.failed) {
        if (f.reason === 'note_not_in_trash') {
          noteRemovedIds.add(f.id)
        }
      }
      const noteRemovedCount = noteRemovedIds.size

      if (noteRemovedCount > 0) {
        setItems((prev) => prev.filter((i) => !noteRemovedIds.has(i.noteId)))
        setTotal((t) => Math.max(0, t - noteRemovedCount))
        setRestorableTotal((t) => Math.max(0, t - noteRemovedCount))
      }

      if (spaceIds.length > 0) {
        void reloadArchived()
      }
      if (spaceResult.restored.length > 0) {
        void reloadSpaces()
      }

      setSelected((prev) => {
        const next = new Set(prev)

        for (const id of noteRemovedIds) {
          next.delete(id)
        }
        for (const s of spaceResult.restored) {
          next.delete(s.id)
        }
        for (const s of spaceResult.failed) {
          if (s.reason === 'not_found') {
            next.delete(s.id)
          }
        }

        return next
      })
      if (effAllMatching) {
        setAllMatching(Math.max(0, total - noteRemovedCount) > 0)
      }

      const failures: BatchFailure[] = [...noteResult.failed, ...spaceResult.failed]
      const restoredCount = noteResult.restored.length + spaceResult.restored.length
      const summary = restoreSummary(restorableCount, restoredCount, failures)

      if (summary.tone === 'success') {
        toast.success(summary.text)
      } else if (summary.tone === 'warning') {
        toast.warning(summary.text)
      } else {
        toast.error(summary.text)
      }
    } catch (e) {
      toast.error(errorText(e))
      if (spaceIds.length > 0) {
        void reloadArchived()
        void reloadSpaces()
      }
      void reload()
    } finally {
      setBulkBusy(false)
    }
  }

  const deleteSelected = async () => {
    const noteIds = selectableNoteIds.filter((id) => selected.has(id))
    const noteCount = effAllMatching ? total : noteIds.length
    const count = selSpaces.length + noteCount

    if (!count || bulkBusy) {
      return
    }
    const ok = await confirm({
      title: 'Delete permanently?',
      // A whole space is heavier than a note — call it out so the confirm is honest.
      message:
        selSpaces.length > 0
          ? `${count} item${count === 1 ? '' : 's'} erased for good — including ${selSpaces.length} whole space${selSpaces.length === 1 ? '' : 's'} (every note, history and backup inside). This can’t be undone.`
          : `${count} note${count === 1 ? '' : 's'} erased for good, with their history. This can’t be undone.`,
      confirmLabel: `Delete ${count} forever`,
      danger: true,
    })

    if (!ok) {
      return
    }
    setBulkBusy(true)
    try {
      // Spaces first (each a transactional purge), then the notes in one call.
      for (const s of selSpaces) {
        await purgeSpace(s.id, s.slug)
      }
      if (effAllMatching) {
        await api.trashPurge(space, { all: true, q: q || undefined })
      } else if (noteIds.length) {
        await api.trashPurge(space, { ids: noteIds })
      }
      toast.success(`${count} permanently deleted`)
      clearSelection()
      void reload()
    } catch (e) {
      toast.error(errorText(e))
      void reload() // a partial purge already removed some items — resync to truth
    } finally {
      setBulkBusy(false)
    }
  }

  // ── per-row Restore for a deleted space (#110) — the quick action, mirroring the
  // note row's Restore. Permanent delete is the bulk footer (select → Delete N), so a
  // whole-space wipe is never a single stray click. ──
  const restoreSpaceRow = async (s: Space) => {
    setBusy(s.id)
    try {
      await restoreSpace(s.id)
      toast.success(`Restored “${s.displayName}”`)
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setBusy(null)
    }
  }

  // Visually identical to the cross-cutting OmniSearch (#190 brief) via the shared
  // SearchField shell — but its function stays LOCAL: a trash filter, no quick-jump
  // suggestions, no Feed hand-off.
  const search = (
    <SearchField
      className={styles.search}
      value={qInput}
      onChange={setQInput}
      onClear={() => setQInput('')}
      placeholder="Search trash…"
      inputProps={{ 'data-testid': 'trash-search', 'aria-label': 'Search trash' }}
    />
  )

  const selecting = effectiveCount > 0
  const listCount = spaceRows.length + noteRows.length

  // States — skeleton/error/empty only when there's nothing else to show (on `all`
  // the spaces render immediately, so a notes load/failure stays silent below them).
  const showSkeleton = showNotes && !loaded && spaceRows.length === 0
  const showError = showNotes && loaded && failed && listCount === 0
  const showEmpty = listCount === 0 && !showSkeleton && !showError && (!showNotes || loaded)

  // ONE uniform select-all toolbar + selection-only bulk footer on EVERY tab — a tab is
  // just a filter over the same list of deleted items, so the controls never change
  // shape between them. There is intentionally no no-selection "Empty trash" affordance:
  // irreversible purge starts only after the user selects rows / Select all N (#183).
  const showToolbar = allSelectable.length > 0
  const showFooter = selecting

  // The floating top chrome + footer measure themselves so the list pads exactly clear
  // of the frosted glass bands (#72/#185); the measured heights become the scroll padding.
  const { topChromeRef, footerRef, topH, footH } = useTrashChrome(scrollRef, {
    showToolbar,
    showTabs,
    showFooter,
  })

  return (
    <main className={cx('main', styles.page)}>
      {/* The floating top chrome: the topbar row + the optional select-all toolbar as ONE
          frosted glass band the list scrolls under (#72). */}
      <div
        ref={topChromeRef}
        className={cx(styles.topChrome, 'glass', 'glass-scroll', 'glass-edge-bottom')}
      >
        <div className={styles.topbar}>
          <div className={styles.topbarLeft}>
            <IconToggle
              icon={<IconPanelLeft size={15} />}
              active={railOpen}
              onClick={toggleRail}
              title={railOpen ? 'Collapse sidebar' : 'Expand sidebar'}
            />
            <Breadcrumbs trail={[{ label: 'Trash' }]} />
          </div>
          {/* One SHARED search across notes + spaces (always visible). */}
          <div className={styles.topbarCenter}>{search}</div>
          <div className={styles.topbarRight} />
        </div>

        {/* ONE control line: select-all on the left, the kind filter (tabs) on the
            right — no separate tab strip. Shows when there's anything to select OR to
            filter; each half renders on its own condition. */}
        {(showToolbar || showTabs) && (
          <div className={styles.toolbar}>
            <div className={styles.toolbarLeft}>
              {showToolbar && (
                <>
                  <span className={styles.check}>
                    <Checkbox
                      checked={headerChecked}
                      indeterminate={headerIndeterminate}
                      disabled={bulkBusy}
                      onChange={toggleHeader}
                      aria-label="Select all"
                      data-testid="trash-select-all"
                    />
                  </span>
                  <button
                    className={styles.selectAllText}
                    onClick={toggleHeader}
                    disabled={bulkBusy}
                  >
                    {selecting ? `${effectiveCount} selected` : 'Select all'}
                  </button>
                  {canSelectAllMatching && (
                    <button
                      className={styles.linkBtn}
                      onClick={() => setAllMatching(true)}
                      disabled={bulkBusy}
                      data-testid="trash-select-all-n"
                    >
                      Select all {total}
                    </button>
                  )}
                  {effAllMatching && <span className={styles.allNote}>All {total} selected</span>}
                </>
              )}
            </div>
            {showTabs && (
              <div className={styles.tabs} role="tablist" aria-label="Trash sections">
                {(['all', 'notes', 'spaces'] as const).map((t) => (
                  <button
                    key={t}
                    className={cx(styles.tab, tab === t && styles.tabActive)}
                    role="tab"
                    aria-selected={tab === t}
                    disabled={bulkBusy}
                    onClick={() => setTab(t)}
                    data-testid={`trash-tab-${t}`}
                  >
                    {t === 'all' ? 'All' : t === 'notes' ? 'Notes' : 'Spaces'}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <div
        className={styles.scroll}
        ref={scrollRef}
        data-testid="trash-page"
        // Inset the scrollbar thumb between the two glass bands (#176): the measured
        // chrome/footer heights (not the extra content padding) so the bar sits in the
        // gap, clear of both strips, while the list still scrolls under them.
        style={{
          paddingTop: topH + 10,
          paddingBottom: footH + 14,
          ['--sb-inset-top' as string]: `${topH}px`,
          ['--sb-inset-bottom' as string]: `${footH}px`,
        }}
      >
        {showSkeleton && (
          <div className={styles.states}>
            <SkeletonText lines={4} />
          </div>
        )}

        {showError && (
          <div className={styles.states}>
            <p className={styles.muted} data-testid="trash-error">
              Couldn’t load the trash. It may be unavailable on this server.
            </p>
          </div>
        )}

        {showEmpty && (
          <div className={styles.empty} data-testid="trash-empty-state">
            {tab === 'spaces' ? <IconArchive size={22} /> : <IconTrash size={22} />}
            <p className={styles.emptyTitle}>
              {q ? 'Nothing matches' : tab === 'spaces' ? 'No deleted spaces' : 'Trash is empty'}
            </p>
            <p className={styles.muted}>
              {q
                ? 'Nothing deleted matches your search.'
                : tab === 'spaces'
                  ? 'Deleting a space (from its Management → General) moves the whole space here — a safety net. It’s gone for good only when you permanently delete it.'
                  : 'Deleted notes — and whole spaces — land here first: a safety net, including notes removed outside Notarium. Nothing is gone for good until you delete it permanently.'}
            </p>
          </div>
        )}

        {listCount > 0 && (
          <div
            className={styles.list}
            style={{ height: virt.getTotalSize() }}
            data-testid="trash-list"
          >
            <div style={{ transform: `translateY(${vItems[0]?.start ?? 0}px)` }}>
              {vItems.map((v) => {
                // ONE row for every deleted item — a space (index < spaceRows.length)
                // or a note. Normalise to a TrashEntry, then render through TrashRow.
                const isSpace = v.index < spaceRows.length
                const s = isSpace ? spaceRows[v.index] : undefined
                const n = isSpace ? undefined : noteRows[v.index - spaceRows.length]

                if (!isSpace && !n) {
                  return null
                }
                const isLast = v.index === listCount - 1 && (!showNotes || items.length >= total)
                const entry: TrashEntry = isSpace
                  ? {
                      kind: 'space',
                      id: s!.id,
                      title: s!.displayName,
                      pathText: `/s/${s!.slug}`,
                      who: s!.archivedBy ?? null,
                      date: s!.archivedAt ?? null,
                      restorable: true,
                      restoreTitle: 'Restore',
                    }
                  : {
                      kind: 'note',
                      id: n!.noteId,
                      title: n!.title || 'Untitled',
                      href:
                        n!.class === NOTE_CLASS.agentMemory
                          ? (memoryNoteRoute(n!.noteId) ?? '#')
                          : (noteRoute(n!.noteId) ?? '#'),
                      pathText: n!.filePath,
                      who: n!.deletedBy ?? null,
                      date: n!.deletedAt,
                      memory: n!.class === NOTE_CLASS.agentMemory,
                      external: n!.external,
                      restorable: n!.restorable,
                      restoreTitle: n!.restorable
                        ? 'Restore'
                        : 'Deleted outside Notarium before its content was captured — nothing to restore',
                    }
                return (
                  <TrashRow
                    key={`${entry.kind}-${entry.id}`}
                    entry={entry}
                    isLast={isLast}
                    selectable={isSpace || canWrite}
                    checked={
                      isSpace ? selected.has(entry.id) : effAllMatching || selected.has(entry.id)
                    }
                    busy={busy === entry.id}
                    disabled={bulkBusy}
                    onToggle={(on) => toggleRow(entry.id, on)}
                    onRestore={() => void (isSpace ? restoreSpaceRow(s!) : restore(n!))}
                  />
                )
              })}
            </div>
          </div>
        )}
      </div>

      {showFooter && (
        <div
          ref={footerRef}
          className={cx(styles.footer, 'glass', 'glass-scroll', 'glass-edge-top')}
          data-testid="trash-footer"
        >
          <span className={styles.footerInfo}>
            {effectiveCount} selected
            <button
              className={styles.linkBtn}
              onClick={clearSelection}
              disabled={bulkBusy}
              data-testid="trash-clear"
            >
              Clear
            </button>
          </span>
          <div className={styles.footerActions}>
            <Button
              variant="warning"
              className={styles.footerAction}
              onClick={() => void restoreSelected()}
              disabled={bulkBusy || restorableCount === 0}
              data-testid="trash-restore-selected"
            >
              Restore {restorableCount}
            </Button>
            <Button
              variant="danger"
              className={styles.footerAction}
              onClick={() => void deleteSelected()}
              disabled={bulkBusy}
              data-testid="trash-delete-selected"
            >
              Delete {effectiveCount} forever
            </Button>
          </div>
        </div>
      )}
    </main>
  )
}
