import { useVirtualizer } from '@tanstack/react-virtual'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import type { Space, TrashAvailabilityFilter, TrashItem } from '@notarium/contract'
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
import { PARTIAL_RESTORE_CONFIRMATION, recoveryPresentation } from '../../libs/revisions/revisions'
import { noteRouteForClass, TRASH_URL_PARAMS } from '../../libs/routing/routePaths'
import { api } from '../../services/api'
import { BOTTOM_CONTENT_GAP, PAGE, RESTORE_REASONS, ROW_H, TOP_CONTENT_GAP } from './consts'
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
  const { confirm, alert } = useDialog()
  const { leftPanelOpen, narrowLayout, toggleLeftPanel } = useChrome()
  const toast = useToast()

  // Tabs (#110): the Trash is the ONE place for everything deleted — notes (#79) and
  // whole spaces — with ONE shared search across both. `?tab=…` deep-links a tab; the
  // effective tab is resolved BELOW, once we know which kinds actually have content
  // (we only show a tab strip when there's something to filter between).
  const [searchParams, setSearchParams] = useSearchParams()
  const spacesEnabled = capabilities.spaceCreate
  const urlTab = searchParams.get(TRASH_URL_PARAMS.tab)
  const urlAvailability = searchParams.get(TRASH_URL_PARAMS.availability)
  const availability: 'all' | TrashAvailabilityFilter =
    urlAvailability === 'restorable' || urlAvailability === 'unavailable' ? urlAvailability : 'all'

  const setTab = (next: 'all' | 'notes' | 'spaces') => {
    if (bulkBusy) {
      return
    }
    // Leaving a view drops the current selection. Hidden selected rows would have no
    // visible footer/clear affordance on the next tab, yet still block deferred SSE reloads.
    setSelected(new Set())
    setAllMatching(false)
    scrollRef.current?.scrollTo({ top: 0 })
    const params = new URLSearchParams(searchParams)

    if (next === 'all') {
      params.delete(TRASH_URL_PARAMS.tab)
    } else {
      params.set(TRASH_URL_PARAMS.tab, next)
    }
    setSearchParams(params, { replace: true })
  }

  const setAvailability = (next: 'all' | TrashAvailabilityFilter) => {
    if (bulkBusy || next === availability) {
      return
    }
    setSelected(new Set())
    setAllMatching(false)
    scrollRef.current?.scrollTo({ top: 0 })
    const params = new URLSearchParams(searchParams)

    if (next === 'all') {
      params.delete(TRASH_URL_PARAMS.availability)
    } else {
      params.set(TRASH_URL_PARAMS.availability, next)
    }
    setSearchParams(params, { replace: true })
  }

  const [items, setItems] = useState<TrashItem[]>([])
  const [total, setTotal] = useState(0)
  const [restorableTotal, setRestorableTotal] = useState(0)
  const [partialTotal, setPartialTotal] = useState(0)
  const [restoreAvailable, setRestoreAvailable] = useState(true)
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
      const res = await api.trashGet(space, {
        offset: 0,
        limit: PAGE,
        q: q || undefined,
        availability: availability === 'all' ? undefined : availability,
      })

      if (my !== seq.current) {
        return
      }
      setItems(res.items)
      setTotal(res.total)
      setRestorableTotal(res.restorableTotal)
      setPartialTotal(res.partialTotal)
      setRestoreAvailable(res.restoreAvailable)
      setLoaded(true)
      scrollRef.current?.scrollTo({ top: 0 })
    } catch {
      if (my !== seq.current) {
        return
      }
      setItems([])
      setTotal(0)
      setRestorableTotal(0)
      setPartialTotal(0)
      setLoaded(true)
      setFailed(true)
    }
  }, [space, q, availability])

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
        availability: availability === 'all' ? undefined : availability,
      })

      if (my !== seq.current) {
        return
      }
      setItems((prev) => [...prev, ...res.items])
      setTotal(res.total)
      setRestorableTotal(res.restorableTotal)
      setPartialTotal(res.partialTotal)
      setRestoreAvailable(res.restoreAvailable)
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
  }, [space, q, availability, items.length, total, loadingMore, loaded, effAllMatching])

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
    if (availability === 'unavailable') {
      return []
    }
    const needle = q.trim().toLowerCase()

    if (!needle) {
      return archivedSpaces
    }

    return archivedSpaces.filter(
      (s) => s.displayName.toLowerCase().includes(needle) || s.slug.includes(needle),
    )
  }, [showSpaces, archivedSpaces, q, availability])

  // ONE list over both kinds: space rows first (few, fixed), then notes (windowed).
  // The virtualizer itself is wired below, after the floating chrome has been measured.
  const spaceRows = filteredSpaces
  const noteRows = showNotes ? items : []

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
    .filter((i) => i.restoreAvailability === 'full' || i.restoreAvailability === 'partial')
    .map((i) => i.noteId)
  const selectedPartialNoteCount = selectedNoteRows.filter(
    (item) => item.restoreAvailability === 'partial',
  ).length
  const selNoteCount = effAllMatching
    ? total
    : selectableNoteIds.filter((id) => selected.has(id)).length
  const effectiveCount = selSpaces.length + selNoteCount
  const restorableCount =
    selSpaces.length + (effAllMatching ? restorableTotal : selectedRestorableNoteIds.length)
  const partialCount = effAllMatching ? partialTotal : selectedPartialNoteCount
  const unavailableCount = Math.max(0, effectiveCount - restorableCount)

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
    if (item.restoreAvailability === 'partial') {
      const ok = await confirm(PARTIAL_RESTORE_CONFIRMATION)

      if (!ok) {
        return
      }
    }
    setBusy(item.noteId)
    try {
      await api.trashRestore(space, item.noteId, item.revisionId)
      setItems((prev) => prev.filter((i) => i.noteId !== item.noteId))
      setTotal((t) => Math.max(0, t - 1))
      if (item.restoreAvailability === 'full' || item.restoreAvailability === 'partial') {
        setRestorableTotal((t) => Math.max(0, t - 1))
      }
      if (item.restoreAvailability === 'partial') {
        setPartialTotal((t) => Math.max(0, t - 1))
      }
      setSelected((prev) => {
        const next = new Set(prev)
        next.delete(item.noteId)
        return next
      })
      toast.success(`Restored “${item.title || 'Untitled'}”`)
    } catch (e) {
      toast.error(errorText(e, RESTORE_REASONS))
      void reload()
    } finally {
      setBusy(null)
    }
  }

  const restoreSelected = async () => {
    if (!effectiveCount || !restorableCount || bulkBusy) {
      return
    }
    if (partialCount > 0) {
      const ok = await confirm({
        title: `Restore ${restorableCount} available item${restorableCount === 1 ? '' : 's'}?`,
        message: `${partialCount} selected ${partialCount === 1 ? 'item is an older partial copy. Its note body and known fields will be restored' : 'items are older partial copies. Their note bodies and known fields will be restored'}, but metadata that was never captured cannot be recovered.${unavailableCount > 0 ? ` ${unavailableCount} unavailable ${unavailableCount === 1 ? 'item' : 'items'} will remain in Trash.` : ''}`,
        confirmLabel: `Restore ${restorableCount} available`,
      })

      if (!ok) {
        return
      }
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
          : null
      const spaceResult =
        spaceIds.length > 0
          ? await api.restoreSpaces(spaceIds)
          : { ok: true as const, restored: [], failed: [] }

      const noteRemovedIds = new Set<string>()

      const noteFailures: BatchFailure[] = []

      for (const item of noteResult?.items ?? []) {
        if (item.status === 'succeeded') {
          noteRemovedIds.add(item.id)
        } else if (item.status === 'conflict') {
          if (item.reason === 'note_not_in_trash') {
            noteRemovedIds.add(item.id)
          } else {
            noteFailures.push({ id: item.id, error: 'Restore conflict', reason: item.reason })
          }
        } else if (item.status === 'not-restorable') {
          noteFailures.push({
            id: item.id,
            error: 'Revision is not restorable',
            reason: item.reason,
          })
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

      const failures: BatchFailure[] = [...noteFailures, ...spaceResult.failed]
      const restoredCount = (noteResult?.counts.succeeded ?? 0) + spaceResult.restored.length
      const summary = restoreSummary(restorableCount, restoredCount, failures, unavailableCount)

      // A completed bulk gesture is over: successful rows disappear, while rows
      // intentionally skipped as unavailable must not linger as a dead Restore 0
      // selection. Runtime failures remain in Trash and are called out by summary.
      clearSelection()
      void reload()

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
        await api.trashPurge(space, {
          all: true,
          q: q || undefined,
          availability: availability === 'all' ? undefined : availability,
        })
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
  const showAvailabilityFilter = availability !== 'all' || listCount > 0

  // The floating top chrome + footer measure themselves so the list pads exactly clear
  // of the frosted glass bands (#72/#185); the measured heights become the scroll padding.
  const { topChromeRef, footerRef, topH, footH } = useTrashChrome(scrollRef, {
    showToolbar,
    showTabs,
    showFooter,
  })
  const topInset = topH + TOP_CONTENT_GAP
  const bottomInset = footH + BOTTOM_CONTENT_GAP

  // The scroll pane owns the physical chrome padding, while `scrollMargin` teaches
  // the virtualizer where its first row actually begins inside that pane. Previously
  // the two coordinate systems differed by the whole top chrome height; returning
  // from a distant window could therefore evict the first recovery rows until reload.
  const virt = useVirtualizer({
    count: listCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 10,
    scrollMargin: topInset,
    scrollPaddingStart: topInset,
    scrollPaddingEnd: bottomInset,
  })
  const vItems = virt.getVirtualItems()
  const lastVirtualIndex = vItems[vItems.length - 1]?.index ?? -1

  // Infinite scroll: when the window reaches the loaded tail, pull the next page.
  // Depend on scalar indices, not the freshly allocated virtual-items array on every
  // scroll frame; the effect now runs only when the visible range actually changes.
  useEffect(() => {
    if (lastVirtualIndex >= 0 && showNotes && lastVirtualIndex >= listCount - 1) {
      void loadMore()
    }
  }, [lastVirtualIndex, listCount, showNotes, loadMore])

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
              active={leftPanelOpen}
              onClick={toggleLeftPanel}
              title={
                narrowLayout
                  ? leftPanelOpen
                    ? 'Close sidebar'
                    : 'Open sidebar'
                  : leftPanelOpen
                    ? 'Collapse sidebar'
                    : 'Expand sidebar'
              }
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
        {(showToolbar || showTabs || showAvailabilityFilter) && (
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
            {(showAvailabilityFilter || showTabs) && (
              <div className={styles.filters}>
                {showAvailabilityFilter && (
                  <div
                    className={styles.tabs}
                    role="tablist"
                    aria-label="Recovery availability"
                    data-testid="trash-availability-filter"
                  >
                    {(['all', 'restorable', 'unavailable'] as const).map((value) => (
                      <button
                        key={value}
                        className={cx(styles.tab, availability === value && styles.tabActive)}
                        role="tab"
                        aria-selected={availability === value}
                        disabled={bulkBusy}
                        onClick={() => setAvailability(value)}
                        data-testid={`trash-availability-${value}`}
                      >
                        {value === 'all'
                          ? 'All items'
                          : value === 'restorable'
                            ? 'Can restore'
                            : 'Can’t restore'}
                      </button>
                    ))}
                  </div>
                )}
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
          paddingTop: topInset,
          paddingBottom: bottomInset,
          ['--sb-inset-top' as string]: `${topH}px`,
          ['--sb-inset-bottom' as string]: `${showFooter ? footH : 0}px`,
        }}
      >
        {loaded && !failed && showNotes && !restoreAvailable && (
          <div className={styles.capabilityBanner} data-testid="trash-restore-unavailable">
            <strong>Note restore is unavailable on this server.</strong> Deleted copies remain
            readable and can still be permanently deleted.
            {spaceRows.length > 0 ? ' Deleted spaces can still be restored.' : ''}
          </div>
        )}
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
              {q
                ? 'Nothing matches'
                : availability === 'restorable'
                  ? 'No items can be restored'
                  : availability === 'unavailable'
                    ? 'No unavailable items'
                    : tab === 'spaces'
                      ? 'No deleted spaces'
                      : 'Trash is empty'}
            </p>
            <p className={styles.muted}>
              {q
                ? 'Nothing deleted matches your search.'
                : availability === 'restorable'
                  ? 'There are no deleted items with a recoverable copy in this view.'
                  : availability === 'unavailable'
                    ? 'Every deleted item in this view has a recoverable copy.'
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
              const noteIsPartial =
                n != null &&
                n.restorable &&
                (n.stateFormat == null || n.stateFormat === 'markdown-v1')
              const entry: TrashEntry = isSpace
                ? {
                    kind: 'space',
                    id: s!.id,
                    title: s!.displayName,
                    pathText: `/s/${s!.slug}`,
                    who: s!.archivedBy ?? null,
                    date: s!.archivedAt ?? null,
                    restorable: true,
                    recovery: recoveryPresentation('full'),
                  }
                : {
                    kind: 'note',
                    id: n!.noteId,
                    title: n!.title || 'Untitled',
                    href: noteRouteForClass(n!.noteId, n!.class) ?? '#',
                    pathText: n!.filePath,
                    who: n!.deletedBy ?? null,
                    date: n!.deletedAt,
                    memory: n!.class === NOTE_CLASS.agentMemory,
                    external: n!.external,
                    restorable:
                      n!.restoreAvailability === 'full' || n!.restoreAvailability === 'partial',
                    recovery: recoveryPresentation(
                      n!.restoreAvailability === 'capability-unavailable' && noteIsPartial
                        ? 'partial'
                        : n!.restoreAvailability,
                    ),
                  }
              return (
                <div
                  key={`${entry.kind}-${entry.id}`}
                  className={styles.virtualRow}
                  data-index={v.index}
                  style={{ transform: `translateY(${v.start - topInset}px)` }}
                >
                  <TrashRow
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
                    onExplain={() =>
                      void alert({
                        title: entry.recovery.label,
                        message: entry.recovery.reason,
                      })
                    }
                  />
                </div>
              )
            })}
          </div>
        )}
      </div>

      <div
        ref={footerRef}
        className={cx(
          styles.footer,
          !showFooter && styles.footerHidden,
          'glass',
          'glass-scroll',
          'glass-edge-top',
        )}
        aria-hidden={!showFooter}
        data-testid={showFooter ? 'trash-footer' : undefined}
      >
        <span className={styles.footerInfo}>
          <span>{effectiveCount} selected</span>
          <span className={styles.footerBreakdown} data-testid="trash-selection-breakdown">
            {restorableCount} can restore · {unavailableCount} unavailable
          </span>
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
            Restore {restorableCount} available
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
    </main>
  )
}
