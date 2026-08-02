import { type RefObject, useEffect, useMemo, useState } from 'react'
import type { Preview } from '../../libs/wire'
import { api } from '../api'

// Note previews (snippet text / first image / tags / words) for Feed cards and
// the graph's tag/word facets — the client half of the #64 preview story.
//
// The shape of the traffic is the contract here:
//   - WARM previews never cost a request: the Feed's /api/notes windows carry
//     them inline (?preview=1) and prime this module's session map.
//   - COLD previews are resolved in BATCHES — one POST /api/previews per
//     viewport-ish burst, never a request per card. Wanting is refcounted: a
//     card that scrolls away (virtualization unmounts it) releases its claim,
//     a queued id nobody wants anymore is dropped before it's ever sent, and
//     an in-flight batch whose every id lost its claimants is ABORTED — the
//     server stops deriving mid-batch. Fast-scrolling ten screens costs the
//     viewport you stop at, not everything you flew past.
//   - Viewport requests go to the FRONT of the queue (the newest need wins);
//     bulk consumers (graph facets) queue behind them.
//
// The session map is a dedupe + prime target, NOT a freshness mechanism:
// SyncProvider drops entries the moment an SSE `changed` event names their
// note, so multi-user edits never linger.

const MEM_CAP = 2_000 // ~2-3KB per preview → a few MB ceiling
const BATCH_MAX = 32 // bounds one request's worst-case engine work
const MAX_INFLIGHT_BATCHES = 2 // a fresh viewport needn't wait out a stale batch
const FRAME_COALESCE_MS = 16 // one frame: let a scroll burst form one batch

const EMPTY: Preview = { snippet: '', tags: [], image: null, words: 0, tokens: 0 }

const mem = new Map<string, Preview>() // note-id → preview (LRU session map)
const droppedListeners = new Set<(ids: ReadonlySet<string>) => void>()

type Claim = { refs: number; resolvers: Array<(p: Preview) => void> }
const pending = new Map<string, Claim>() // queued, not yet sent
const queue: string[] = [] // send order; stale entries skipped at flush
type Batch = { claims: Map<string, Claim>; controller: AbortController }
const inflightIds = new Map<string, Batch>()
const inflight = new Set<Batch>()
let flushTimer: ReturnType<typeof setTimeout> | null = null

const memSet = (id: string, p: Preview): void => {
  if (mem.has(id)) {
    mem.delete(id)
  }
  mem.set(id, p)
  if (mem.size > MEM_CAP) {
    const oldest = mem.keys().next().value

    if (oldest !== undefined) {
      mem.delete(oldest)
    }
  }
}

// Synchronous peek — seeds bulk consumers without a fetch round-trip.
export const getCachedPreview = (id: string | null | undefined): Preview | null => {
  if (!id) {
    return null
  }
  const hit = mem.get(id)

  if (!hit) {
    return null
  }
  mem.delete(id) // refresh LRU recency
  mem.set(id, hit)
  return hit
}

/** Seed warm previews that arrived inline with a notes window (?preview=1) —
 *  and settle any pending claims on those ids so a mounted card never waits
 *  out a batch for data the window already delivered. */
export const primePreviews = (entries: Iterable<readonly [string, Preview]>): void => {
  for (const [id, p] of entries) {
    memSet(id, p)
    const claim = pending.get(id)

    if (claim) {
      pending.delete(id)
      for (const r of claim.resolvers) {
        r(p)
      }
    }
  }
}

/** Precise invalidation, driven by the SSE `changed` event (SyncProvider):
 *  the named notes' previews are stale — drop them and tell mounted hooks so
 *  visible cards refetch (the server already recomputed write-through). */
export const dropPreviews = (ids: readonly string[]): void => {
  const dropped = new Set<string>()

  for (const id of ids) {
    if (mem.delete(id)) {
      dropped.add(id)
    }
  }
  if (!dropped.size) {
    return
  }
  for (const l of droppedListeners) {
    l(dropped)
  }
}

/** Claim a preview: resolve from the session map, or queue it for the next
 *  batch. Returns the release — dropping the LAST claim on a queued id unsends
 *  it, and on an in-flight batch whose other ids are also unclaimed, aborts
 *  the request. `bulk` claims queue behind viewport ones. */
const acquire = (id: string, resolve: (p: Preview) => void, bulk: boolean): (() => void) => {
  const cached = getCachedPreview(id)

  if (cached) {
    resolve(cached)
    return () => {}
  }
  const existing = pending.get(id) ?? inflightIds.get(id)?.claims.get(id)
  const claim = existing ?? { refs: 0, resolvers: [] }

  if (!existing) {
    pending.set(id, claim)
    if (bulk) {
      queue.push(id)
    } else {
      queue.unshift(id)
    }
    scheduleFlush()
  }
  claim.refs++
  claim.resolvers.push(resolve)
  let released = false

  return () => {
    if (released) {
      return
    }
    released = true
    claim.refs--
    claim.resolvers = claim.resolvers.filter((r) => r !== resolve)
    if (claim.refs > 0) {
      return
    }
    if (pending.get(id) === claim) {
      pending.delete(id) // never sent — free
      return
    }
    const batch = inflightIds.get(id)

    if (batch && [...batch.claims.values()].every((c) => c.refs <= 0)) {
      batch.controller.abort() // nobody wants ANY of it — stop the server too
    }
  }
}

