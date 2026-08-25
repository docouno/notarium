import { enrichGraph, hash01, type LayoutPositions, seedAtPlacedNeighbours } from '../../../graph'
import type { Graph } from '../../../knowledgeStore'
import type { BackgroundGate } from '../../../libs/backgroundScheduler'
import type { GraphCacheOptions } from './types'

const GRAPH_ENRICHMENT_CANCELLED = Symbol('graph-enrichment-cancelled')

/** Graph enrichment cache: the communities+layout pass runs at most once per graph
 *  revision, never on the request path. The owner ticks `rev` only when shaped-node/
 *  resolver inputs or derived edges move; ordinary Feed/Activity freshness is a
 *  separate channel. `layoutPositions` warm-start the next layout.
 *  canon: docs/core.md#swr-graph */
export class GraphCache {
  private readonly shape: () => Graph
  private readonly emitGraph: () => void
  private readonly debounceMs: number
  private readonly canSchedule: () => boolean
  private readonly scheduler?: BackgroundGate
  private rev = 0
  /** Full-reset generation. Unlike a normal snapshot revision, a reset makes
   *  every in-flight result unusable, including its layout warm-start state. */
  private epoch = 0
  private enriched: { rev: number; graph: Graph } | null = null
  private enriching: {
    rev: number
    epoch: number
    promise: Promise<Graph>
    abort: AbortController
  } | null = null
  /** SWR shape for the current revision: fresh topology dressed in the
   *  last computed enrichment, built once per revision and served while the
   *  real re-enrichment chases the snapshot in the background. */
  private staleShape: { rev: number; graph: Graph } | null = null
  private layoutPositions: LayoutPositions = new Map()
  /** Link count of the last layout run — a layout computed before the edge
   *  sweep landed (0 links) is a degenerate seed, not a warm start. */
  private layoutLinks = 0
  private refreshTimer: ReturnType<typeof setTimeout> | null = null
  private disposed = false
  private readonly activeEnrichments = new Set<Promise<Graph>>()

  constructor({ shape, emitGraph, debounceMs, canSchedule, scheduler }: GraphCacheOptions) {
    this.shape = shape
    this.emitGraph = emitGraph
    this.debounceMs = debounceMs
    this.canSchedule = canSchedule
    this.scheduler = scheduler
  }

  /** A graph-relevant change: shaped graph inputs moved, so enrichment for the
   *  previous revision is stale from here on; tick the revision and re-arm the
   *  debounced recompute (which chases it so the request path never has to). */
  onSnapshotChanged(): void {
    this.rev++
    this.scheduleRefresh()
  }

  /** A fresh engine edge baseline (adoptGraph): tick the revision and drop any
   *  enrichment computed during the 'notes' phase — it saw a node-only graph,
   *  not a servable stale map, so the first post-boot read computes the real one. */
  resetBaseline(): void {
    this.rev++
    this.enriched = null
    this.staleShape = null
  }

  /** Full reset (rescan): the snapshot is being rebuilt from scratch. */
  reset(): void {
    this.epoch++
    this.enriching?.abort.abort()
    this.enriched = null
    this.staleShape = null
    this.enriching = null
    this.layoutPositions = new Map()
    this.layoutLinks = 0
  }

