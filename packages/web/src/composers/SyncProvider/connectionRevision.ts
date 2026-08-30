export type SyncRevisions = {
  connectionRevision: number
  observationEpoch: number
  agentSessionsRevision: number
}

/** EventSource reconnects reuse the same object. The server's `ready` marker — not
 * construction or browser `open` — advances the render signal, synchronous request
 * epoch and owner-global projections whose named events may have been missed. */
export const advanceConnectionRevisions = (current: SyncRevisions): SyncRevisions => ({
  connectionRevision: current.connectionRevision + 1,
  observationEpoch: current.observationEpoch + 1,
  agentSessionsRevision: current.agentSessionsRevision + 1,
})

/** A changed frame advances server truth before subscribers observe the event. */
export const advanceObservationEpoch = (current: number): number => current + 1
