import { type CausalOutboxPersistence, type CausalOutboxRecord } from '../types'

export class InMemoryCausalOutboxPersistence implements CausalOutboxPersistence {
  private readonly records: CausalOutboxRecord[] = []
  private readonly deliveries = new Map<string, Map<string, string>>()
  private nextId = 1

  async init(): Promise<void> {}

  async append(input: Omit<CausalOutboxRecord, 'id' | 'acknowledgedAt'>) {
    return this.appendForRestoreTerminal(input)
  }

  appendForRestoreTerminal(input: Omit<CausalOutboxRecord, 'id' | 'acknowledgedAt'>) {
    const record: CausalOutboxRecord = {
      ...input,
      id: String(this.nextId++),
      acknowledgedAt: null,
    }

    this.records.push(record)
    return { ...record }
  }

  snapshotForRestoreTerminal() {
    return {
      records: this.records.map((record) => ({ ...record })),
      deliveries: new Map(
        [...this.deliveries].map(([subscriber, deliveries]) => [subscriber, new Map(deliveries)]),
      ),
      nextId: this.nextId,
    }
  }

  restoreForRestoreTerminal(snapshot: ReturnType<this['snapshotForRestoreTerminal']>): void {
    this.records.splice(
      0,
      this.records.length,
      ...snapshot.records.map((record) => ({ ...record })),
    )
    this.deliveries.clear()
    for (const [subscriber, deliveries] of snapshot.deliveries) {
      this.deliveries.set(subscriber, new Map(deliveries))
    }
    this.nextId = snapshot.nextId
  }

  async pending(subscriberId: string, limit: number): Promise<CausalOutboxRecord[]> {
    if (!subscriberId || subscriberId.length > 200) {
      throw new Error('causal outbox subscriber id must be a bounded non-empty string')
    }
    if (!Number.isInteger(limit) || limit < 0) {
      throw new Error('causal outbox limit must be a non-negative integer')
    }

    return this.records
      .filter((record) => !this.deliveries.get(subscriberId)?.has(record.id))
      .slice(0, limit)
      .map((record) => ({ ...record }))
  }

  async acknowledge(subscriberId: string, ids: readonly string[], at: string): Promise<void> {
    if (!subscriberId || subscriberId.length > 200) {
      throw new Error('causal outbox subscriber id must be a bounded non-empty string')
    }
    const wanted = new Set(ids)
    const deliveries = this.deliveries.get(subscriberId) ?? new Map<string, string>()

    this.deliveries.set(subscriberId, deliveries)

    for (const record of this.records) {
      if (wanted.has(record.id) && !deliveries.has(record.id)) {
        deliveries.set(record.id, at)
      }
    }
  }
}
