// Postgres driver of the meta-DB (P9: one schema, many drivers).
// canon: docs/architecture.md#p9

import pg from 'pg'

import { createAuthFacet } from './drivers/pg/auth'
import type { PgDriverCtx } from './drivers/pg/context'
import { createContextOrderFacet } from './drivers/pg/contextOrder'
import { createContextSetsFacet } from './drivers/pg/contextSets'
import { createFavoritesFacet } from './drivers/pg/favorites'
import { createFoldersFacet } from './drivers/pg/folders'
import { createGatewayFacet } from './drivers/pg/gateway'
import { createIdentityFacet } from './drivers/pg/identity'
import { createJobsFacet } from './drivers/pg/jobs'
import { createOAuthFacet } from './drivers/pg/oauth'
import { createProjectsFacet } from './drivers/pg/projects'
import { createRetrievalLogFacet } from './drivers/pg/retrievalLog'
import { lockRevisionKeys } from './drivers/pg/revisionLocks'
import { createRevisionsFacet } from './drivers/pg/revisions'
import { createScopePinsFacet } from './drivers/pg/scopePins'
import { createSessionsFacet } from './drivers/pg/sessions'
import { createSpacesFacet } from './drivers/pg/spaces'
import { runPgMigrations } from './migrations'
import { spaceOfRow, type SpaceRow } from './rows'
import type { GrantMemberToActiveSpaceResult, MetaDb, SpaceRole } from './types'

export class PgMetaDb implements MetaDb {
  private pool: pg.Pool | null = null
  private initPromise: Promise<void> | null = null
  private closePromise: Promise<void> | null = null
  private readonly url: string
  private readonly ctx: PgDriverCtx = ((self: PgMetaDb): PgDriverCtx => ({
    ensureInit: () => self.ensureInit(),
    close: () => self.close(),
    get required() {
      return self.required
    },
  }))(this)

  constructor(url: string) {
    this.url = url
  }

  private ensureInit(): Promise<void> {
    if (this.closePromise) {
      return this.closePromise.then(() => this.ensureInit())
    }

    if (!this.initPromise) {
      const attempt = (async () => {
        // A migration asset may legitimately use temp objects, SET ROLE, LISTEN,
        // session advisory locks, or other backend-local state. Never let that
        // backend enter the application pool: the connection belongs solely to
        // migration startup and is physically closed before the pool exists.
        const client = new pg.Client({ connectionString: this.url })

        try {
          await client.connect()
          const schema = await runPgMigrations(client)
          await client.end()
          this.pool = new pg.Pool({
            connectionString: this.url,
            // The configured path may contain a not-yet-existing schema before
            // the validated target. Pin every new backend before it can enter
            // the pool, so later DDL cannot turn that dormant entry into a
            // shadow for unqualified application queries.
            onConnect: async (poolClient) => {
              await poolClient.query(
                `SELECT pg_catalog.set_config(
                   'search_path',
                   pg_catalog.quote_ident($1),
                   false
                 )`,
                [schema],
              )
              const result = await poolClient.query(
                'SELECT pg_catalog.current_schemas(false)::text[] AS schemas',
              )
              const schemas = result.rows[0]?.schemas as string[] | undefined

              if (schemas?.length !== 1 || schemas[0] !== schema) {
                throw new Error(
                  `meta database application connection could not pin PostgreSQL schema ${schema}`,
                )
              }
            },
          })
        } catch (err) {
          await client.end().catch(() => {})
          throw err
        }
      })()
      this.initPromise = attempt
      void attempt.catch(() => {
        if (this.initPromise === attempt) {
          this.initPromise = null
        }
      })
    }

    return this.initPromise
  }

  private get required(): pg.Pool {
    if (!this.pool) {
      throw new Error('meta db not initialised — call init() first')
    }

    return this.pool
  }

  async close(): Promise<void> {
    if (!this.closePromise) {
      const currentInit = this.initPromise
      const attempt = (async () => {
        await currentInit?.catch(() => {})
        const pool = this.pool
        this.pool = null

        try {
          await pool?.end()
        } finally {
          if (this.initPromise === currentInit) {
            this.initPromise = null
          }
        }
      })()
      this.closePromise = attempt
    }

    const closing = this.closePromise

    try {
      await closing
    } finally {
      if (this.closePromise === closing) {
        this.closePromise = null
      }
    }
  }

  readonly identity = createIdentityFacet(this.ctx)

  readonly spaces = createSpacesFacet(this.ctx)

  async adoptLegacyRows(legacySlug: string): Promise<void> {
    await this.ensureInit()
    await this.required.query(
      `UPDATE note_identity SET space = (SELECT id FROM spaces WHERE slug = $1)
       WHERE space = '' AND EXISTS (SELECT 1 FROM spaces WHERE slug = $1)`,
      [legacySlug],
    )
  }

