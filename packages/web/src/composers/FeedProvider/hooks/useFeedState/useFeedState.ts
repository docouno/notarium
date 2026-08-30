import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { matchPath, useLocation, useSearchParams } from 'react-router'
import type { FieldFacet, TagFacet } from '@notarium/contract'
import {
  BUCKET_GRAN,
  FAVORITE_ENTITY_KIND,
  FIELD_FACET_DEFAULT_LIMIT,
  FIELD_SCHEMA_MAX_FIELDS,
  NOTE_SORT,
} from '@notarium/contract/enums'
import { STORE_EVENT } from '@notarium/contract/events'
import {
  FEED_URL_PARAMS,
  feedRoute,
  workspaceSettingsRoute,
} from '../../../../libs/routing/routePaths'
import { STORAGE_KEYS } from '../../../../libs/storageKeys'
import { toggleFolder as toggleFolderSet } from '../../../../libs/tree/tree'
import type { Bucket, NoteView } from '../../../../libs/wire'
import { api } from '../../../../services/api'
import { primePreviews } from '../../../../services/previews'
import { useFavorites } from '../../../FavoritesProvider'
import { useFieldSchema } from '../../../FieldSchemaProvider'
import { useNotes } from '../../../NotesProvider'
import { useSpace } from '../../../SpaceProvider'
import { CHANGED_COALESCE_MS, useSync } from '../../../SyncProvider'
import { FEED_COLS, FEED_COLS_VALUES, FEED_GROUPS, PAGE_SIZE } from '../../consts'
import { isLocalDate } from '../../helpers/isLocalDate'
import type { FeedCols, FeedGroup, FeedSort, FeedView } from '../../types'
import { changeTouchesSelection } from './helpers/changeTouchesSelection'
import { evictFarPages } from './helpers/evictFarPages'
import { favoriteNoteSignature } from './helpers/favoriteNoteSignature'
import {
  clearDateRangeParam,
  clearFieldParam,
  clearFiltersParam,
  clearTagsParam,
  fieldDayParam,
  fieldEqParam,
  setDateFromParam,
  setDateToParam,
  setFavoriteParam,
  setQParam,
  setSortParam,
  toggleFieldDayParam,
  toggleFieldParam,
  toggleTagParam,
} from './helpers/feedUrlParams'
import {
  feedPagesToRefresh,
  type FeedWindowRequest,
  filterRemovedFeedRows,
  invalidatedFeedPages,
  isCurrentFeedWindow,
} from './helpers/feedWindowFreshness'