  /** Drop the pending refresh timer and suppress a running pass's late publish. */
  dispose(): void {
    this.disposed = true
    this.enriching?.abort.abort()
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer)
    }
    this.refreshTimer = null
  }

  /** Join layout work that was already active when the owner stopped. */
  async settle(): Promise<void> {
    while (this.activeEnrichments.size) {
      await Promise.allSettled([...this.activeEnrichments])
    }
  }

  /** Kick the debounced background refresh — endBulk's single catch-up pass now
   *  that a bulk import (which suppressed per-change refreshes) is over. */
  refreshSoon(): void {
    this.scheduleRefresh()
  }

  /** Identifies the exact snapshot state a graph derivation describes. Moves on every
   *  snapshot mutation (`rev`) AND on every full rebuild (`epoch`) — both are needed,
   *  because `reset()` ticks only the epoch, so a rev-only key would let a memo survive
   *  a rescan that rebuilt the corpus underneath it. Exposed for a consumer that caches
   *  its OWN fresh derivation (graph health) rather than reading this cache's
   *  incremental map. */
  get derivationToken(): string {
    return `${this.epoch}:${this.rev}`
  }

  /** The SWR read path: the enriched map if current; else the last
   *  enrichment dressed on live topology while a background recompute chases the
   *  snapshot; else — no settled map yet — cold topology, with the first
   *  enrichment kicked for the next macrotask. */
  read(): Graph {
    const rev = this.rev

    if (this.enriched?.rev === rev) {
      return this.enriched.graph
    }
    if (this.enriched) {
      // Stale-while-revalidate: once a settled map exists, the request
      // path never pays communities+layout again. Serve the CURRENT topology
      // (write-through stays visible in the same call) dressed in the last
      // enrichment; the recompute chases the snapshot from the debounce timer
      // and announces itself with a 'graph' event when it lands. Deliberately
      // NOT kicked inline here: the enrichment's synchronous prefix (Louvain +
      // the first layout ticks) would hog the loop while this very response
      // serializes — measured at seconds on a 2k-note base.
      this.ensureRefresh()
      return this.staleGraph(rev)
    }
    // Cold SWR: there is no settled enrichment to dress with yet, but the
    // dashboard and graph page can use the topology (nodes, links, degrees)
    // immediately. Start the first enrichment in the next macrotask and return
    // the bare shape now; the landing pass emits `graph`, so mounted clients
    // refetch and adopt positions/communities just like the warm SWR path.
    this.ensureRefresh(0)
    return this.bareGraph()
  }

  /** Fresh shape, stale dressing: re-shape the snapshot (cheap — no Louvain,
   *  no layout ticks), carry each node's community and position over from the
   *  last enrichment, and seed newcomers at the centroid of their placed
   *  neighbours so the client can adopt the layout without a re-fit. Built
   *  once per revision.
   *  @see docs/core.md#graph-derivation */
  private staleGraph(rev: number): Graph {
    if (this.staleShape?.rev === rev) {
      return this.staleShape.graph
    }
    const graph = this.shape()
    const prev = new Map(this.enriched!.graph.nodes.map((n) => [n.id, n]))
    let cx = 0
    let cy = 0
    let placed = 0

    for (const node of graph.nodes) {
      const p = prev.get(node.id)

      if (!node.ghost && p && !p.ghost && p.community != null) {
        node.community = p.community
      }
      const pos = this.layoutPositions.get(node.id) ?? p

      if (pos?.x == null || pos.y == null) {
        continue
      }
      node.x = pos.x
      node.y = pos.y
      cx += pos.x
      cy += pos.y
      placed++
    }
    seedAtPlacedNeighbours(graph.nodes, graph.links)
    // A newcomer with no placed neighbour (isolate / opening note of a new
    // cluster) still needs SOME position for the client to adopt the layout —
    // a deterministic spot off the map's centroid; the background relayout
    // (and the client's pinned relax) takes it from there.
    if (placed) {
      cx /= placed
      cy /= placed
    }
    for (const node of graph.nodes) {
      if (node.x != null) {
        continue
      }
      const angle = hash01(node.id) * 2 * Math.PI
      const r = 120 + hash01(node.id + '/r') * 120
      node.x = Math.round((cx + Math.cos(angle) * r) * 10) / 10
      node.y = Math.round((cy + Math.sin(angle) * r) * 10) / 10
    }
    this.staleShape = { rev, graph }
    return graph
  }

  /** Cold topology only: no communities/layout positions yet. This is the
   *  cheap, request-safe graph shape the dashboard needs for counts/hubs/orphans
   *  while the first enrichment warms in the background. */
  private bareGraph(): Graph {
    return this.shape()
  }

  /** Make sure a recompute is coming WITHOUT re-arming a pending timer — the
   *  SWR read path calls this per request, and resetting the debounce there
   *  would let a steady poll of /api/graph starve the refresh forever. */
  private ensureRefresh(delayMs = this.debounceMs): void {
    if (this.refreshTimer || this.enriching) {
      return
    }
    this.scheduleRefresh(delayMs)
  }

  /** Debounced background re-enrichment: every snapshot change re-arms the timer,
   *  so a busy stretch (delta landing many notes every poll) coalesces into one
   *  recompute after things settle. Gated (canSchedule) while the store is stopped,
   *  not yet ready, or importing in bulk — for a big graph the communities+layout
   *  pass is a multi-second CPU pass (~27s for 3k nodes), so firing it per change
   *  burst would peg a core and steal interactive responsiveness; endBulk
   *  kicks exactly ONE pass once the burst is over, reads serve stale-enriched (SWR)
   *  meanwhile. */
  private scheduleRefresh(delayMs = this.debounceMs): void {
    if (this.disposed || !this.canSchedule()) {
      return
    }
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer)
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null
      this.revalidate()
    }, delayMs)
    this.refreshTimer.unref?.()
  }

  /** Recompute the enrichment for the current revision; if the snapshot moved
   *  again mid-run, chase it with another scheduled pass instead of looping. */
  private revalidate(): void {
    if (this.disposed) {
      return
    }
    const rev = this.rev
    const epoch = this.epoch

    if (this.enriched?.rev === rev) {
      return
    }
    if (this.enriching) {
      this.scheduleRefresh()
      return
    }
    const abort = new AbortController()
    const promise = this.enrich(rev, epoch, abort.signal)
    this.enriching = { rev, epoch, promise, abort }
    this.activeEnrichments.add(promise)
    void promise.then(
      () => {
        this.activeEnrichments.delete(promise)
        if (this.enriching?.promise === promise) {
          this.enriching = null
        }
        if (this.disposed || this.epoch !== epoch) {
          return
        }
        if (this.rev === rev) {
          this.emitGraph()
        } else {
          this.scheduleRefresh()
        }
      },
      (err: Error) => {
        this.activeEnrichments.delete(promise)
        if (this.enriching?.promise === promise) {
          this.enriching = null
        }
        if (!this.disposed && this.epoch === epoch) {
          console.error('[cached-store] graph revalidate failed:', err.message)
        }
      },
    )
  }

  /** Shape the snapshot, then enrich it (communities + layout). Shaping
   *  is synchronous so the result reflects revision `rev` exactly; the layout
   *  may yield, and if the snapshot moved meanwhile the result is served to
   *  the waiters but not cached — the next call recomputes against the new
   *  revision. A failed enrichment degrades to the bare shaped graph.
   *  @see docs/core.md#graph-derivation */
  private async enrich(rev: number, epoch: number, signal: AbortSignal): Promise<Graph> {
    const graph = this.shape()
    const scheduler = this.scheduler
    let positions: LayoutPositions | null = null

    const assertActive = (): void => {
      if (signal.aborted || this.disposed || this.epoch !== epoch) {
        throw GRAPH_ENRICHMENT_CANCELLED
      }
    }
    const awaitSchedulerTurn = scheduler
      ? async (): Promise<void> => {
          await scheduler.awaitTurn(signal)
          assertActive()
        }
      : undefined

    try {
      // Louvain is synchronous, so the cooperative boundary is immediately
      // BEFORE it. Force-layout then re-enters the same shared gate at each of
      // its existing size-dependent yield points instead of merely yielding the
      // loop and continuing through fresh interactive traffic.
      await awaitSchedulerTurn?.()
      assertActive()
      // A layout computed before any edges existed (the 'notes' phase serves a
      // node-only graph) is no seed for the real one — relaxing from it would
      // leave the map half-formed. Re-anneal from scratch when edges first land.
      const warmable = this.layoutLinks > 0 || graph.links.length === 0
      positions = await enrichGraph(graph, {
        positions: warmable ? this.layoutPositions : undefined,
        signal,
        yieldToHost: awaitSchedulerTurn,
        // Tiny graphs lay out in microseconds — run them synchronously (yieldEvery
        // 0), so a setTimeout yield never adds a macrotask hop to a cheap pass. A
        // big graph (post-import) has expensive ticks (a 3k-node force tick is
        // ~90ms), so yield after EVERY tick once large — one tick is the finest
        // grain we can interleave interactive requests at, keeping the per-block
        // freeze near a single tick instead of a multi-tick batch (the
        // post-import enrich froze the loop for whole seconds at a time before this).
        yieldEvery:
          graph.nodes.length > 1500
            ? 1
            : graph.nodes.length > 300
              ? 4
              : graph.nodes.length > 64
                ? 25
                : 0,
      })
    } catch (err) {
      if (err === GRAPH_ENRICHMENT_CANCELLED) {
        return graph
      }
      console.error('[cached-store] graph enrichment failed:', (err as Error).message)
    }
    if (this.disposed || this.epoch !== epoch) {
      return graph
    }
    if (positions) {
      this.layoutPositions = positions
      this.layoutLinks = graph.links.length
    }
    // Keep the result even when the snapshot moved mid-run: a slightly-stale
    // enrichment is exactly the dressing the SWR path needs — discarding it would
    // throw away a boot pre-warm pass a mid-scan write raced and pay it again
    // in-line on the next request.
    if (!this.enriched || this.enriched.rev <= rev) {
      this.enriched = { rev, graph }
      this.staleShape = null
    }

    return graph
  }
}
