// SQLite driver of the meta-DB (default layer home; one schema, many drivers).
// canon: docs/architecture.md#p9

import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { createAbilityAvailabilityFacet } from './drivers/sqlite/abilityAvailability'
import { createAbilityCreateFacet } from './drivers/sqlite/abilityCreate'
import { createAbilityPlacementFacet } from './drivers/sqlite/abilityPlacement'
import { createAbilityPreferencesFacet } from './drivers/sqlite/abilityPreferences'
import { createAgentDeltaCursorsFacet } from './drivers/sqlite/agentDeltaCursors'
import { createAuthFacet } from './drivers/sqlite/auth'
import { createCausalOutboxFacet } from './drivers/sqlite/causalOutbox'
import type { SqliteDriverCtx } from './drivers/sqlite/context'
import { createContextOrderFacet } from './drivers/sqlite/contextOrder'
import { createContextSetsFacet } from './drivers/sqlite/contextSets'
import { createFavoritesFacet } from './drivers/sqlite/favorites'
import { createFoldersFacet } from './drivers/sqlite/folders'
import { createGatewayFacet } from './drivers/sqlite/gateway'
import { createIdentityFacet } from './drivers/sqlite/identity'
import { createImportReservationsFacet, withJobGuards } from './drivers/sqlite/importReservations'
import { createInstallationGenerationFacet } from './drivers/sqlite/installationGeneration'
import { createJobsFacet } from './drivers/sqlite/jobs'
import { createOAuthFacet } from './drivers/sqlite/oauth'
import { createOwnerProofsFacet } from './drivers/sqlite/ownerProofs'
import { createProjectsFacet } from './drivers/sqlite/projects'
import { createRestoreOperationsFacet } from './drivers/sqlite/restoreOperations'
import { createRestoreTerminalFacet } from './drivers/sqlite/restoreTerminal'
import { createRetrievalLogFacet } from './drivers/sqlite/retrievalLog'
import { createRevisionsFacet } from './drivers/sqlite/revisions'
import { createScopePinsFacet } from './drivers/sqlite/scopePins'
import { createSessionAuditFacet } from './drivers/sqlite/sessionAudit'
import { createSessionsFacet } from './drivers/sqlite/sessions'
import { createSpaceLifecycleFacet } from './drivers/sqlite/spaceLifecycle'
import { createSpacesFacet } from './drivers/sqlite/spaces'
import { IN_MEMORY_DB } from './metaDbUrl'
import { runSqliteMigrations } from './migrations'
import { spaceOfRow, type SpaceRow } from './rows'
import type { GrantMemberToActiveSpaceResult, MetaDb, SpaceRole } from './types'

/** Gate the boot-time reclaim below this freelist size — pages, not bytes:
 *  64 pages ≈ 256 KiB at the 4 KiB default. */
const META_RECLAIM_MIN_FREE_PAGES = 64

export class SqliteMetaDb implements MetaDb {
  private db: DatabaseSync | null = null
  private initPromise: Promise<void> | null = null
  private readonly path: string
  private readonly ctx: SqliteDriverCtx = ((self: SqliteMetaDb): SqliteDriverCtx => ({
    ensureInit: () => self.ensureInit(),
    close: () => self.close(),
    get required() {
      return self.required
    },
  }))(this)

  constructor(path: string) {
    this.path = path
  }

  /** Lazy single-flight init: the first call validates and advances the schema. */
  private ensureInit(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = Promise.resolve().then(() => {
        if (this.path !== IN_MEMORY_DB) {
          mkdirSync(dirname(this.path), { recursive: true })
        }
        this.db = new DatabaseSync(this.path)
        // SQLite's built-in LOWER() folds ASCII only — a Unicode query would
        // silently miss; JS toLowerCase keeps one search semantics across all drivers.
        this.db.function('lower_u', { deterministic: true }, (s: unknown) =>
          typeof s === 'string' ? s.toLowerCase() : (s as null),
        )
        runSqliteMigrations(this.db)
        // Return freed meta pages to the OS. incremental_vacuum is a NO-OP unless
        // auto_vacuum===2 — gate on the mode FIRST, then on the freelist. This is a
        // one-shot synchronous pass at init (before Fastify onReady): a large freelist
        // delays BOOT, never live traffic (P5).
        const metaMode = Number(
          (this.db.prepare('PRAGMA auto_vacuum').get() as { auto_vacuum?: number } | undefined)
            ?.auto_vacuum ?? 0,
        )
        const freeBefore = Number(
          (
            this.db.prepare('PRAGMA freelist_count').get() as
              { freelist_count?: number } | undefined
          )?.freelist_count ?? 0,
        )

        if (metaMode === 2 && freeBefore >= META_RECLAIM_MIN_FREE_PAGES) {
          this.db.exec('PRAGMA incremental_vacuum')
          this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
          const freeAfter = Number(
            (
              this.db.prepare('PRAGMA freelist_count').get() as
                { freelist_count?: number } | undefined
            )?.freelist_count ?? 0,
          )
          console.log(
            `[notarium] meta index reclaim: freelist ${freeBefore} → ${freeAfter} pages returned to the OS`,
          )
        }
      })
      const attempt = this.initPromise
      void attempt.catch(() => {
        if (this.initPromise === attempt) {
          try {
            this.db?.close()
          } catch {
            // The migration error remains the useful failure; retry opens a new handle.
          }
          this.db = null
          this.initPromise = null
        }
      })
    }

