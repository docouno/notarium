import { useCallback, useEffect, useRef, useState } from 'react'
import { STORE_EVENT } from '@notarium/contract/events'
import { SCAN_PHASE } from '@notarium/core'
import type { GraphView as Graph, SyncStatus } from '../../../../libs/wire'
import { api } from '../../../../services/api'
import { useNotes } from '../../../NotesProvider'
import { useSpace } from '../../../SpaceProvider'
import { useSync } from '../../../SyncProvider'
import { REFETCH_MIN_MS } from '../../consts'
import { filterObservedGraph } from './graphFreshness'

/** Loads the space's graph and keeps it fresh. Owns `data`/`error`, seeds the
 *  resolution cache (#64) and rides the shared SSE channel (#60/#62): a `changed`
 *  batch or the scan reaching `ready` triggers a throttled refetch that merges in
 *  seamlessly (the server keeps positions warm; the canvas holds the camera). Also
 *  surfaces `syncStatus` for the view's on-canvas retry chip. */
export const useGraphData = () => {
  const { space } = useSpace()
  const { remember } = useNotes()
  const { status: syncStatus, subscribe, connectionRevision, observationEpoch } = useSync()
  const [data, setData] = useState<Graph | null>(null)
  const [error, setError] = useState<string | null>(null)
  const requestSeq = useRef(0)

  const loadGraph = useCallback(async () => {
    const seq = ++requestSeq.current
    const observedAt = Math.max(connectionRevision, observationEpoch())

    try {
      const graph = await api.graphGet(space)

      if (requestSeq.current !== seq) {
        return
      }
      const observed = graph.nodes
        .filter((node) => !node.ghost)
        .map((node) => ({
          id: node.id,
          title: node.title,
          filePath: node.filePath,
          modifiedAt: null,
          createdAt: null,
        }))
      const accepted = remember(observed, [], observedAt)
      const filtered = filterObservedGraph(graph, new Set(accepted.map((note) => note.id)))

      setData(filtered)
      setError(null)
    } catch (e) {
      if (requestSeq.current === seq) {
        setError(e instanceof Error ? e.message : String(e))
      }
    }
  }, [space, remember, connectionRevision, observationEpoch])

  useEffect(() => {
    setData(null) // a space switch must not show the previous space's graph
    void loadGraph()
  }, [loadGraph])

  // Ride the server-push channel (#60/#62) through the app's shared SSE
  // subscription (SyncProvider — no second EventSource): during the warm-up
  // window the first payload has nodes but few edges, so when the read-model
  // reports progress — a `changed` batch or the scan reaching `ready` (the
  // edge sweep landing) — the graph is refetched (throttled) and merges in
  // seamlessly: the server keeps positions warm between rebuilds and the
  // canvas holds the camera.
  useEffect(() => {
    let closed = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let lastAt = 0

    const refetch = () => {
      if (timer) {
        return
      }
      const wait = Math.max(0, lastAt + REFETCH_MIN_MS - Date.now())
      timer = setTimeout(() => {
        timer = null
        lastAt = Date.now()
        if (!closed) {
          void loadGraph()
        }
      }, wait)
    }
    // Seed from the status the shared stream already holds: the provider's
    // EventSource opened (and consumed its initial frame) long before this
    // mount, so a warm-up→ready flip right after must still read as a flip.
    let lastPhase: SyncStatus['scan']['phase'] | null = syncStatus?.scan.phase ?? null
    const off = subscribe((e) => {
      if (e.type === STORE_EVENT.CHANGED || e.type === STORE_EVENT.GRAPH) {
        // Invalidate an older response immediately; the throttled request below
        // is the only snapshot allowed to land for this server revision.
        requestSeq.current++
        // `changed` brings fresh topology right away (the server serves it
        // stale-enriched, #60 SWR); `graph` follows when the background
        // communities+layout pass catches up — that fetch lands the settled
        // map. Both fold into the same throttle.
        refetch()
      } else {
        // The boot's edge sweep lands as one phase flip to 'ready', not as a
        // changed batch — that transition is the "edges arrived" signal.
        if (
          e.status.scan.phase === SCAN_PHASE.ready &&
          lastPhase &&
          lastPhase !== SCAN_PHASE.ready
        ) {
          refetch()
        }
        lastPhase = e.status.scan.phase
      }
    })

    return () => {
      closed = true
      off()
      if (timer) {
        clearTimeout(timer)
      }
    }
    // syncStatus is deliberately only a mount-time seed — tracking it would
    // tear down the subscription on every status frame.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subscribe, loadGraph])

  return { data, error, syncStatus }
}
