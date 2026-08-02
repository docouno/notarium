import type {
  ContextSetAttachmentRecord,
  ContextSetItemRef,
  ContextSetRecord,
  ContextSetsPersistence,
  ContextSetTargetKind,
} from '@notarium/server'

/** In-memory twin of the context-sets facet (#209) for the fake server — mirrors the
 *  sqlite/pg drivers' behaviour (delete cascades attachments; attach upserts). */
export class InMemoryContextSets implements ContextSetsPersistence {
  private sets = new Map<string, ContextSetRecord>()
  private attachments: ContextSetAttachmentRecord[] = []

  clear(): void {
    this.sets.clear()
    this.attachments = []
  }

  async createSet(record: ContextSetRecord): Promise<void> {
    this.sets.set(record.id, { ...record, items: record.items.map((i) => ({ ...i })) })
  }

  async getSet(id: string): Promise<ContextSetRecord | null> {
    const s = this.sets.get(id)
    return s ? { ...s, items: s.items.map((i) => ({ ...i })) } : null
  }

  async listSetsForSpace(homeSpace: string): Promise<ContextSetRecord[]> {
    return [...this.sets.values()]
      .filter((s) => s.homeSpace === homeSpace)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((s) => ({ ...s, items: s.items.map((i) => ({ ...i })) }))
  }

  async renameSet(id: string, name: string): Promise<void> {
    const s = this.sets.get(id)

    if (s) {
      s.name = name
    }
  }

  // Single-threaded JS: the read-mutate-write runs to completion with no await inside, so
  // it is atomic — the same no-lost-update guarantee the sqlite/pg drivers give.
  async addItem(id: string, ref: ContextSetItemRef): Promise<ContextSetRecord | null> {
    const s = this.sets.get(id)

    if (!s) {
      return null
    }
    if (!s.items.some((i) => i.noteId === ref.noteId)) {
      s.items = [...s.items, { ...ref }]
    }

    return { ...s, items: s.items.map((i) => ({ ...i })) }
  }

  async removeItem(id: string, noteId: string): Promise<ContextSetRecord | null> {
    const s = this.sets.get(id)

    if (!s) {
      return null
    }
    s.items = s.items.filter((i) => i.noteId !== noteId)
    return { ...s, items: s.items.map((i) => ({ ...i })) }
  }

  // Reorder items SLOT-PRESERVING (#210): named ids refill named slots in request order;
  // an unnamed current item (deduped-hidden in the reordering scope, or concurrently added)
  // keeps its original slot — mirrors the drivers' `orderItems`.
  async reorderItems(id: string, noteIds: readonly string[]): Promise<ContextSetRecord | null> {
    const s = this.sets.get(id)

    if (!s) {
      return null
    }
    const byId = new Map(s.items.map((it) => [it.noteId, it]))
    const named = new Set<string>()
    const queue: ContextSetItemRef[] = []

    for (const noteId of noteIds) {
      const it = byId.get(noteId)

      if (it && !named.has(noteId)) {
        named.add(noteId)
        queue.push(it)
      }
    }
    let qi = 0
    s.items = s.items.map((it) => (named.has(it.noteId) ? queue[qi++] : it))
    return { ...s, items: s.items.map((i) => ({ ...i })) }
  }

  async deleteSet(id: string): Promise<void> {
    this.sets.delete(id)
    this.attachments = this.attachments.filter((a) => a.setId !== id)
  }

  async attach(record: ContextSetAttachmentRecord): Promise<void> {
    const i = this.attachments.findIndex(
      (a) =>
        a.setId === record.setId &&
        a.targetKind === record.targetKind &&
        a.targetId === record.targetId,
    )

    if (i >= 0) {
      this.attachments[i] = { ...record }
    } else {
      this.attachments.push({ ...record })
    }
  }

  async detach(setId: string, targetKind: ContextSetTargetKind, targetId: string): Promise<void> {
    this.attachments = this.attachments.filter(
      (a) => !(a.setId === setId && a.targetKind === targetKind && a.targetId === targetId),
    )
  }

  async attachmentsForSet(setId: string): Promise<ContextSetAttachmentRecord[]> {
    return this.attachments
      .filter((a) => a.setId === setId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((a) => ({ ...a }))
  }

  async setsForTarget(
    targetKind: ContextSetTargetKind,
    targetId: string,
  ): Promise<ContextSetRecord[]> {
    const ids = this.attachments
      .filter((a) => a.targetKind === targetKind && a.targetId === targetId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((a) => a.setId)
    return ids
      .map((id) => this.sets.get(id))
      .filter((s): s is ContextSetRecord => s != null)
      .map((s) => ({ ...s, items: s.items.map((i) => ({ ...i })) }))
  }
}