// Feed page state, lifted out of the component so the page and its aside facets
// share one instance (same folder filter, same data).
//
// Since #64 the Feed owns its own DATA WINDOW: filter+sort+slice live on the
// server (the read-model snapshot makes a window cost milliseconds), the client
// holds a sparse page cache + the honest `total` — so the scrollbar spans the
// whole base and a jump to an arbitrary offset is one request, never a client-
// side walk of the full list. Folder facets and stats come from /api/tree via
// NotesProvider. Freshness: an SSE `changed` event that touches the current
// folder scope refetches the held pages (point-patching a window is a trap —
// an item may have entered or left it — and a window refetch is ~ms).
//
// The folder facet is an INCLUSION set (#93/#109): a click ADDS a folder to the
// focus (show notes under any selected subtree), "show only this folder" is a
// one-element set, and empty = no filter = all — the app's one filter language,
// shared with the tag pane and the graph. One server param (`folders`). The set is
// in-memory (not persisted), exactly like the graph's folder filter.
export const useFeedState = () => {
  const { space } = useSpace()
  const location = useLocation()
  const onFeedRoute = matchPath(feedRoute(space), location.pathname) != null
  const onFieldsRoute =
    matchPath(workspaceSettingsRoute(space, 'fields'), location.pathname) != null
  const fieldFacetActive = onFeedRoute || onFieldsRoute
  const { folderTree, tree, remember, dirOfId } = useNotes()
  const { subscribe, connectionRevision, observationEpoch } = useSync()
  const [searchParams, setSearchParams] = useSearchParams()
  const favorites = useFavorites()
  const {
    fields: fieldDeclarations,
    revision: fieldSchemaRevision,
    loading: fieldSchemaLoading,
  } = useFieldSchema()
  const rawDateFrom = searchParams.get(FEED_URL_PARAMS.from) ?? ''
  const rawDateTo = searchParams.get(FEED_URL_PARAMS.to) ?? ''
  const dateFrom = isLocalDate(rawDateFrom) ? rawDateFrom : ''
  const dateTo = isLocalDate(rawDateTo) && (!dateFrom || rawDateTo >= dateFrom) ? rawDateTo : ''
  const hasUrlDateRange = Boolean(dateFrom || dateTo)

  const [sortPref, setSortPref] = useState<FeedSort>(() =>
    localStorage.getItem(STORAGE_KEYS.feedSort) === NOTE_SORT.modified
      ? NOTE_SORT.modified
      : NOTE_SORT.created,
  )
  const sortParam = searchParams.get(FEED_URL_PARAMS.sort)
  const sort: FeedSort =
    sortParam === NOTE_SORT.created || sortParam === NOTE_SORT.modified
      ? sortParam
      : hasUrlDateRange
        ? NOTE_SORT.created
        : sortPref
  const setSort = useCallback(
    (next: FeedSort) => {
      setSortPref(next)
      setSearchParams((prev) => setSortParam(prev, next), { replace: false })
    },
    [setSearchParams],
  )
  const [view, setView] = useState<FeedView>(() =>
    localStorage.getItem(STORAGE_KEYS.feedView) === 'grid' ? 'grid' : 'list',
  )
  const [cols, setCols] = useState<FeedCols>(() => {
    const v = localStorage.getItem(STORAGE_KEYS.feedCols) as FeedCols | null
    return v && FEED_COLS_VALUES.includes(v) ? v : FEED_COLS.medium
  })
  const [group, setGroup] = useState<FeedGroup>(() => {
    // Migrate the old boolean ('1' meant group-by-day) so saved prefs survive.
    const v = localStorage.getItem(STORAGE_KEYS.feedGroup)

    if (v === '1') {
      return BUCKET_GRAN.day
    }

    return v && FEED_GROUPS.includes(v as FeedGroup) ? (v as FeedGroup) : 'off'
  })
  // The tag filter (#109) lives in the URL as a repeatable `?tag=` key — so
  // back/forward/reload restore it and a reader's tag-chip click (a link to
  // /feed?tag=…) lands here. Empty = no tag filter. The set is OR/union-matched
  // (each selected tag widens the result — the app's unified "add to filter"
  // model), so the aside chips and the window stay in lockstep.
  // Sorted for a stable query identity + deterministic request URLs.
  const tags = useMemo(() => searchParams.getAll(FEED_URL_PARAMS.tag).sort(), [searchParams])
  const tagSet = useMemo(() => new Set(tags), [tags])
  // Toggle one tag in/out of the URL set (folded path); a click ADDS, another removes.
  const toggleTag = useCallback(
    (tag: string) => setSearchParams((prev) => toggleTagParam(prev, tag), { replace: false }),
    [setSearchParams],
  )
  const clearTags = useCallback(
    () => setSearchParams((prev) => clearTagsParam(prev), { replace: false }),
    [setSearchParams],
  )
  const fieldFilters = useMemo(
    () => searchParams.getAll(FEED_URL_PARAMS.field).sort(),
    [searchParams],
  )
  const fieldAnyFilters = useMemo(
    () => searchParams.getAll(FEED_URL_PARAMS.fieldAny).sort(),
    [searchParams],
  )
  const fieldDayFilters = useMemo(
    () => searchParams.getAll(FEED_URL_PARAMS.fieldDay).sort(),
    [searchParams],
  )
  const fieldBadFilters = useMemo(
    () => searchParams.getAll(FEED_URL_PARAMS.fieldBad).sort(),
    [searchParams],
  )
  const fieldSet = useMemo(() => new Set(fieldFilters), [fieldFilters])
  const fieldDaySet = useMemo(() => new Set(fieldDayFilters), [fieldDayFilters])
  const isFieldSelected = useCallback(
    (key: string, value: string) => fieldSet.has(fieldEqParam(key, value)),
    [fieldSet],
  )
  const isFieldDaySelected = useCallback(
    (key: string, day: string) => fieldDaySet.has(fieldDayParam(key, day)),
    [fieldDaySet],
  )
  const isFieldActive = useCallback(
    (key: string) => {
      const address = `note.${key}`
      return (
        fieldFilters.some((value) => value.startsWith(`${address}:`)) ||
        fieldDayFilters.some((value) => value.startsWith(`${address}:`)) ||
        fieldAnyFilters.includes(address) ||
        fieldBadFilters.includes(address)
      )
    },
    [fieldAnyFilters, fieldBadFilters, fieldDayFilters, fieldFilters],
  )
  const toggleField = useCallback(
    (key: string, value: string) =>
      setSearchParams((prev) => toggleFieldParam(prev, key, value), { replace: false }),
    [setSearchParams],
  )
  const toggleFieldDay = useCallback(
    (key: string, day: string) =>
      setSearchParams((prev) => toggleFieldDayParam(prev, key, day), { replace: false }),
    [setSearchParams],
  )
  const clearField = useCallback(
    (key: string) => setSearchParams((prev) => clearFieldParam(prev, key), { replace: false }),
    [setSearchParams],
  )
  // The full-text query (#190) is another filter axis, also URL-borne (`?q=`),
  // so a search survives reload/back-forward and a topbar "search in Feed" from
  // anywhere is just a navigation to `/feed?q=…`. Trimmed for a stable query
  // identity; empty = no text filter. Composes with folders ∧ tags — the window,
  // total and histogram all describe the q-narrowed population (server-applied).
  const urlQ = (searchParams.get(FEED_URL_PARAMS.q) ?? '').trim()
  // The provider survives route changes to retain its sparse window. Keep the last
  // Feed-owned q with it; an unrelated surface may use the same URL key.
  const feedQRef = useRef(onFeedRoute ? urlQ : '')

  if (onFeedRoute) {
    feedQRef.current = urlQ
  }
  const q = feedQRef.current
  const favorite = searchParams.get(FEED_URL_PARAMS.favorite) === '1'
  const setQ = useCallback(
    (next: string) => setSearchParams((prev) => setQParam(prev, next), { replace: false }),
    [setSearchParams],
  )
  // Date range (#201) is URL-borne like tags/q. Values are local calendar days
  // (`YYYY-MM-DD`), not instants; invalid manual URL values are ignored by the UI
  // (the API still rejects them if called directly).
  const setDateFrom = useCallback(
    (next: string) =>
      setSearchParams((prev) => setDateFromParam(prev, next, dateTo, sort), { replace: false }),
    [dateTo, setSearchParams, sort],
  )
  const setDateTo = useCallback(
    (next: string) =>
      setSearchParams((prev) => setDateToParam(prev, next, sort), { replace: false }),
    [setSearchParams, sort],
  )
  const clearDateRange = useCallback(
    () => setSearchParams((prev) => clearDateRangeParam(prev), { replace: false }),
    [setSearchParams],
  )
  const clearFilters = useCallback(
    () => setSearchParams((prev) => clearFiltersParam(prev), { replace: false }),
    [setSearchParams],
  )
  const setFavorite = useCallback(
    (next: boolean) => setSearchParams((prev) => setFavoriteParam(prev, next), { replace: false }),
    [setSearchParams],
  )
  // Selected-folder set (#93/#109 inclusion) — subtree-cascading, like the graph's
  // filter. Empty = no filter (everything shown). Not persisted (a transient
  // exploration, and folder paths go stale on rename/delete — same call the graph makes).
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  // Sorted for a stable query identity + deterministic request URLs (dedupe-cache
  // friendly); server order-agnostic. Empty array shares one identity across renders.
  const includeList = useMemo(() => [...selected].sort(), [selected])
  const toggleFolder = useCallback(
    (path: string) => setSelected((prev) => toggleFolderSet(prev, path)),
    [],
  )
  // "Show only this folder" — a one-element set (its whole subtree, nothing else).
  const soloFolder = useCallback((path: string) => setSelected(new Set([path])), [])
  const resetFolders = useCallback(() => setSelected(new Set()), [])

  // ── the sparse data window ──────────────────────────────────────────────────
  const [pages, setPages] = useState<Map<number, NoteView[]>>(() => new Map())
  const [total, setTotal] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const pagesRef = useRef(pages)
  const inflight = useRef(new Set<number>())
  const pendingRefreshPages = useRef(new Set<number>())
  const queryRef = useRef('')
  /** Same query, newer server truth: invalidates every response begun before a
   * relevant changed event, independently of the query-key guard. */
  const windowRevisionRef = useRef(0)
  useEffect(() => {
    pagesRef.current = pages
  }, [pages])

  // When the favorite FACET is on, the window population depends on the favorite
  // SET, not just the on/off flag — so a signature of the favorited note-ids joins
  // the query key (#42), and toggling a star elsewhere re-queries the feed at once
  // (an un-favorited note leaves the list; a newly-favorited one appears) instead of
  // going stale until an unrelated filter flip. Facet OFF ⇒ empty token ⇒ a toggle
  // never needlessly refetches the unfiltered feed. (Favorite mutations don't emit a
  // sync 'changed' event, so the SSE sweep can't cover this on its own.)
  const favoriteNoteSig = useMemo(
    () => (favorite ? favoriteNoteSignature(favorites.items) : ''),
    [favorite, favorites.items],
  )
  // The query identity: a space switch, a sort flip, or a change to the selected
  // folders OR the tags invalidates every held page (the window's population
  // changed). `space` rides the key too so the flip effect AND the stale-response
  // guards (`queryRef.current !== key`) are space-aware — without it an in-place
  // space switch (FeedProvider doesn't remount) could apply space-A's late window
  // into space-B and reopen the inflight-dedupe hole.
  const queryKey = `${space}|conn:${connectionRevision}|schema:${fieldSchemaRevision}|${sort}|${includeList.join(' ')}|${tags.join(' ')}|${JSON.stringify(fieldFilters)}|${JSON.stringify(fieldDayFilters)}|${JSON.stringify(fieldAnyFilters)}|${JSON.stringify(fieldBadFilters)}|${q}|${dateFrom}|${dateTo}|${favorite ? `fav:${favoriteNoteSig}` : ''}`

  const fetchPage = useCallback(
    async (page: number) => {
      const key = queryRef.current
      const observedAt = observationEpoch()
      const request: FeedWindowRequest = { queryKey: key, revision: windowRevisionRef.current }

      if (inflight.current.has(page)) {
        return
      }
      inflight.current.add(page)
      try {
        const r = await api.notesGet(space, {
          sort,
          offset: page * PAGE_SIZE,
          limit: PAGE_SIZE,
          // Warm previews ride the window inline; cold ones stay null and the
          // cards batch them through POST /api/previews (services/previews).
          preview: true,
          // The folder facet (#93/#109): keep notes under any selected subtree (OR).
          ...(includeList.length ? { folders: includeList } : {}),
          // The tag filter (#109): OR/union over the selected set, server-applied.
          ...(tags.length ? { tags } : {}),
          ...(fieldFilters.length ? { field: fieldFilters } : {}),
          ...(fieldDayFilters.length ? { fieldDay: fieldDayFilters } : {}),
          ...(fieldAnyFilters.length ? { fieldAny: fieldAnyFilters } : {}),
          ...(fieldBadFilters.length ? { fieldBad: fieldBadFilters } : {}),
          // The full-text membership filter (#190): narrow to notes matching q.
          ...(q ? { q } : {}),
          // Date range (#201): local-day bounds. The server uses the current sort axis.
          ...(dateFrom ? { from: dateFrom } : {}),
          ...(dateTo ? { to: dateTo } : {}),
          ...(favorite ? { favorite: true } : {}),
        })

        if (!isCurrentFeedWindow(request, queryRef.current, windowRevisionRef.current)) {
          return
        } // a stale window for a flipped query (folder/tag/q/sort)
        // Seed the session preview map BEFORE the notes render, then drop the
        // payload — previews live in one place (services/previews, with SSE
        // invalidation), not inside every held page and the seen-cache.
        const observed = r.notes.map((n) => ({ ...n, preview: undefined }))
        const accepted = remember(observed, [], observedAt)

        primePreviews(
          r.notes
            .filter((note) => accepted.some((candidate) => candidate.id === note.id))
            .flatMap((n) => (n.preview ? [[n.id, n.preview] as const] : [])),
        )
        setTotal(r.total)
        setError(null)
        setPages((prev) => {
          const next = new Map(prev)
          next.set(page, accepted)
          evictFarPages(next, page)
          pagesRef.current = next
          return next
        })
      } catch (e) {
        if (isCurrentFeedWindow(request, queryRef.current, windowRevisionRef.current)) {
          setError((e as Error).message)
        }
      } finally {
        // Release the in-flight marker only if it's still OURS. On a query flip the
        // flip effect clears `inflight` and a fresh fetchPage(0) re-adds page 0 for the
        // NEW query; a stale completion deleting that marker unconditionally would let a
        // duplicate fetch slip past the dedupe during the flip. The flip's clear()
        // already reclaims any stale marker, so skipping here leaks nothing.
        if (isCurrentFeedWindow(request, queryRef.current, windowRevisionRef.current)) {
          inflight.current.delete(page)
        }
      }
    },
    [
      space,
      sort,
      includeList,
      tags,
      fieldFilters,
      fieldDayFilters,
      fieldAnyFilters,
      fieldBadFilters,
      q,
      dateFrom,
      dateTo,
      favorite,
      remember,
      observationEpoch,
    ],
  )

  // Query flip: drop the window, refetch the head.
  useEffect(() => {
    if (!onFeedRoute || fieldSchemaLoading || queryRef.current === queryKey) {
      return
    }
    queryRef.current = queryKey
    windowRevisionRef.current++
    inflight.current.clear()
    pendingRefreshPages.current.clear()
    pagesRef.current = new Map()
    setPages(pagesRef.current)
    setTotal(null)
    void fetchPage(0)
  }, [onFeedRoute, fieldSchemaLoading, queryKey, fetchPage])

  // ── date buckets (#64): the grouped layout's skeleton ──────────────────────
  // One cheap histogram request per (sort, folder, group) tells the Feed every
  // section's start and size BEFORE any item loads: grouped views lay out
  // headers, section heights and an honest scrollbar from counts alone, and
  // sparse windows can land anywhere without shifting section boundaries.
  // The histogram and the grouping it describes are kept as a PAIR. Rendering by
  // `bucketsGroup` (not the selected `group`) lets a grouping change keep the
  // current grouped layout on screen until the new histogram lands — instead of
  // blanking to an ungrouped flash mid-fetch (week headers vanish, then day
  // headers pop in #68 follow-up). The selected `group` only drives the control
  // highlight and the next fetch.
  const [buckets, setBuckets] = useState<Bucket[] | null>(null)
  const [bucketsGroup, setBucketsGroup] = useState<FeedGroup>('off')
  const bucketsKey = group === 'off' ? null : `${queryKey}|${group}`
  const bucketsKeyRef = useRef(bucketsKey)
  const fetchBuckets = useCallback(async () => {
    const key = bucketsKeyRef.current

    if (key === null || group === 'off') {
      return
    }
    try {
      const r = await api.bucketsGet(space, {
        sort,
        group,
        ...(includeList.length ? { folders: includeList } : {}),
        ...(tags.length ? { tags } : {}),
        ...(fieldFilters.length ? { field: fieldFilters } : {}),
        ...(fieldDayFilters.length ? { fieldDay: fieldDayFilters } : {}),
        ...(fieldAnyFilters.length ? { fieldAny: fieldAnyFilters } : {}),
        ...(fieldBadFilters.length ? { fieldBad: fieldBadFilters } : {}),
        ...(q ? { q } : {}),
        ...(dateFrom ? { from: dateFrom } : {}),
        ...(dateTo ? { to: dateTo } : {}),
        ...(favorite ? { favorite: true } : {}),
      })

      // Swap the histogram AND its grouping together — the view never renders one
      // grouping's headers over another's section sizes.
      if (bucketsKeyRef.current === key) {
        setBuckets(r.buckets)
        setBucketsGroup(group)
      }
    } catch {
      // keep the last good grouping on screen until the next refetch
    }
  }, [
    space,
    sort,
    includeList,
    tags,
    fieldFilters,
    fieldDayFilters,
    fieldAnyFilters,
    fieldBadFilters,
    q,
    dateFrom,
    dateTo,
    favorite,
    group,
  ])
  // Changing the DATA (sort/folder) invalidates the histogram AND reloads the
  // window behind a skeleton, so blank it (the ungrouped beat is hidden by the
  // skeleton). Changing only the GROUPING keeps the current grouped layout until
  // the new histogram lands — no flash to ungrouped. Selecting None ungroups at
  // once (no fetch).
  const dataKeyRef = useRef(queryKey)
  useEffect(() => {
    bucketsKeyRef.current = bucketsKey
    if (group === 'off') {
      setBuckets(null)
      setBucketsGroup('off')
    } else {
      if (dataKeyRef.current !== queryKey) {
        setBuckets(null)
        setBucketsGroup('off')
      }
      void fetchBuckets()
    }
    dataKeyRef.current = queryKey
  }, [bucketsKey, queryKey, group, fetchBuckets])

  /** Make item indices [start, end) resolvable — fetch any missing pages.
   *  Idempotent and in-flight-deduped: the virtualizer calls this per frame. */
  const ensureRange = useCallback(
    (start: number, end: number) => {
      const first = Math.max(0, Math.floor(start / PAGE_SIZE))
      const last = Math.max(first, Math.ceil(end / PAGE_SIZE) - 1)

      for (let p = first; p <= last; p++) {
        if (!pagesRef.current.has(p)) {
          void fetchPage(p)
        }
      }
    },
    [fetchPage],
  )

  /** The note at a window index, or undefined while its page is loading. */
  const itemAt = useCallback(
    (i: number) => pages.get(Math.floor(i / PAGE_SIZE))?.[i % PAGE_SIZE],
    [pages],
  )

  // ── the tag facet (#109) ────────────────────────────────────────────────────
  // The space's tags as a folder-like tree with counts — the aside's tag filter.
  // Independent of the window/hidden set (it's the WHOLE base's tag vocabulary, so
  // the facet stays stable as you filter), refetched on space change and on the
  // coalesced SSE sweep (a new/edited note may add or drop a tag). Cheap: the
  // server reduces the snapshot like /tree.
  const [tagFacet, setTagFacet] = useState<TagFacet[]>([])
  const fetchTags = useCallback(async () => {
    try {
      const r = await api.tagsGet(space)
      setTagFacet(r.tags)
    } catch {
      // a transient facet error leaves the last good list
    }
  }, [space])
  useEffect(() => {
    void fetchTags()
  }, [fetchTags])
  const [fieldFacetState, setFieldFacetState] = useState<{
    space: string
    fields: FieldFacet[]
    truncated?: true
    status: 'loading' | 'ready' | 'error'
  }>(() => ({ space, fields: [], status: 'loading' }))
  const fieldFacetRequestSeq = useRef(0)
  const fieldFacet = fieldFacetState.space === space ? fieldFacetState.fields : []
  const fieldFacetReady = fieldFacetState.space === space && fieldFacetState.status === 'ready'
  const fetchFields = useCallback(async () => {
    const requestSeq = ++fieldFacetRequestSeq.current
    const requestedSpace = space
    setFieldFacetState((current) => ({
      space: requestedSpace,
      fields: current.space === requestedSpace ? current.fields : [],
      status: 'loading',
    }))

    try {
      const response = await api.fieldsGet(space, {
        limit: onFieldsRoute ? FIELD_SCHEMA_MAX_FIELDS : FIELD_FACET_DEFAULT_LIMIT,
        valuesLimit: onFieldsRoute ? 0 : undefined,
      })

      if (requestSeq === fieldFacetRequestSeq.current) {
        setFieldFacetState({
          space: requestedSpace,
          fields: response.fields,
          ...(response.truncated ? { truncated: true as const } : {}),
          status: 'ready',
        })
      }
    } catch {
      if (requestSeq === fieldFacetRequestSeq.current) {
        setFieldFacetState((current) => ({
          space: requestedSpace,
          fields: current.space === requestedSpace ? current.fields : [],
          status: 'error',
        }))
      }
    }
  }, [onFieldsRoute, space])
  useEffect(() => {
    if (fieldFacetActive) {
      void fetchFields()
    }
  }, [fetchFields, fieldFacetActive, fieldSchemaRevision])

  // SSE freshness: refetch the held window when a change touches our scope.
  // canon: docs/feed-page.md#data-flow
  useEffect(() => {
    let windowTimer: ReturnType<typeof setTimeout> | null = null
    let fieldFacetTimer: ReturnType<typeof setTimeout> | null = null
    const off = subscribe((event) => {
      if (event.type !== STORE_EVENT.CHANGED) {
        return
      }
      // The field facet describes the whole corpus, not the selected folder.
      // Coalesce it independently so an irrelevant window event still refreshes
      // field vocabulary/counts without pulling unrelated window pages or buckets.
      if (fieldFacetActive && !fieldFacetTimer) {
        fieldFacetTimer = setTimeout(() => {
          fieldFacetTimer = null
          void fetchFields()
        }, CHANGED_COALESCE_MS)
      }
      if (selected.size > 0) {
        // A change concerns us when it touches a VISIBLE note — i.e. one that sits
        // under a selected subtree (the inclusion filter is on), by its old
        // location OR by the one the event reports.
        const touches = changeTouchesSelection(
          selected,
          [...event.upserts, ...event.removed],
          dirOfId,
          event.folders,
        )

        if (!touches) {
          return
        }
      }
      // Supersede same-query requests NOW, not after the coalesce timer. A page
      // already in flight must neither land stale nor dedupe the fresh request.
      for (const page of invalidatedFeedPages(pagesRef.current, inflight.current)) {
        pendingRefreshPages.current.add(page)
      }
      windowRevisionRef.current++
      inflight.current.clear()
      const nextPages = filterRemovedFeedRows(pagesRef.current, event.removed)

      pagesRef.current = nextPages
      setPages(nextPages)
      if (windowTimer) {
        return
      }
      windowTimer = setTimeout(() => {
        windowTimer = null
        const refreshPages = feedPagesToRefresh(pendingRefreshPages.current, pagesRef.current)

        pendingRefreshPages.current.clear()
        for (const p of refreshPages) {
          void fetchPage(p)
        }
        // The histogram AND the tag facet moved with the data — same sweep (~ms).
        void fetchBuckets()
        void fetchTags()
      }, CHANGED_COALESCE_MS)
    })

    return () => {
      off()
      if (windowTimer) {
        clearTimeout(windowTimer)
      }
      if (fieldFacetTimer) {
        clearTimeout(fieldFacetTimer)
      }
    }
  }, [
    subscribe,
    selected,
    dirOfId,
    fetchPage,
    fetchBuckets,
    fetchTags,
    fetchFields,
    fieldFacetActive,
  ])

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.feedSort, sortPref)
  }, [sortPref])
  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.feedView, view)
  }, [view])
  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.feedCols, cols)
  }, [cols])
  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.feedGroup, group)
  }, [group])

  // Folder facets + mini-stats come from the structure endpoint (counts over
  // the whole base, so they're stable regardless of the window).
  const stats = tree?.stats ?? { total: 0, week: 0 }

  return {
    sort,
    setSort,
    view,
    setView,
    cols,
    setCols,
    group,
    setGroup,
    selected,
    toggleFolder,
    soloFolder,
    resetFolders,
    tags,
    tagSet,
    toggleTag,
    clearTags,
    tagFacet,
    fieldFilters,
    fieldDayFilters,
    fieldAnyFilters,
    fieldBadFilters,
    isFieldSelected,
    isFieldDaySelected,
    isFieldActive,
    toggleField,
    toggleFieldDay,
    clearField,
    fieldFacet,
    fieldFacetTruncated: fieldFacetState.space === space && fieldFacetState.truncated === true,
    fieldFacetReady,
    fieldDeclarations,
    q,
    setQ,
    clearFilters,
    dateFrom,
    dateTo,
    setDateFrom,
    setDateTo,
    clearDateRange,
    favorite,
    setFavorite,
    favoriteCount: favorites.items.filter((it) => it.kind === FAVORITE_ENTITY_KIND.note).length,
    total,
    itemAt,
    ensureRange,
    buckets,
    bucketsGroup,
    folders: folderTree,
    stats: { total: stats.total, week: stats.week },
    loading: total === null && !error,
    error,
    loaded: total !== null,
  }
}
