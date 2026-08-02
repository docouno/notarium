export type PhaseGateMode = 'read' | 'mutation'

type Release = () => void

type Waiter = {
  mode: PhaseGateMode
  enter: (release: Release) => void
}

/** A fair, batched two-phase gate.
 *
 * Callers in the active mode run together while nobody from the opposite mode
 * is waiting. Once an opposite waiter arrives, later callers queue behind it;
 * the next contiguous cohort is admitted as a batch when the active cohort
 * drains. This keeps read and mutation admission bounded without serializing
 * peers that belong to the same phase.
 */
export class PhaseGate {
  private activeMode: PhaseGateMode | null = null
  private active = 0
  private waiting: Waiter[] = []
  private idleWaiters: Array<() => void> = []

  acquire(mode: PhaseGateMode): Promise<Release> {
    return new Promise((enter) => {
      const waiter = { mode, enter }

      if (this.activeMode === null || (this.activeMode === mode && this.waiting.length === 0)) {
        this.admit(waiter)
        return
      }
      this.waiting.push(waiter)
    })
  }

  settle(): Promise<void> {
    if (this.active === 0 && this.waiting.length === 0) {
      return Promise.resolve()
    }

    return new Promise((resolve) => {
      this.idleWaiters.push(resolve)
    })
  }

  private admit(waiter: Waiter): void {
    this.activeMode = waiter.mode
    this.active += 1
    let held = true

    waiter.enter(() => {
      if (!held) {
        return
      }
      held = false
      this.active -= 1
      if (this.active === 0) {
        this.activeMode = null
        this.drain()
      }
    })
  }

  private drain(): void {
    const mode = this.waiting[0]?.mode

    if (mode) {
      const cohort: Waiter[] = []

      while (this.waiting[0]?.mode === mode) {
        cohort.push(this.waiting.shift()!)
      }
      for (const waiter of cohort) {
        this.admit(waiter)
      }

      return
    }
    const waiters = this.idleWaiters

    this.idleWaiters = []
    for (const resolve of waiters) {
      resolve()
    }
  }
}