    return this.initPromise
  }

  private get required(): DatabaseSync {
    if (!this.db) {
      throw new Error('meta db not initialised — call init() first')
    }

    return this.db
  }

  async close(): Promise<void> {
    this.db?.close()
    this.db = null
    this.initPromise = null
  }

  // ── identity facet ──────────────────────────────────────────────────

  readonly identity = createIdentityFacet(this.ctx)

  readonly restoreOperations = createRestoreOperationsFacet(this.ctx)

  readonly restoreTerminal = createRestoreTerminalFacet(this.ctx)

  readonly spaceLifecycle = createSpaceLifecycleFacet(this.ctx)

  readonly causalOutbox = createCausalOutboxFacet(this.ctx)

  readonly installationGeneration = createInstallationGenerationFacet(this.ctx)

  readonly ownerProofs = createOwnerProofsFacet(this.ctx)

  // ── space registry facet ────────────────────────────────────────────

  readonly spaces = createSpacesFacet(this.ctx)

  async adoptLegacyRows(legacySlug: string): Promise<void> {
    await this.ensureInit()
    // Legacy pre-spaces rows carry space='' — stamp them with the resolved space id.
    this.required
      .prepare(
        `UPDATE note_identity SET space = (SELECT id FROM spaces WHERE slug = ?)
         WHERE space = '' AND EXISTS (SELECT 1 FROM spaces WHERE slug = ?)`,
      )
      .run(legacySlug, legacySlug)
  }

  async grantMemberToActiveSpace(
    spaceId: string,
    username: string,
    role: SpaceRole,
    createdAt: string,
  ): Promise<GrantMemberToActiveSpaceResult> {
    await this.ensureInit()
    const db = this.required
    // IMMEDIATE takes the writer reservation before validation: another connection
    // cannot archive/purge after our read and before the membership upsert.
    db.exec('BEGIN IMMEDIATE')
    try {
      const row = db.prepare('SELECT * FROM spaces WHERE id = ?').get(spaceId) as
        SpaceRow | undefined

      if (!row) {
        db.exec('COMMIT')
        return { status: 'missing' }
      }
      const space = spaceOfRow(row)

      if (space.archivedAt) {
        db.exec('COMMIT')
        return { status: 'archived', space }
      }
      db.prepare(
        `INSERT INTO space_members (space, username, role, created_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(space, username) DO UPDATE SET role = excluded.role`,
      ).run(spaceId, username, role, createdAt)
      db.exec('COMMIT')
      return { status: 'granted', space }
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }

  async purgeSpace(spaceId: string): Promise<void> {
    await this.ensureInit()
    // Every import that still holds claims in this space (#302). One of them may be
    // inside a fenced write RIGHT NOW, holding that job's guard across its physical
    // write, and the erase below deletes the very claim that write proved itself
    // against — so it queues behind the bytes instead of pulling the row out from
    // under them. The Postgres twin gets the same exclusion for free: its
    // `DELETE FROM import_reservations` waits on the header row the in-flight write
    // holds FOR UPDATE. A reservation created AFTER this read is not covered, and is
    // not covered on either dialect: neither orders a purge against an import that
    // begins inside it.
    const holders = (
      this.required
        .prepare('SELECT DISTINCT job_id FROM import_reservations WHERE space = ?')
        .all(spaceId) as Array<{ job_id: string }>
    ).map((row) => row.job_id)

    await withJobGuards(holders, async () => {
      this.eraseSpaceRows(spaceId)
    })
  }

  /** The erase itself: ONE synchronous transaction, so once it starts nothing of
   *  this process interleaves with it. */
  private eraseSpaceRows(spaceId: string): void {
    const db = this.required
    db.exec('BEGIN IMMEDIATE')
    try {
      const current = db
        .prepare('SELECT phase FROM space_lifecycle WHERE space = ?')
        .get(spaceId) as { phase: string } | undefined

      if (
        current?.phase === 'metadata-cleaned' ||
        current?.phase === 'physical-cleaned' ||
        current?.phase === 'purged'
      ) {
        db.exec('COMMIT')
        return
      }
      const lifecycleAt = new Date().toISOString()

      if (current?.phase !== 'purge-intent') {
        db.prepare(
          `INSERT INTO space_lifecycle
            (space, phase, generation, cleanup_manifest, changed_at, changed_by)
           VALUES (?, 'purge-intent', 1, NULL, ?, NULL)
           ON CONFLICT(space) DO UPDATE SET
             phase = 'purge-intent',
             generation = space_lifecycle.generation + 1,
             changed_at = excluded.changed_at`,
        ).run(spaceId, lifecycleAt)
      }
      const blocker = db
        .prepare(
          `SELECT id, kind FROM (
             SELECT id, 'restore' AS kind, space, phase FROM restore_operations
             UNION ALL
             SELECT id, 'ability-create' AS kind, space, phase FROM ability_create_operations
           ) AS operations
            WHERE space = ? AND phase NOT IN ('succeeded', 'rejected')
            LIMIT 1`,
        )
        .get(spaceId) as { id: string; kind: string } | undefined

      if (blocker) {
        throw new Error(`space purge blocked by ${blocker.kind} operation: ${blocker.id}`)
      }
      db.prepare(
        "INSERT OR IGNORE INTO revision_purge_fences (kind, entity_id, space) VALUES ('space', ?, ?)",
      ).run(spaceId, spaceId)
      // Blobs are content-addressed and shared across spaces: drop a blob only
      // when its last referrer leaves.
      const hashes = (
        db
          .prepare(
            `SELECT DISTINCT content_hash AS h FROM note_revisions WHERE space = ? AND content_hash IS NOT NULL`,
          )
          .all(spaceId) as Array<{ h: string }>
      ).map((r) => r.h)
      db.prepare('DELETE FROM revision_heads WHERE space = ?').run(spaceId)
      db.prepare('DELETE FROM note_revisions WHERE space = ?').run(spaceId)
      const stillUsed = db.prepare('SELECT 1 FROM note_revisions WHERE content_hash = ? LIMIT 1')
      const dropBlob = db.prepare('DELETE FROM revision_blobs WHERE hash = ?')

      for (const h of hashes) {
        if (!stillUsed.get(h)) {
          dropBlob.run(h)
        }
      }
      db.prepare('DELETE FROM owner_proof_receipts WHERE space = ?').run(spaceId)
      db.prepare('DELETE FROM note_owner_proofs WHERE space = ?').run(spaceId)
      db.prepare('DELETE FROM note_identity WHERE space = ?').run(spaceId)
      // An import's destination claims die with the space they point into (#302).
      // The claims cascade with the header; a row left behind would hold paths in a
      // space that no longer exists, and its `activeJobIds` entry would keep the
      // terminal-cleanup pass fetching a job row this method also deletes.
      db.prepare('DELETE FROM import_reservations WHERE space = ?').run(spaceId)
      db.prepare('DELETE FROM restore_operations WHERE space = ?').run(spaceId)
      db.prepare('DELETE FROM ability_create_operations WHERE space = ?').run(spaceId)
      db.prepare('DELETE FROM causal_outbox WHERE space = ?').run(spaceId)
      // The type-aware project FK cascades both cursor tables from this parent
      // delete. Keeping cleanup parent-first matches concurrent session advance.
      db.prepare('DELETE FROM ability_project_bindings WHERE home_space = ?').run(spaceId)
      db.prepare('DELETE FROM ability_availability WHERE home_space = ?').run(spaceId)
      db.prepare('DELETE FROM ability_preferences WHERE space_id = ?').run(spaceId)
      // The forwarding rows of this Space go with the overrides they forward.
      db.prepare('DELETE FROM ability_placement_trail WHERE space_id = ?').run(spaceId)
      db.prepare('DELETE FROM folders WHERE space = ?').run(spaceId)
      db.prepare('DELETE FROM favorites WHERE space = ?').run(spaceId)
      db.prepare(
        'DELETE FROM context_set_attachments WHERE target_space = ? OR set_id IN (SELECT id FROM context_sets WHERE home_space = ?)',
      ).run(spaceId, spaceId)
      db.prepare('DELETE FROM context_sets WHERE home_space = ?').run(spaceId)
      // Drop pins whose SCOPE lived here; a pin whose NOTE lived here is left to
      // degrade at resolve (no eager sweep).
      db.prepare('DELETE FROM context_scope_pins WHERE target_space = ?').run(spaceId)
      db.prepare('DELETE FROM context_order WHERE target_space = ?').run(spaceId)
      db.prepare('DELETE FROM space_members WHERE space = ?').run(spaceId)
      // On-disk artifacts these jobs pointed at are NOT swept here — the runner's
      // TTL GC owns the artifact filesystem. canon: docs/jobs.md#artifacts
      db.prepare('DELETE FROM jobs WHERE space = ?').run(spaceId)
      // Defensive: a personal space is never purged, but NULL any orphaned pointer
      // rather than let it dangle.
      db.prepare('UPDATE users SET personal_space = NULL WHERE personal_space = ?').run(spaceId)
      // Scrub the id from every PAT narrowing list. Emptied stays '[]' (no access),
      // NEVER NULL (which means "all grants") — fail-closed.
      db.prepare(
        `UPDATE pats SET spaces = (
           SELECT json_group_array(j.value) FROM json_each(pats.spaces) j WHERE j.value != ?
         ) WHERE spaces IS NOT NULL`,
      ).run(spaceId)
      for (const table of [
        'oauth_auth_codes',
        'oauth_access_tokens',
        'oauth_refresh_tokens',
      ] as const) {
        db.prepare(
          `UPDATE ${table} SET spaces = (
             SELECT json_group_array(grant.value)
               FROM json_each(${table}.spaces) AS grant
              WHERE grant.value != ?
           ) WHERE spaces IS NOT NULL`,
        ).run(spaceId)
      }
      db.prepare('DELETE FROM spaces WHERE id = ?').run(spaceId)
      db.prepare(
        `UPDATE space_lifecycle SET
           phase = 'metadata-cleaned', generation = generation + 1, changed_at = ?
         WHERE space = ?`,
      ).run(new Date().toISOString(), spaceId)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }

  // ── project registry facet ──────────────────────────────────────────

  readonly projects = createProjectsFacet(this.ctx)

  readonly folders = createFoldersFacet(this.ctx)

  // ── favorites facet ────────────────────────────────────────────────

  readonly favorites = createFavoritesFacet(this.ctx)

  // ── context sets facet ─────────────────────────────────────────────

  readonly contextSets = createContextSetsFacet(this.ctx)

  // ── scope pins facet ───────────────────────────────────────────────

  readonly scopePins = createScopePinsFacet(this.ctx)

  // ── context order facet ────────────────────────────────────────────

  readonly contextOrder = createContextOrderFacet(this.ctx)

  readonly abilityAvailability = createAbilityAvailabilityFacet(this.ctx)

  readonly abilityCreate = createAbilityCreateFacet(this.ctx)

  readonly abilityPreferences = createAbilityPreferencesFacet(this.ctx)

  readonly abilityPlacement = createAbilityPlacementFacet(this.ctx)

  // ── agent retrieval audit facet ────────────────────────────────────

  readonly retrievalLog = createRetrievalLogFacet(this.ctx)

  // ── auth facet ──────────────────────────────────────────────────────

  readonly auth = createAuthFacet(this.ctx)

  // ── MCP gateway state facet ─────────────────────────────────────────

  readonly gateway = createGatewayFacet(this.ctx)

  readonly agentDeltaCursors = createAgentDeltaCursorsFacet(this.ctx)

  readonly sessions = createSessionsFacet(this.ctx)

  readonly sessionAudit = createSessionAuditFacet(this.ctx)

  // ── OAuth facet ─────────────────────────────────────────────────────

  readonly oauth = createOAuthFacet(this.ctx)

  // ── durable job facet ────────────────────────────────────
  //
  // node:sqlite is fully synchronous, so the claim UPDATE…RETURNING is atomic by
  // construction — no FOR UPDATE SKIP LOCKED, exactly one writer.
  // canon: docs/jobs.md#single-flight-the-hard-part

  readonly jobs = createJobsFacet(this.ctx)

  readonly importReservations = createImportReservationsFacet(this.ctx)

  // ── revision journal facet ──────────────────────────────────────────

  readonly revisions = createRevisionsFacet(this.ctx)
}
