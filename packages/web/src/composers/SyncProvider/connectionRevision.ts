export type SyncRevisions = { connectionRevision: number; observationEpoch: number }

/** EventSource reconnects reuse the same object, so `open` — not construction —
 * advances both the render signal and the synchronous request epoch. */
export const advanceConnectionRevisions = (current: SyncRevisions): SyncRevisions => ({
  connectionRevision: current.connectionRevision + 1,
  observationEpoch: current.observationEpoch + 1,
})

/** A changed frame advances server truth before subscribers observe the event. */
export const advanceObservationEpoch = (current: number): number => current + 1