const scheduleFlush = (): void => {
  if (flushTimer) {
    return
  }
  flushTimer = setTimeout(() => {
    flushTimer = null
    flush()
  }, FRAME_COALESCE_MS)
}

const flush = (): void => {
  while (inflight.size < MAX_INFLIGHT_BATCHES) {
    const claims = new Map<string, Claim>()

    while (queue.length && claims.size < BATCH_MAX) {
      const id = queue.shift()!
      const claim = pending.get(id)

      if (!claim) {
        continue
      } // primed, released or already riding another batch
      pending.delete(id)
      claims.set(id, claim)
    }
    if (!claims.size) {
      return
    }
    const controller = new AbortController()
    const batch: Batch = { claims, controller }
    inflight.add(batch)
    for (const id of claims.keys()) {
      inflightIds.set(id, batch)
    }
    api
      .previewsPost([...claims.keys()], controller.signal)
      .then(({ previews }) => {
        for (const [id, claim] of claims) {
          const p = previews[id]

          if (p) {
            memSet(id, p)
          }
          // An absent id (unresolvable note) still settles its claims — a card
          // must stop shimmering; nothing is cached, so a remount retries.
          for (const r of claim.resolvers) {
            r(p ?? EMPTY)
          }
        }
      })
      .catch(() => {
        // Aborted (nobody listening) or failed — settle without caching so the
        // next mount retries instead of pinning an empty preview forever.
        for (const claim of claims.values()) {
          for (const r of claim.resolvers) {
            r(EMPTY)
          }
        }
      })
      .finally(() => {
        inflight.delete(batch)
        for (const id of claims.keys()) {
          if (inflightIds.get(id) === batch) {
            inflightIds.delete(id)
          }
        }
        if (queue.length) {
          flush()
        }
      })
  }
}

// Lazily load a note's preview once `enabled` (i.e. the card is in view).
// An SSE invalidation of this id resets the hook, so a visible card refreshes
// itself instead of showing the pre-edit preview until remount. Unmounting
// (virtualization scrolling the card out) releases the claim — see acquire.
export const usePreview = (id: string | null | undefined, enabled: boolean): Preview | null => {
  const [data, setData] = useState<Preview | null>(() => getCachedPreview(id))
  useEffect(() => {
    if (!id) {
      return undefined
    }
    const onDrop = (ids: ReadonlySet<string>) => {
      if (ids.has(id)) {
        setData(null)
      }
    }
    droppedListeners.add(onDrop)
    return () => void droppedListeners.delete(onDrop)
  }, [id])
  useEffect(() => {
    if (!enabled || !id || data) {
      return undefined
    }
    let alive = true
    const release = acquire(
      id,
      (p) => {
        if (alive) {
          setData(p)
        }
      },
      false,
    )

    return () => {
      alive = false
      release()
    }
  }, [id, enabled, data])
  return data
}

// Bulk previews for a set of notes (graph facets): seed from the session map
// synchronously, then resolve the rest through the shared batches — BEHIND any
// viewport needs — filling in progressively. Unmount releases every
// outstanding claim, so leaving the graph cancels the sweep.
const useBulkPreviews = (ids: readonly string[], enabled: boolean): Map<string, Preview> => {
  const [map, setMap] = useState<Map<string, Preview>>(() => new Map())
  useEffect(() => {
    if (!enabled) {
      return undefined
    }
    let alive = true
    const seeded = new Map<string, Preview>()
    const todo: string[] = []

    for (const id of ids) {
      const c = getCachedPreview(id)

      if (c) {
        seeded.set(id, c)
      } else {
        todo.push(id)
      }
    }
    setMap(seeded)
    const releases = todo.map((id) =>
      acquire(
        id,
        (p) => {
          if (alive) {
            setMap((prev) => new Map(prev).set(id, p))
          }
        },
        true,
      ),
    )

    return () => {
      alive = false
      for (const r of releases) {
        r()
      }
    }
  }, [enabled, ids])
  return map
}

// (#109 retired useBulkTags: tags ride the graph payload now — the Graph reads
// node.tags directly instead of sweeping previews per node.)

// Bulk word counts, for the Graph's "Size by → Words". Returns id → words;
// a missing id just hasn't resolved yet (treated as 0 until it does).
export const useBulkWords = (ids: readonly string[], enabled: boolean): Map<string, number> => {
  const previews = useBulkPreviews(ids, enabled)
  return useMemo(() => {
    const next = new Map<string, number>()

    for (const [id, p] of previews) {
      next.set(id, p.words || 0)
    }

    return next
  }, [previews])
}

// One-shot "has this element been near the viewport yet?" via IntersectionObserver.
// rootMargin pre-arms cards just before they scroll in so previews feel instant.
export const useInView = (ref: RefObject<Element | null>, rootMargin = '200px'): boolean => {
  const [seen, setSeen] = useState(false)
  useEffect(() => {
    if (seen || !ref.current) {
      return undefined
    }
    const el = ref.current
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setSeen(true)
          io.disconnect()
        }
      },
      { rootMargin },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [ref, seen, rootMargin])
  return seen
}