  async grantMemberToActiveSpace(
    spaceId: string,
    username: string,
    role: SpaceRole,
    createdAt: string,
  ): Promise<GrantMemberToActiveSpaceResult> {
    await this.ensureInit()
    const client = await this.required.connect()

    try {
      await client.query('BEGIN')
      // The row lock serializes this decision with archive/rename and with purge's
      // matching lock. If grant wins, a later purge removes the new membership;
      // if purge/archive wins, this transaction refuses without writing.
      const result = await client.query('SELECT * FROM spaces WHERE id = $1 FOR UPDATE', [spaceId])
      const row = result.rows[0] as SpaceRow | undefined

      if (!row) {
        await client.query('COMMIT')
        return { status: 'missing' }
      }
      const space = spaceOfRow(row)

      if (space.archivedAt) {
        await client.query('COMMIT')
        return { status: 'archived', space }
      }
      await client.query(
        `INSERT INTO space_members (space, username, role, created_at) VALUES ($1, $2, $3, $4)
           ON CONFLICT (space, username) DO UPDATE SET role = EXCLUDED.role`,
        [spaceId, username, role, createdAt],
      )
      await client.query('COMMIT')
      return { status: 'granted', space }
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  async purgeSpace(spaceId: string): Promise<void> {
    await this.ensureInit()
    const client = await this.required.connect()

    try {
      await client.query('BEGIN')
      await client.query("SELECT set_config('notarium.revision_purge_protocol', 'v26', true)")
      await lockRevisionKeys(client, 'space', [spaceId])
      // Serialize child cleanup with recovery grant. Without this early row lock,
      // purge could delete memberships, wait on the final space delete, then leave
      // a concurrent late grant orphaned after passing the cleanup point.
      await client.query('SELECT id FROM spaces WHERE id = $1 FOR UPDATE', [spaceId])
      await client.query(
        `INSERT INTO revision_purge_fences (kind, entity_id) VALUES ('space', $1)
         ON CONFLICT (kind, entity_id) DO NOTHING`,
        [spaceId],
      )
      const notesRes = await client.query(
        'SELECT DISTINCT note_id FROM note_revisions WHERE space = $1',
        [spaceId],
      )
      await lockRevisionKeys(
        client,
        'note',
        (notesRes.rows as Array<{ note_id: string }>).map(({ note_id }) => note_id),
      )
      // Shared content-addressed blobs: drop a blob only when its last referrer leaves (another space may share the hash).
      const hashesRes = await client.query(
        'SELECT DISTINCT content_hash AS h FROM note_revisions WHERE space = $1 AND content_hash IS NOT NULL',
        [spaceId],
      )
      const hashes = (hashesRes.rows as Array<{ h: string }>).map(({ h }) => h)
      await lockRevisionKeys(client, 'blob', hashes)
      await client.query('DELETE FROM note_revisions WHERE space = $1', [spaceId])
      for (const h of hashes) {
        const used = await client.query(
          'SELECT 1 FROM note_revisions WHERE content_hash = $1 LIMIT 1',
          [h],
        )

        if (!used.rows.length) {
          await client.query('DELETE FROM revision_blobs WHERE hash = $1', [h])
        }
      }
      await client.query('DELETE FROM note_identity WHERE space = $1', [spaceId])
      await client.query('DELETE FROM folders WHERE space = $1', [spaceId])
      await client.query('DELETE FROM favorites WHERE space = $1', [spaceId])
      await client.query(
        'DELETE FROM context_set_attachments WHERE target_space = $1 OR set_id IN (SELECT id FROM context_sets WHERE home_space = $1)',
        [spaceId],
      )
      await client.query('DELETE FROM context_sets WHERE home_space = $1', [spaceId])
      // Drop pins whose SCOPE lived here; a pin to a NOTE here degrades at resolve (no eager sweep).
      await client.query('DELETE FROM context_scope_pins WHERE target_space = $1', [spaceId])
      await client.query('DELETE FROM context_order WHERE target_space = $1', [spaceId])
      await client.query('DELETE FROM space_members WHERE space = $1', [spaceId])
      await client.query('DELETE FROM mcp_bookmarks WHERE space = $1', [spaceId])
      // Job rows only; on-disk artifacts are swept by the runner's TTL GC (this layer owns no filesystem).
      await client.query('DELETE FROM jobs WHERE space = $1', [spaceId])
      // Defensive — a personal space is never purged (the caller refuses it).
      await client.query('UPDATE users SET personal_space = NULL WHERE personal_space = $1', [
        spaceId,
      ])
      // Scrub the id from every PAT narrowing list; an emptied list stays '[]' (no
      // access), NEVER NULL (which means "all grants" — fail-closed).
      await client.query(
        `UPDATE pats SET spaces = (
           SELECT to_json(COALESCE(array_agg(j.value), ARRAY[]::text[]))::text
           FROM json_array_elements_text(pats.spaces::json) j WHERE j.value <> $1
         ) WHERE spaces IS NOT NULL`,
        [spaceId],
      )
      await client.query('DELETE FROM spaces WHERE id = $1', [spaceId])
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  readonly projects = createProjectsFacet(this.ctx)

  readonly folders = createFoldersFacet(this.ctx)

  readonly favorites = createFavoritesFacet(this.ctx)

  readonly contextSets = createContextSetsFacet(this.ctx)

  readonly scopePins = createScopePinsFacet(this.ctx)

  readonly contextOrder = createContextOrderFacet(this.ctx)

  readonly retrievalLog = createRetrievalLogFacet(this.ctx)

  readonly auth = createAuthFacet(this.ctx)

  readonly gateway = createGatewayFacet(this.ctx)

  readonly sessions = createSessionsFacet(this.ctx)

  readonly oauth = createOAuthFacet(this.ctx)

  // canon: docs/jobs.md#single-flight-the-hard-part
  readonly jobs = createJobsFacet(this.ctx)

  readonly revisions = createRevisionsFacet(this.ctx)
}
