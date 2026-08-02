import type { FavoriteEntityKind, FavoriteRecord, FavoritesPersistence } from '@notarium/server'

export class InMemoryFavorites implements FavoritesPersistence {
  private rows = new Map<string, FavoriteRecord>()

  clear(): void {
    this.rows.clear()
  }

  private key(owner: string, space: string, kind: FavoriteEntityKind, entityId: string): string {
    return `${owner}\0${space}\0${kind}\0${entityId}`
  }

  private ordered(rows: FavoriteRecord[]): FavoriteRecord[] {
    return rows
      .sort((a, b) => {
        if (a.rank == null && b.rank != null) {
          return 1
        }
        if (a.rank != null && b.rank == null) {
          return -1
        }
        if (a.rank != null && b.rank != null && a.rank !== b.rank) {
          return a.rank - b.rank
        }

        return b.createdAt.localeCompare(a.createdAt)
      })
      .map((r) => ({ ...r }))
  }

  async list(owner: string, space: string): Promise<FavoriteRecord[]> {
    return this.ordered(
      [...this.rows.values()].filter((r) => r.owner === owner && r.space === space),
    )
  }

  async ids(owner: string, space: string, kind: FavoriteEntityKind): Promise<string[]> {
    return this.ordered(
      [...this.rows.values()].filter(
        (r) => r.owner === owner && r.space === space && r.kind === kind,
      ),
    ).map((r) => r.entityId)
  }

  async has(
    owner: string,
    space: string,
    kind: FavoriteEntityKind,
    entityId: string,
  ): Promise<boolean> {
    return this.rows.has(this.key(owner, space, kind, entityId))
  }

  async add(record: FavoriteRecord): Promise<void> {
    this.rows.set(this.key(record.owner, record.space, record.kind, record.entityId), { ...record })
  }

  async remove(
    owner: string,
    space: string,
    kind: FavoriteEntityKind,
    entityId: string,
  ): Promise<void> {
    this.rows.delete(this.key(owner, space, kind, entityId))
  }

  async removeByEntity(owner: string, space: string, entityId: string): Promise<void> {
    for (const [key, row] of this.rows) {
      if (row.owner === owner && row.space === space && row.entityId === entityId) {
        this.rows.delete(key)
      }
    }
  }
}
