import {
  SPACE_LIFECYCLE_PHASE,
  type SpaceLifecyclePersistence,
  type SpaceLifecycleRecord,
} from '../types'

export class InMemorySpaceLifecyclePersistence implements SpaceLifecyclePersistence {
  private readonly records = new Map<string, SpaceLifecycleRecord>()
  private mutationTail: Promise<void> = Promise.resolve()

  /** SQLite/PostgreSQL serialize lifecycle admission in one transaction. The
   * in-memory twin exposes the same critical section so a restore accept cannot
   * straddle active→closing or race another replay-key accept. */
  async withExclusive<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.mutationTail
    let release!: () => void

    this.mutationTail = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await task()
    } finally {
      release()
    }
  }

  async init(): Promise<void> {}

  async ensure(
    space: string,
    phase: typeof SPACE_LIFECYCLE_PHASE.active | typeof SPACE_LIFECYCLE_PHASE.archived,
    now: string,
  ): Promise<SpaceLifecycleRecord> {
    return this.withExclusive(async () => {
      const current = this.records.get(space)

      if (current) {
        return { ...current }
      }
      const record: SpaceLifecycleRecord = {
        space,
        phase,
        generation: 1,
        cleanupManifest: null,
        changedAt: now,
        changedBy: null,
      }

      this.records.set(space, record)
      return { ...record }
    })
  }

  async get(space: string): Promise<SpaceLifecycleRecord | null> {
    return this.getForRestoreTerminal(space)
  }

  getForRestoreTerminal(space: string): SpaceLifecycleRecord | null {
    const record = this.records.get(space)
    return record ? { ...record } : null
  }

  async transition(input: {
    space: string
    expectedPhases: readonly SpaceLifecycleRecord['phase'][]
    phase: SpaceLifecycleRecord['phase']
    changedAt: string
    changedBy?: string | null
    cleanupManifest?: string | null
  }) {
    return this.withExclusive(async () => {
      const current = this.records.get(input.space)

      if (!current) {
        return { status: 'missing' } as const
      }
      if (!input.expectedPhases.includes(current.phase)) {
        return { status: 'phase-conflict', lifecycle: { ...current } } as const
      }
      const lifecycle: SpaceLifecycleRecord = {
        ...current,
        phase: input.phase,
        generation: current.generation + 1,
        changedAt: input.changedAt,
        changedBy: input.changedBy ?? null,
        ...(input.cleanupManifest !== undefined ? { cleanupManifest: input.cleanupManifest } : {}),
      }

      this.records.set(input.space, lifecycle)
      return { status: 'transitioned', lifecycle: { ...lifecycle } } as const
    })
  }

  async listUnfinished(): Promise<SpaceLifecycleRecord[]> {
    return [...this.records.values()]
      .filter(
        (record) =>
          record.phase !== SPACE_LIFECYCLE_PHASE.active &&
          record.phase !== SPACE_LIFECYCLE_PHASE.archived &&
          record.phase !== SPACE_LIFECYCLE_PHASE.purged,
      )
      .sort((left, right) => left.space.localeCompare(right.space))
      .map((record) => ({ ...record }))
  }
}
