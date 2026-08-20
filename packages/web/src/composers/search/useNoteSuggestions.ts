import { useEffect, useMemo, useState } from 'react'
import { NOTE_SORT } from '@notarium/contract/enums'
import { loadRecentNotes, type RecentNote } from '../../libs/recentNotes'
import type { NoteView, SearchResultView } from '../../libs/wire'
import { api } from '../../services/api'

// The note quick-jump data layer (#190), shared by Spotlight (the Cmd+P overlay)
// and the topbar OmniSearch dropdown — ONE source of truth for "search notes +
// recents", so the two surfaces never drift in debounce, dedupe or empty-state
// rules. Both render their own chrome over the same suggestions.
//
// `results` is the live search (debounced, each keystroke aborts the prior
// in-flight request so a slow old answer can't land after a newer one); `recent`
// is the empty-state pool (MRU ∪ the space's recently-modified). Membership vs
// ranking: this is the RANKED quick-jump (hybrid backend), distinct from the
// Feed's q-filter which narrows by lexical containment (#190 decision).

const SEARCH_REQUEST_DEBOUNCE_MS = 160
const RECENT_LIMIT = 20

export type NoteSuggestion = {
  id: string
  title: string
  slug?: string
  filePath?: string
  modifiedAt: string | null
  createdAt: string | null
  noteType?: string
  snippet?: string
  href?: string
}

export type NoteSuggestions = {
  /** The trimmed query the results describe. */
  q: string
  /** Search hits for `q`, or null when `q` is empty (show `recent` instead). */
  results: NoteSuggestion[] | null
  /** MRU ∪ recently-modified, deduped — the empty-state quick-jump pool. */
  recent: NoteSuggestion[]
  /** A query is in flight (drives the loading skeleton). */
  searching: boolean
}

// `enabled` gates the network work (recents backfill + search): OmniSearch mounts
// on EVERY document page's topbar but should stay idle until the user opens it —
// without this it would fire a recents fetch on every navigation. Spotlight only
// mounts while open, so it leaves this at the default `true`.
export const useNoteSuggestions = (
  space: string,
  rawQuery: string,
  enabled = true,
): NoteSuggestions => {
  const q = rawQuery.trim()
  const [results, setResults] = useState<SearchResultView[] | null>(null)
  const [searching, setSearching] = useState(false)
  // The MRU reads synchronously (localStorage) so recents paint on the first
  // frame; the server backfill only tops it up.
  const [recent, setRecent] = useState<RecentNote[]>(() => loadRecentNotes(space))
  const [modified, setModified] = useState<NoteView[]>([])

  // Empty-state backfill: top up a thin MRU with the space's recently-modified.
  // Skipped until enabled, so an always-mounted OmniSearch doesn't fetch per nav.
  useEffect(() => {
    if (!enabled) {
      setRecent(loadRecentNotes(space))
      setModified([])
      return undefined
    }
    setRecent(loadRecentNotes(space))
    setModified([])
    let alive = true
    api
      .notesGet(space, { sort: NOTE_SORT.modified, limit: RECENT_LIMIT })
      .then((page) => {
        if (alive) {
          setModified(page.notes)
        }
      })
      .catch(() => {
        /* recents stay MRU-only — the empty state still works */
      })
    return () => {
      alive = false
    }
  }, [space, enabled])

  // Debounced search; each keystroke aborts the prior request (out-of-order guard).
  useEffect(() => {
    if (!enabled || !q) {
      setResults(null)
      setSearching(false)
      return undefined
    }
    setSearching(true)
    const ac = new AbortController()
    const t = setTimeout(() => {
      api
        .searchGet(space, q, ac.signal)
        .then((r) => {
          if (!ac.signal.aborted) {
            setResults(r)
            setSearching(false)
          }
        })
        .catch(() => {
          if (!ac.signal.aborted) {
            setResults([])
            setSearching(false)
          }
        })
    }, SEARCH_REQUEST_DEBOUNCE_MS)

    return () => {
      clearTimeout(t)
      ac.abort()
    }
  }, [q, space, enabled])

  // MRU ∪ recently-modified, deduped by id, MRU winning order.
  const recentList = useMemo<NoteSuggestion[]>(() => {
    const seen = new Set<string>()
    const out: NoteSuggestion[] = []
    const modifiedById = new Map(modified.map((n) => [n.id, n]))

    // Normalise the title here (untitled note → path → 'Untitled') so EVERY consumer
    // renders a non-empty label without re-deriving it (the search hits below do the
    // same) — Spotlight and OmniSearch stay in lockstep.
    const push = (n: {
      id: string
      title: string
      slug?: string
      filePath?: string
      noteType?: string
      modifiedAt?: string | null
      createdAt?: string | null
      href?: string
    }) => {
      if (seen.has(n.id)) {
        return
      }
      seen.add(n.id)
      const backfill = modifiedById.get(n.id)
      out.push({
        id: n.id,
        title: backfill?.title || n.title || n.filePath || backfill?.filePath || 'Untitled',
        slug: backfill?.slug ?? n.slug,
        filePath: backfill?.filePath ?? n.filePath,
        noteType: n.noteType,
        modifiedAt: n.modifiedAt ?? backfill?.modifiedAt ?? null,
        createdAt: n.createdAt ?? backfill?.createdAt ?? null,
        href: n.href,
      })
    }

    for (const n of recent) {
      push(n)
    }
    for (const n of modified) {
      if (out.length >= RECENT_LIMIT) {
        break
      }
      push(n)
    }

    return out.slice(0, RECENT_LIMIT)
  }, [recent, modified])

  // A SEARCH hit never carries an exact route, and joining one onto it from the MRU —
  // which this hook briefly did — was a fix for a case the read model does not produce.
  // An Owned Ability's document is class `skill`, and `skill` is `userSearch:false`
  // (`core/visibility/policy.ts`): the read model drops it from every user-scoped
  // search, so a hit for one cannot arrive here at all. Recent is a different half and
  // genuinely carries `href`, because the visit that recorded the row knew the route.
  const hits = useMemo<NoteSuggestion[] | null>(() => {
    if (!q) {
      return null
    }

    return (results ?? []).map((r) => ({
      id: r.id,
      title: r.title || r.filePath || 'Untitled',
      filePath: r.filePath,
      modifiedAt: r.modifiedAt,
      createdAt: r.createdAt,
      noteType: r.noteType,
      snippet: r.snippet,
    }))
  }, [q, results])

  return { q, results: hits, recent: recentList, searching }
}
