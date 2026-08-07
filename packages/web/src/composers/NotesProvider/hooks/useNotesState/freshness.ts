export type HeldWindowReconciliation = {
  ready: boolean
  latestConnectionRevision: number
  reconciledConnectionRevision: number
}

export type ReconciliationDecision = {
  state: HeldWindowReconciliation
  reload: boolean
}

/** One NotesProvider space owns one snapshot/stream handshake. `baseline` is
 * the connection revision that belonged to the previous space (zero on the
 * initial mount); only a later successful open belongs to this bootstrap. */
export const beginHeldWindowReconciliation = (baseline: number): HeldWindowReconciliation => ({
  ready: false,
  latestConnectionRevision: baseline,
  reconciledConnectionRevision: baseline,
})

/** Record a successful EventSource open. Before reader boot completes it is
 * held; after boot it immediately claims one authoritative window reload. */
export const observeHeldWindowConnection = (
  current: HeldWindowReconciliation,
  connectionRevision: number,
): ReconciliationDecision => {
  const latestConnectionRevision = Math.max(current.latestConnectionRevision, connectionRevision)

  if (!current.ready || latestConnectionRevision <= current.reconciledConnectionRevision) {
    return {
      state: { ...current, latestConnectionRevision },
      reload: false,
    }
  }

  return {
    state: {
      ...current,
      latestConnectionRevision,
      reconciledConnectionRevision: latestConnectionRevision,
    },
    reload: true,
  }
}

/** Reader boot and stream open may finish in either order. The second one to
 * arrive claims the pending revision, so the first open reloads exactly once. */
export const markHeldWindowsReady = (current: HeldWindowReconciliation): ReconciliationDecision => {
  if (current.ready) {
    return { state: current, reload: false }
  }
  const ready = { ...current, ready: true }

  if (ready.latestConnectionRevision <= ready.reconciledConnectionRevision) {
    return { state: ready, reload: false }
  }

  return {
    state: {
      ...ready,
      reconciledConnectionRevision: ready.latestConnectionRevision,
    },
    reload: true,
  }
}

/** Same-space responses still race (boot A, reconnect B). Space and monotonic
 * sequence must both match before either success or failure may publish state. */
export const isLatestRequest = (
  request: { space: string; sequence: number },
  current: { space: string; sequence: number },
): boolean => request.space === current.space && request.sequence === current.sequence
