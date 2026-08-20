import type { ContextSetTargetKind, ScopePinRecord, ScopePinsPersistence } from '@notarium/server'

/** In-memory twin of the scope-pins facet (#209) for the fake server — mirrors the
 *  sqlite/pg drivers: keyed by (scope, note) so re-pinning upserts, never duplicates. */
export class InMemoryScopePins implements ScopePinsPersistence {
  private pins: ScopePinRecord[] = []

  clear(): void {
    this.pins = []
  }

  async addPin(record: ScopePinRecord): Promise<void> {
    const i = this.pins.findIndex(
      (p) =>
        p.targetKind === record.targetKind &&
        p.targetId === record.targetId &&
        p.noteId === record.noteId,
    )

    if (i >= 0) {
      this.pins[i] = { ...record }
    } else {
      this.pins.push({ ...record })
    }
  }

  async removePin(
    targetKind: ContextSetTargetKind,
    targetId: string,
    noteId: string,
  ): Promise<void> {
    this.pins = this.pins.filter(
      (p) => !(p.targetKind === targetKind && p.targetId === targetId && p.noteId === noteId),
    )
  }

  async pinsForTarget(
    targetKind: ContextSetTargetKind,
    targetId: string,
  ): Promise<ScopePinRecord[]> {
    return this.pins
      .filter((p) => p.targetKind === targetKind && p.targetId === targetId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((p) => ({ ...p }))
  }

  /** Re-address a role's pins when its package changes placement — the drivers'
   *  delete-then-update: whatever sits at the destination belongs to the package
   *  being moved, so it is cleared rather than colliding on the key. */
  moveRoleTarget(fromTargetId: string, toTargetId: string): void {
    this.pins = this.pins
      .filter((p) => !(p.targetKind === 'role' && p.targetId === toTargetId))
      .map((p) =>
        p.targetKind === 'role' && p.targetId === fromTargetId ? { ...p, targetId: toTargetId } : p,
      )
  }
}
