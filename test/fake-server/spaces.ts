// In-memory SpacesPersistence for the e2e fake (#16, reshaped #100 phase 4, wired #127):
// the space registry behind the same facet the SQLite/PG drivers implement, so the
// REAL SpaceManager mints an opaque `space_id` (freshNoteId) decoupled from the slug
// — exactly as a meta-DB host does. Without this the fake ran id ≡ slug, hiding the
// whole phase 4 seam (id internal, slug on the wire via slugOf) from e2e: a handler that
// leaked a raw space-id where a slug belongs (or vice-versa) passed green.
//
// The same instance is handed to THREE consumers: the SpaceManager (as metaDb.spaces
// — so it resolves-or-mints space ids), createAuthService (as `spaces` — so me/PAT
// lists translate the id-keyed grants + personal pointer back to slugs, the production
// `slugById`/`idBySlug` path), and buildApp (as `spacesPersistence` — backing the
// PATCH space-rename endpoint, dormant until a #123 rename e2e exercises it). The fake
// keeps it an exact MIRROR of the manager's live entries via `seed(manager.list())`
// after every fixture swap, so id↔slug translation never sees a stale row.

import type { SpaceRecord, SpacesPersistence } from '@notarium/server'

export class InMemorySpaces implements SpacesPersistence {
  private rows = new Map<string, SpaceRecord>() // id → row

  /** Replace the whole registry — used to mirror SpaceManager.list() after a reset
   *  so a removed space drops and a re-added one's fresh id replaces the old. */
  seed(records: readonly SpaceRecord[]): void {
    this.rows.clear()
    for (const r of records) {
      this.rows.set(r.id, { ...r, aliases: [...r.aliases] })
    }
  }

  async upsert(record: SpaceRecord): Promise<void> {
    // Mirror the drivers' UNIQUE(slug): a DIFFERENT id claiming a live slug is a
    // collision (the rename caller maps it to 409). Aliases never shadow a current
    // slug — only the current-slug index is checked here.
    for (const r of this.rows.values()) {
      if (r.id !== record.id && r.slug === record.slug) {
        throw new Error(`UNIQUE constraint failed: spaces(slug) = ${record.slug}`)
      }
    }
    const existing = this.rows.get(record.id)
    this.rows.set(record.id, {
      ...record,
      aliases: [...record.aliases],
      // Preserve the mint moment on a re-upsert (rename/displayName refresh), like
      // the real drivers' insert-once createdAt.
      createdAt: existing?.createdAt ?? record.createdAt,
    })
  }

  /** Drop a row — the fake's half of metaDb.purgeSpace (#110): the real drivers wipe
   *  every child table + the spaces row transactionally; here the worlds are in-memory,
   *  so removing the registry row (id↔slug gone) is what the wire observes. */
  delete(id: string): void {
    this.rows.delete(id)
  }

  async getById(id: string): Promise<SpaceRecord | null> {
    const r = this.rows.get(id)
    return r ? { ...r, aliases: [...r.aliases] } : null
  }

  async getBySlug(slug: string): Promise<SpaceRecord | null> {
    for (const r of this.rows.values()) {
      if (r.slug === slug) {
        return { ...r, aliases: [...r.aliases] }
      }
    }

    return null
  }

  async list(): Promise<SpaceRecord[]> {
    return [...this.rows.values()].map((r) => ({ ...r, aliases: [...r.aliases] }))
  }
}
