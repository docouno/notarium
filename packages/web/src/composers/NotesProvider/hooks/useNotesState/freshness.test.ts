import { describe, expect, it, vi } from 'vitest'

import {
  beginHeldWindowReconciliation,
  isLatestRequest,
  markHeldWindowsReady,
  observeHeldWindowConnection,
} from './freshness'

describe('NotesProvider snapshot freshness', () => {
  it('reloads once when the first connection opens before reader boot is ready', () => {
    const reload = vi.fn()
    let state = beginHeldWindowReconciliation(0)
    let decision = observeHeldWindowConnection(state, 1)

    state = decision.state
    if (decision.reload) {
      reload()
    }
    decision = markHeldWindowsReady(state)
    state = decision.state
    if (decision.reload) {
      reload()
    }
    decision = markHeldWindowsReady(state)
    if (decision.reload) {
      reload()
    }

    expect(reload).toHaveBeenCalledOnce()
    expect(state.reconciledConnectionRevision).toBe(1)
  })

  it('reloads once when reader boot is ready before the first connection opens', () => {
    const reload = vi.fn()
    let state = beginHeldWindowReconciliation(0)
    let decision = markHeldWindowsReady(state)

    state = decision.state
    if (decision.reload) {
      reload()
    }
    decision = observeHeldWindowConnection(state, 1)
    state = decision.state
    if (decision.reload) {
      reload()
    }
    decision = observeHeldWindowConnection(state, 1)
    if (decision.reload) {
      reload()
    }

    expect(reload).toHaveBeenCalledOnce()
    expect(state.reconciledConnectionRevision).toBe(1)
  })

  it('coalesces multiple opens before boot and reloads the latest revision once', () => {
    let state = beginHeldWindowReconciliation(0)

    state = observeHeldWindowConnection(state, 1).state
    state = observeHeldWindowConnection(state, 2).state
    const decision = markHeldWindowsReady(state)

    expect(decision.reload).toBe(true)
    expect(decision.state.reconciledConnectionRevision).toBe(2)
  })

  it('uses the previous-space revision as the switch baseline', () => {
    let state = beginHeldWindowReconciliation(4)

    state = observeHeldWindowConnection(state, 4).state
    let decision = markHeldWindowsReady(state)

    expect(decision.reload).toBe(false)
    decision = observeHeldWindowConnection(decision.state, 5)
    expect(decision.reload).toBe(true)
    expect(decision.state.reconciledConnectionRevision).toBe(5)
  })

  it('rejects a stale tree A response after newer same-space request B started', () => {
    const requestA = { space: 'work', sequence: 1 }
    const requestB = { space: 'work', sequence: 2 }

    expect(isLatestRequest(requestB, requestB)).toBe(true)
    expect(isLatestRequest(requestA, requestB)).toBe(false)
    expect(isLatestRequest({ space: 'old', sequence: 2 }, requestB)).toBe(false)
  })
})
