// Postgres driver of the meta-DB (P9: one schema, many drivers).
// canon: docs/architecture.md#p9

import pg from 'pg'

import { DEFAULT_CREDENTIAL_HEADER } from '@notarium/contract'
import { CAUSAL_BARRIER_KIND } from '@notarium/core'

import { REVISION_PURGE_PROTOCOL } from './consts'
import { createAbilityAvailabilityFacet } from './drivers/pg/abilityAvailability'
import { createAbilityCreateFacet } from './drivers/pg/abilityCreate'
import { createAbilityPlacementFacet } from './drivers/pg/abilityPlacement'
import { createAbilityPreferencesFacet } from './drivers/pg/abilityPreferences'
import { createAgentCallsFacet } from './drivers/pg/agentCalls'
import { createAgentDeltaCursorsFacet } from './drivers/pg/agentDeltaCursors'
import { createAuthFacet } from './drivers/pg/auth'
import { lockCausalBarriers } from './drivers/pg/causalBarriers'
import { createCausalOutboxFacet } from './drivers/pg/causalOutbox'
import type { PgDriverCtx } from './drivers/pg/context'
import { createContextOrderFacet } from './drivers/pg/contextOrder'
import { createContextSetsFacet } from './drivers/pg/contextSets'
import { createCredentialsFacet } from './drivers/pg/credentials'
import { createFavoritesFacet } from './drivers/pg/favorites'
import { createFoldersFacet } from './drivers/pg/folders'
import { createGatewayFacet } from './drivers/pg/gateway'
import { createIdentityFacet } from './drivers/pg/identity'
import { createImportReservationsFacet } from './drivers/pg/importReservations'
import { createInstallationGenerationFacet } from './drivers/pg/installationGeneration'
import { createJobsFacet } from './drivers/pg/jobs'
import {
  lockContextOrderScopesOfSpace,
  lockProviderAttachmentRows,
  lockProviderCredentialRows,
  lockProviderMembershipRow,
  lockProviderResourceRows,
  lockProviderSpaceRow,
  lockRevisionWideScan,
  lockSpaceIdentityRows,
} from './drivers/pg/lockOrder'
import { createOAuthFacet } from './drivers/pg/oauth'
import { createOwnerProofsFacet } from './drivers/pg/ownerProofs'
import { createProjectsFacet } from './drivers/pg/projects'
import {
  acceptProviderAttachment,
  createProviderAttachmentsFacet,
  detachProviderAttachment,
  offerProviderAttachment,
  transitionProviderAttachments,
} from './drivers/pg/providerAttachments'
import { createProviderCallLogFacet } from './drivers/pg/providerCallLog'
import { createProviderCiphertextsFacet } from './drivers/pg/providerCiphertexts'
import { createProviderResourcesFacet } from './drivers/pg/providerResources'
import { createRestoreOperationsFacet } from './drivers/pg/restoreOperations'
import { createRestoreTerminalFacet } from './drivers/pg/restoreTerminal'
import { createRetrievalLogFacet } from './drivers/pg/retrievalLog'
import { lockRevisionKeys } from './drivers/pg/revisionLocks'
import { createRevisionsFacet } from './drivers/pg/revisions'
import { createScopePinsFacet } from './drivers/pg/scopePins'
import { createSecretKeyringFacet } from './drivers/pg/secretKeyring'
import { createSessionAuditFacet } from './drivers/pg/sessionAudit'
import { createSessionsFacet } from './drivers/pg/sessions'
import { createSpaceLifecycleFacet } from './drivers/pg/spaceLifecycle'
import { createSpacesFacet } from './drivers/pg/spaces'
import { runPgMigrations } from './migrations'
import {
  credentialOfRow,
  type CredentialRow,
  providerResourceOfRow,
  type ProviderResourceRow,
  spaceOfRow,
  type SpaceRow,
} from './rows'
import type {
  GrantMemberToActiveSpaceResult,
  MetaDb,
  ProviderRetargetInput,
  ProviderRetargetResult,
  SpaceRole,
} from './types'

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

  readonly restoreOperations = createRestoreOperationsFacet(this.ctx)

  readonly restoreTerminal = createRestoreTerminalFacet(this.ctx)

  readonly spaceLifecycle = createSpaceLifecycleFacet(this.ctx)

  readonly causalOutbox = createCausalOutboxFacet(this.ctx)

  readonly installationGeneration = createInstallationGenerationFacet(this.ctx)

  readonly secretKeyring = createSecretKeyringFacet(this.ctx)

  readonly ownerProofs = createOwnerProofsFacet(this.ctx)

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
      // eslint-disable-next-line no-restricted-syntax -- outside the ladder: the space row, and this transaction takes nothing else
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

  readonly offerProviderAttachment: MetaDb['offerProviderAttachment'] = (record, disclosureOf) =>
    offerProviderAttachment(this.ctx, record, disclosureOf)

  readonly acceptProviderAttachment: MetaDb['acceptProviderAttachment'] = (input, disclosureOf) =>
    acceptProviderAttachment(this.ctx, input, disclosureOf)

  readonly detachProviderAttachment: MetaDb['detachProviderAttachment'] = (id) =>
    detachProviderAttachment(this.ctx, id)

  async retargetProviderCredential(input: ProviderRetargetInput): Promise<ProviderRetargetResult> {
    await this.ensureInit()
    const client = await this.required.connect()

    try {
      await client.query('BEGIN')
      await lockProviderCredentialRows(client, [input.credentialId])
      const credentialResult = await client.query('SELECT * FROM credentials WHERE id = $1', [
        input.credentialId,
      ])
      const credentialRow = credentialResult.rows[0] as CredentialRow | undefined

      if (!credentialRow || credentialRow.owner !== input.owner) {
        await client.query('COMMIT')
        return { status: 'missing' }
      }
      const credential = credentialOfRow(credentialRow)

      if (credential.runtimeEpoch !== input.expectedCredentialRuntimeEpoch) {
        await client.query('COMMIT')
        return { status: 'conflict' }
      }
      const referenceResult = await client.query(
        'SELECT * FROM provider_resources WHERE credential_id = $1 ORDER BY id',
        [input.credentialId],
      )
      const referenceIds = (referenceResult.rows as ProviderResourceRow[]).map(({ id }) => id)
      const requested = new Map(input.resources.map((resource) => [resource.id, resource]))

      if (requested.size !== referenceIds.length || referenceIds.some((id) => !requested.has(id))) {
        await client.query('COMMIT')
        return { status: 'references-changed' }
      }
      // The credential epoch is the first WRITE in the contour. Any later conflict
      // rolls the transaction back; writing it after the resource locks would re-enter
      // L5c from L5r and make the global order self-contradictory.
      await client.query(
        `UPDATE credentials SET origin = $2, consent_epoch = consent_epoch + 1,
           runtime_epoch = runtime_epoch + 1 WHERE id = $1`,
        [input.credentialId, input.origin],
      )
      await lockProviderResourceRows(client, referenceIds)
      const currentResult = await client.query(
        'SELECT * FROM provider_resources WHERE id = ANY($1::text[]) ORDER BY id',
        [referenceIds],
      )
      const references = (currentResult.rows as ProviderResourceRow[]).map(providerResourceOfRow)

      if (
        references.length !== referenceIds.length ||
        references.some((current) => {
          const next = requested.get(current.id)
          return (
            !next ||
            current.owner !== input.owner ||
            current.credentialId !== input.credentialId ||
            current.runtimeEpoch !== next.expectedRuntimeEpoch
          )
        })
      ) {
        await client.query('ROLLBACK')
        return { status: 'conflict' }
      }
      for (const current of references) {
        const next = requested.get(current.id)!

        const injectionHeader =
          credential.injection.header || DEFAULT_CREDENTIAL_HEADER[credential.kind][current.wire]
        const credentialConditionalFailure =
          new URL(next.baseUrl).origin !== input.origin ||
          Object.hasOwn(current.headers, injectionHeader)

        if (next.detachCredential !== credentialConditionalFailure) {
          await client.query('ROLLBACK')
          return { status: 'conflict' }
        }
      }
      const resourceIds = references.map(({ id }) => id)
      const baseUrls = references.map(({ id }) => requested.get(id)!.baseUrl)
      const credentialIds = references.map(({ id }) =>
        requested.get(id)!.detachCredential ? null : input.credentialId,
      )
      const updated = await client.query(
        `UPDATE provider_resources AS resource
            SET base_url = next.base_url,
                credential_id = next.credential_id,
                consent_epoch = resource.consent_epoch + 1,
                runtime_epoch = resource.runtime_epoch + 1,
                last_check = '{}'
           FROM unnest($1::text[], $2::text[], $3::text[])
                AS next(id, base_url, credential_id)
          WHERE resource.id = next.id`,
        [resourceIds, baseUrls, credentialIds],
      )

      if (updated.rowCount !== references.length) {
        await client.query('ROLLBACK')
        return { status: 'conflict' }
      }
      await transitionProviderAttachments(client, referenceIds)
      const storedCredentialResult = await client.query('SELECT * FROM credentials WHERE id = $1', [
        input.credentialId,
      ])
      const storedResourcesResult = await client.query(
        'SELECT * FROM provider_resources WHERE id = ANY($1::text[]) ORDER BY id',
        [referenceIds],
      )
      await client.query('COMMIT')
      return {
        status: 'retargeted',
        credential: credentialOfRow(storedCredentialResult.rows[0] as CredentialRow),
        resources: (storedResourcesResult.rows as ProviderResourceRow[]).map(providerResourceOfRow),
      }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async removeMemberAndProviderAttachments(spaceId: string, username: string): Promise<void> {
    await this.ensureInit()
    const client = await this.required.connect()

    try {
      await client.query('BEGIN')
      await lockRevisionKeys(client, 'space', [spaceId])
      const space = await lockProviderSpaceRow(client, spaceId)

      if (!space.exists) {
        await client.query('COMMIT')
        return
      }
      await lockProviderMembershipRow(client, spaceId, username)
      const resourcesResult = await client.query(
        `SELECT DISTINCT resource.id
           FROM provider_resources resource
           JOIN provider_attachments attachment ON attachment.resource_id = resource.id
          WHERE resource.owner = $1 AND attachment.target_space = $2
          ORDER BY resource.id`,
        [username, spaceId],
      )
      const resourceIds = (resourcesResult.rows as Array<{ id: string }>).map(({ id }) => id)
      await lockProviderResourceRows(client, resourceIds)
      const attachmentsResult = await client.query(
        `SELECT attachment.id
           FROM provider_attachments attachment
           JOIN provider_resources resource ON resource.id = attachment.resource_id
          WHERE resource.owner = $1 AND attachment.target_space = $2
          ORDER BY attachment.id`,
        [username, spaceId],
      )
      const attachmentIds = (attachmentsResult.rows as Array<{ id: string }>).map(({ id }) => id)
      await lockProviderAttachmentRows(client, attachmentIds)

      if (attachmentIds.length > 0) {
        await client.query('DELETE FROM provider_attachments WHERE id = ANY($1::text[])', [
          attachmentIds,
        ])
      }
      await client.query('DELETE FROM space_members WHERE space = $1 AND username = $2', [
        spaceId,
        username,
      ])
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async purgeSpace(spaceId: string): Promise<void> {
    await this.ensureInit()
    const client = await this.required.connect()

    try {
      await client.query('BEGIN')
      await client.query("SELECT set_config('notarium.revision_purge_protocol', $1, true)", [
        REVISION_PURGE_PROTOCOL,
      ])
      // Enter at identity before the causal/revision tiers: ordinary identity
      // settlement uses the same order, so purge cannot form a cross-layer cycle.
      await lockSpaceIdentityRows(client, spaceId)
      await lockCausalBarriers(client, [
        { kind: CAUSAL_BARRIER_KIND.spaceLifecycle, space: spaceId, key: spaceId },
      ])
      const current = await client.query('SELECT phase FROM space_lifecycle WHERE space = $1', [
        spaceId,
      ])
      const currentPhase = current.rows[0]?.phase as string | undefined

      if (
        currentPhase === 'metadata-cleaned' ||
        currentPhase === 'physical-cleaned' ||
        currentPhase === 'purged'
      ) {
        await client.query('COMMIT')
        return
      }
      const lifecycleAt = new Date().toISOString()

      if (currentPhase !== 'purge-intent') {
        await client.query(
          `INSERT INTO space_lifecycle
            (space, phase, generation, cleanup_manifest, changed_at, changed_by)
           VALUES ($1, 'purge-intent', 1, NULL, $2, NULL)
           ON CONFLICT (space) DO UPDATE SET
             phase = 'purge-intent',
             generation = space_lifecycle.generation + 1,
             changed_at = EXCLUDED.changed_at`,
          [spaceId, lifecycleAt],
        )
      }
      const blocker = await client.query(
        `SELECT id, kind FROM (
           SELECT id, 'restore' AS kind, space, phase FROM restore_operations
           UNION ALL
           SELECT id, 'ability-create' AS kind, space, phase FROM ability_create_operations
         ) AS operations
          WHERE space = $1 AND phase NOT IN ('succeeded', 'rejected')
          LIMIT 1`,
        [spaceId],
      )

      if (blocker.rows.length) {
        throw new Error(
          `space purge blocked by ${blocker.rows[0].kind} operation: ${blocker.rows[0].id}`,
        )
      }
      await client.query('DELETE FROM note_identity WHERE space = $1', [spaceId])
      // An import's destination claims die with the space they point into (#302).
      // Between identity (L1) and favourites (L2a) because that is where L1r/L1p sit
      // in the hierarchy; the claims themselves go by the table pair's ON DELETE
      // CASCADE, which takes L1p after the header's L1r — the only order the
      // ladder allows. A row left behind would hold paths in a space that no longer
      // exists, and its `activeJobIds` entry would keep the terminal-cleanup pass
      // fetching a job row this method also deletes.
      await client.query('DELETE FROM import_reservations WHERE space = $1', [spaceId])
      await client.query('DELETE FROM favorites WHERE space = $1', [spaceId])
      await client.query(
        'DELETE FROM context_set_attachments WHERE target_space = $1 OR set_id IN (SELECT id FROM context_sets WHERE home_space = $1)',
        [spaceId],
      )
      await client.query('DELETE FROM context_sets WHERE home_space = $1', [spaceId])
      // Drop pins whose SCOPE lived here; a pin to a NOTE here degrades at resolve (no eager sweep).
      await client.query('DELETE FROM context_scope_pins WHERE target_space = $1', [spaceId])
      // The overlay is rewritten DELETE-then-INSERT by `setOrder` and by a settlement,
      // both under the per-scope advisory lock. Deleting it without taking that lock is
      // not an ordering slip but a missing lock — the one thing no ordering rule sees.
      // Deriving the scope set is part of taking the lock, so it lives in `lockOrder`.
      await lockContextOrderScopesOfSpace(client, spaceId)
      await client.query('DELETE FROM context_order WHERE target_space = $1', [spaceId])
      // Its notes and blobs are read from rows this transaction locks as it goes,
      // so tier 3 cannot be entered in one sorted pass — take the wide-scan mutex.
      await lockRevisionWideScan(client)
      await lockRevisionKeys(client, 'space', [spaceId])
      // Serialize child cleanup with recovery grant. Without this early row lock,
      // purge could delete memberships, wait on the final space delete, then leave
      // a concurrent late grant orphaned after passing the cleanup point.
      //
      // It is HELD from here to COMMIT, across L4f and the ability tables below it,
      // and that is what makes `spaces` a table no foreign key may point at: a key
      // would have a tier-4 writer take this same row implicitly, from underneath.
      await lockProviderSpaceRow(client, spaceId)
      await client.query(
        `INSERT INTO revision_purge_fences (kind, entity_id, space) VALUES ('space', $1, $1)
         ON CONFLICT (kind, entity_id, space) DO NOTHING`,
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
      await client.query('DELETE FROM revision_heads WHERE space = $1', [spaceId])
      // Generation GC locks its queue row before touching states/heads. Purge must
      // take the same row order or the pair closes a queue↔state deadlock cycle.
      await client.query('DELETE FROM activity_projection_gc WHERE space = $1', [spaceId])
      await client.query('DELETE FROM activity_note_actor_states WHERE space = $1', [spaceId])
      await client.query('DELETE FROM activity_note_actor_heads WHERE space = $1', [spaceId])
      await client.query('DELETE FROM activity_revision_order WHERE space = $1', [spaceId])
      await client.query('DELETE FROM activity_projection_status WHERE space = $1', [spaceId])
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
      await client.query('DELETE FROM owner_proof_receipts WHERE space = $1', [spaceId])
      await client.query('DELETE FROM note_owner_proofs WHERE space = $1', [spaceId])
      await client.query('DELETE FROM restore_operations WHERE space = $1', [spaceId])
      await client.query('DELETE FROM ability_create_operations WHERE space = $1', [spaceId])
      await client.query('DELETE FROM causal_outbox WHERE space = $1', [spaceId])
      // The project FK cascades both cursor tables from this parent delete. This
      // preserves the parent-first order used by concurrent session advance.
      //
      // BEFORE the ability tables, not after: an availability write share-locks these
      // same project rows and only then writes the binding, so a purge that took the
      // ability tables first would close the cycle Postgres breaks with `40P01`. The
      // binding FK cascades from here too; the explicit delete below still runs, for
      // the rows keyed by this home Space whose project lives elsewhere.
      // canon: packages/server/src/services/metaDb/drivers/pg/lockOrder.ts
      await client.query('DELETE FROM folders WHERE space = $1', [spaceId])
      await client.query('DELETE FROM ability_project_bindings WHERE home_space = $1', [spaceId])
      await client.query('DELETE FROM ability_availability WHERE home_space = $1', [spaceId])
      await client.query('DELETE FROM ability_preferences WHERE space_id = $1', [spaceId])
      // The forwarding rows of this Space go with the overrides they forward: nothing
      // stands at either end of them any more.
      await client.query('DELETE FROM ability_placement_trail WHERE space_id = $1', [spaceId])
      // The Space revision stripe taken above blocks late offers. Enter the provider
      // contour at the attachment level, lock the exact rows, then delete them before
      // the ordinary space row. Credentials/resources are owner-keyed and survive.
      const providerAttachmentRows = await client.query(
        'SELECT id FROM provider_attachments WHERE target_space = $1 ORDER BY id',
        [spaceId],
      )
      await lockProviderAttachmentRows(
        client,
        (providerAttachmentRows.rows as Array<{ id: string }>).map((row) => row.id),
      )
      const providerAttachmentIds = (providerAttachmentRows.rows as Array<{ id: string }>).map(
        (row) => row.id,
      )
      await client.query(
        'DELETE FROM provider_attachments WHERE target_space = $1 AND id = ANY($2::text[])',
        [spaceId, providerAttachmentIds],
      )
      await client.query('DELETE FROM space_members WHERE space = $1', [spaceId])
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
      for (const table of [
        'oauth_auth_codes',
        'oauth_access_tokens',
        'oauth_refresh_tokens',
      ] as const) {
        await client.query(
          `UPDATE ${table} SET spaces = (
             SELECT to_json(COALESCE(array_agg(entry.value), ARRAY[]::text[]))::text
               FROM json_array_elements_text(${table}.spaces::json) AS entry(value)
              WHERE entry.value <> $1
           ) WHERE spaces IS NOT NULL`,
          [spaceId],
        )
      }
      await client.query('DELETE FROM spaces WHERE id = $1', [spaceId])
      await client.query(
        `UPDATE space_lifecycle SET
           phase = 'metadata-cleaned', generation = generation + 1, changed_at = $2
         WHERE space = $1`,
        [spaceId, new Date().toISOString()],
      )
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

  readonly abilityAvailability = createAbilityAvailabilityFacet(this.ctx)

  readonly abilityCreate = createAbilityCreateFacet(this.ctx)

  readonly abilityPreferences = createAbilityPreferencesFacet(this.ctx)

  readonly abilityPlacement = createAbilityPlacementFacet(this.ctx)

  readonly credentials = createCredentialsFacet(this.ctx)

  readonly providerResources = createProviderResourcesFacet(this.ctx)

  readonly providerAttachments = createProviderAttachmentsFacet(this.ctx)

  readonly providerCallLog = createProviderCallLogFacet(this.ctx)

  readonly providerCiphertexts = createProviderCiphertextsFacet(this.ctx)

  readonly retrievalLog = createRetrievalLogFacet(this.ctx)

  readonly auth = createAuthFacet(this.ctx)

  readonly gateway = createGatewayFacet(this.ctx)

  readonly agentDeltaCursors = createAgentDeltaCursorsFacet(this.ctx)

  readonly sessions = createSessionsFacet(this.ctx)

  readonly agentCalls = createAgentCallsFacet(this.ctx)

  readonly sessionAudit = createSessionAuditFacet(this.ctx)

  readonly oauth = createOAuthFacet(this.ctx)

  // canon: docs/jobs.md#single-flight-the-hard-part
  readonly jobs = createJobsFacet(this.ctx)

  readonly importReservations = createImportReservationsFacet(this.ctx)

  readonly revisions = createRevisionsFacet(this.ctx)
}
