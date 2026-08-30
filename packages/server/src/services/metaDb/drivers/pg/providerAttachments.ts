import type { PoolClient } from 'pg'

import { ATTACHMENT_STATE } from '@notarium/contract'

import {
  credentialOfRow,
  type CredentialRow,
  providerAttachmentOfRow,
  type ProviderAttachmentRow,
  providerResourceOfRow,
  type ProviderResourceRow,
} from '../../rows'
import type {
  ProviderAttachmentAcceptResult,
  ProviderAttachmentLifecyclePersistence,
  ProviderAttachmentOfferResult,
  ProviderAttachmentsPersistence,
  ProviderAttachmentTransitionState,
  ProviderDisclosureBuilder,
} from '../../types'
import type { PgDriverCtx } from './context'
import {
  lockProviderAttachmentRows,
  lockProviderCredentialRows,
  lockProviderMembershipRow,
  lockProviderMembershipRows,
  lockProviderResourceRows,
  lockProviderSpaceRow,
} from './lockOrder'
import { lockRevisionKeys } from './revisionLocks'

const ENDED_PHASES = new Set(['purge-intent', 'metadata-cleaned', 'physical-cleaned', 'purged'])

const targetIsLive = async (client: PoolClient, space: string): Promise<boolean> => {
  await lockRevisionKeys(client, 'space', [space])
  const row = await lockProviderSpaceRow(client, space)
  return row.exists && row.archivedAt === null && !ENDED_PHASES.has(row.phase ?? '')
}

export const transitionProviderAttachments = async (
  client: PoolClient,
  resourceIds: readonly string[],
): Promise<void> => {
  const ids = [...new Set(resourceIds)].sort()

  if (!ids.length) {
    await lockProviderAttachmentRows(client, [])
    return
  }
  const found = await client.query(
    `SELECT id FROM provider_attachments
      WHERE resource_id = ANY($1::text[]) ORDER BY id`,
    [ids],
  )
  const attachmentIds = (found.rows as Array<{ id: string }>).map(({ id }) => id)
  await lockProviderAttachmentRows(client, attachmentIds)

  if (attachmentIds.length > 0) {
    await client.query(
      `UPDATE provider_attachments SET state = 'awaiting-reconsent'
        WHERE id = ANY($1::text[]) AND state = 'active'`,
      [attachmentIds],
    )
  }
}

const transitionState = async (
  client: PoolClient,
  attachment: ProviderAttachmentRow,
): Promise<ProviderAttachmentTransitionState | null> => {
  const resourceResult = await client.query('SELECT * FROM provider_resources WHERE id = $1', [
    attachment.resource_id,
  ])
  const resourceRow = resourceResult.rows[0] as ProviderResourceRow | undefined

  if (!resourceRow) {
    return null
  }
  const resource = providerResourceOfRow(resourceRow)
  const credentialResult = resource.credentialId
    ? await client.query('SELECT * FROM credentials WHERE id = $1', [resource.credentialId])
    : null
  const credentialRow = credentialResult?.rows[0] as CredentialRow | undefined

  return {
    record: providerAttachmentOfRow(attachment),
    resource,
    credential: credentialRow ? credentialOfRow(credentialRow) : null,
  }
}

type ResourceProbe = {
  owner: string
  credential_id: string | null
}

export const offerProviderAttachment = async (
  ctx: PgDriverCtx,
  record: Parameters<ProviderAttachmentLifecyclePersistence['offerProviderAttachment']>[0],
  _disclosureOf: ProviderDisclosureBuilder,
): Promise<ProviderAttachmentOfferResult> => {
  void _disclosureOf
  await ctx.ensureInit()

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const client = await ctx.required.connect()

    try {
      await client.query('BEGIN')
      const probeResult = await client.query(
        'SELECT owner, credential_id FROM provider_resources WHERE id = $1',
        [record.resourceId],
      )
      const probe = probeResult.rows[0] as ResourceProbe | undefined

      if (!probe) {
        await client.query('COMMIT')
        return { status: 'missing-resource' }
      }
      if (!(await targetIsLive(client, record.targetSpace))) {
        await client.query('COMMIT')
        return { status: 'target-gone' }
      }
      if (!(await lockProviderMembershipRow(client, record.targetSpace, probe.owner))) {
        await client.query('COMMIT')
        return { status: 'owner-not-member' }
      }
      await lockProviderCredentialRows(client, probe.credential_id ? [probe.credential_id] : [])
      await lockProviderResourceRows(client, [record.resourceId])
      const currentResource = await client.query(
        'SELECT owner, credential_id FROM provider_resources WHERE id = $1',
        [record.resourceId],
      )
      const currentProbe = currentResource.rows[0] as ResourceProbe | undefined

      if (!currentProbe) {
        await client.query('COMMIT')
        return { status: 'missing-resource' }
      }
      if (
        currentProbe.owner !== probe.owner ||
        currentProbe.credential_id !== probe.credential_id
      ) {
        await client.query('COMMIT')
        continue
      }
      const before = await client.query(
        `SELECT id FROM provider_attachments
          WHERE resource_id = $1 AND target_kind = $2 AND target_id = $3`,
        [record.resourceId, record.targetKind, record.targetId],
      )
      const existingId = (before.rows[0] as { id?: string } | undefined)?.id
      await lockProviderAttachmentRows(client, [existingId ?? record.id])
      const current = await client.query(
        `SELECT * FROM provider_attachments
          WHERE resource_id = $1 AND target_kind = $2 AND target_id = $3`,
        [record.resourceId, record.targetKind, record.targetId],
      )
      const existing = current.rows[0] as ProviderAttachmentRow | undefined

      if (existing && existing.state !== ATTACHMENT_STATE.pending) {
        const state = await transitionState(client, existing)
        await client.query('COMMIT')
        return state ? { status: 'already-attached', ...state } : { status: 'missing-resource' }
      }
      let stored

      if (existing) {
        stored = await client.query(
          `UPDATE provider_attachments SET target_space = $2, created_at = $3, expires_at = $4
            WHERE id = $1 RETURNING *`,
          [existing.id, record.targetSpace, record.createdAt, record.expiresAt],
        )
      } else {
        stored = await client.query(
          `INSERT INTO provider_attachments
            (id, resource_id, target_kind, target_id, target_space, state,
             resource_epoch, credential_epoch, disclosure_snapshot, created_at, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, $9, $10)
           RETURNING *`,
          [
            record.id,
            record.resourceId,
            record.targetKind,
            record.targetId,
            record.targetSpace,
            record.state,
            record.resourceEpoch,
            record.credentialEpoch,
            record.createdAt,
            record.expiresAt,
          ],
        )
      }
      const state = await transitionState(client, stored.rows[0] as ProviderAttachmentRow)
      await client.query('COMMIT')
      return state ? { status: 'offered', ...state } : { status: 'missing-resource' }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  return { status: 'missing-resource' }
}

type AttachmentProbe = {
  resource_id: string
  target_space: string
  owner: string
  credential_id: string | null
}

export const acceptProviderAttachment = async (
  ctx: PgDriverCtx,
  input: Parameters<ProviderAttachmentLifecyclePersistence['acceptProviderAttachment']>[0],
  disclosureOf: ProviderDisclosureBuilder,
): Promise<ProviderAttachmentAcceptResult> => {
  await ctx.ensureInit()

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const client = await ctx.required.connect()

    try {
      await client.query('BEGIN')
      const probeResult = await client.query(
        `SELECT attachment.resource_id, attachment.target_space,
                resource.owner, resource.credential_id
           FROM provider_attachments attachment
           JOIN provider_resources resource ON resource.id = attachment.resource_id
          WHERE attachment.id = $1`,
        [input.id],
      )
      const probe = probeResult.rows[0] as AttachmentProbe | undefined

      if (!probe) {
        await client.query('COMMIT')
        return { status: 'missing' }
      }
      if (!(await targetIsLive(client, probe.target_space))) {
        await client.query('COMMIT')
        return { status: 'target-gone' }
      }
      const members = await lockProviderMembershipRows(
        client,
        probe.target_space,
        input.manager ? [probe.owner, input.manager] : [probe.owner],
      )

      if (
        (probe.owner !== '@system' && !members.has(probe.owner)) ||
        (input.manager !== null && !members.has(input.manager))
      ) {
        await client.query('COMMIT')
        return { status: 'owner-not-member' }
      }
      await lockProviderCredentialRows(client, probe.credential_id ? [probe.credential_id] : [])
      await lockProviderResourceRows(client, [probe.resource_id])
      await lockProviderAttachmentRows(client, [input.id])
      const attachmentResult = await client.query(
        'SELECT * FROM provider_attachments WHERE id = $1',
        [input.id],
      )
      const row = attachmentResult.rows[0] as ProviderAttachmentRow | undefined

      if (!row) {
        await client.query('COMMIT')
        return { status: 'missing' }
      }
      const state = await transitionState(client, row)

      if (
        !state ||
        row.target_space !== probe.target_space ||
        state.resource.owner !== probe.owner ||
        state.resource.credentialId !== probe.credential_id
      ) {
        await client.query('COMMIT')
        continue
      }
      const currentCredentialEpoch = state.credential?.consentEpoch ?? null
      const currentDisclosure = disclosureOf(state.resource, state.credential, row.target_space)
      const currentPairMatches =
        state.record.resourceEpoch === state.resource.consentEpoch &&
        state.record.credentialEpoch === currentCredentialEpoch

      if (state.record.state === ATTACHMENT_STATE.active) {
        if (currentPairMatches) {
          await client.query('COMMIT')
          return { status: 'already-active', ...state }
        }
        const changed = await client.query(
          "UPDATE provider_attachments SET state = 'awaiting-reconsent' WHERE id = $1 RETURNING *",
          [input.id],
        )
        await client.query('COMMIT')
        return {
          status: 'epoch-conflict',
          ...state,
          record: providerAttachmentOfRow(changed.rows[0] as ProviderAttachmentRow),
        }
      }
      if (state.record.state === ATTACHMENT_STATE.pending && row.expires_at <= input.acceptedAt) {
        await client.query('COMMIT')
        return { status: 'expired', ...state }
      }
      if (
        input.expectedResourceEpoch !== state.resource.consentEpoch ||
        input.expectedCredentialEpoch !== currentCredentialEpoch
      ) {
        await client.query('COMMIT')
        return { status: 'epoch-conflict', ...state }
      }
      const accepted = await client.query(
        `UPDATE provider_attachments SET
           state = 'active', resource_epoch = $2, credential_epoch = $3,
           disclosure_snapshot = $4
         WHERE id = $1 RETURNING *`,
        [
          input.id,
          state.resource.consentEpoch,
          currentCredentialEpoch,
          JSON.stringify(currentDisclosure),
        ],
      )
      await client.query('COMMIT')
      return {
        status: 'accepted',
        ...state,
        record: providerAttachmentOfRow(accepted.rows[0] as ProviderAttachmentRow),
      }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  return { status: 'missing' }
}

export const detachProviderAttachment = async (
  ctx: PgDriverCtx,
  input: Parameters<ProviderAttachmentLifecyclePersistence['detachProviderAttachment']>[0],
): Promise<
  Awaited<ReturnType<ProviderAttachmentLifecyclePersistence['detachProviderAttachment']>>
> => {
  await ctx.ensureInit()
  const { id } = input

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const client = await ctx.required.connect()

    try {
      await client.query('BEGIN')
      const probeResult = await client.query(
        'SELECT resource_id, target_space FROM provider_attachments WHERE id = $1',
        [id],
      )
      const probe = probeResult.rows[0] as { resource_id: string; target_space: string } | undefined

      if (!probe) {
        await client.query('COMMIT')
        return { status: 'missing' }
      }
      if (!(await targetIsLive(client, probe.target_space))) {
        await client.query('COMMIT')
        return { status: 'target-gone' }
      }
      if (
        input.manager !== null &&
        !(await lockProviderMembershipRow(client, probe.target_space, input.manager))
      ) {
        await client.query('COMMIT')
        return { status: 'manager-not-member' }
      }
      await lockProviderResourceRows(client, [probe.resource_id])
      await lockProviderAttachmentRows(client, [id])
      const current = await client.query(
        'SELECT resource_id, target_space FROM provider_attachments WHERE id = $1',
        [id],
      )
      const row = current.rows[0] as { resource_id: string; target_space: string } | undefined

      if (!row) {
        await client.query('COMMIT')
        return { status: 'missing' }
      }
      if (row.resource_id !== probe.resource_id || row.target_space !== probe.target_space) {
        await client.query('COMMIT')
        continue
      }
      await client.query('DELETE FROM provider_attachments WHERE id = $1', [id])
      await client.query('COMMIT')
      return { status: 'detached', targetSpace: row.target_space }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  return { status: 'missing' }
}

export const createProviderAttachmentsFacet = (
  ctx: PgDriverCtx,
): ProviderAttachmentsPersistence => ({
  get: async (id) => {
    await ctx.ensureInit()
    const result = await ctx.required.query('SELECT * FROM provider_attachments WHERE id = $1', [
      id,
    ])
    const row = result.rows[0] as ProviderAttachmentRow | undefined
    return row ? providerAttachmentOfRow(row) : null
  },
  getMany: async (ids) => {
    if (ids.length === 0) {
      return []
    }
    await ctx.ensureInit()
    const result = await ctx.required.query(
      'SELECT * FROM provider_attachments WHERE id = ANY($1::text[]) ORDER BY id',
      [[...new Set(ids)]],
    )
    return (result.rows as ProviderAttachmentRow[]).map(providerAttachmentOfRow)
  },
  listForResource: async (resourceId) => {
    await ctx.ensureInit()
    const result = await ctx.required.query(
      'SELECT * FROM provider_attachments WHERE resource_id = $1 ORDER BY created_at, id',
      [resourceId],
    )
    return (result.rows as ProviderAttachmentRow[]).map(providerAttachmentOfRow)
  },
  listForSpace: async (targetSpace) => {
    await ctx.ensureInit()
    const result = await ctx.required.query(
      'SELECT * FROM provider_attachments WHERE target_space = $1 ORDER BY created_at, id',
      [targetSpace],
    )
    return (result.rows as ProviderAttachmentRow[]).map(providerAttachmentOfRow)
  },
  listForSpaces: async (targetSpaces) => {
    if (targetSpaces.length === 0) {
      return []
    }
    await ctx.ensureInit()
    const result = await ctx.required.query(
      `SELECT * FROM provider_attachments
        WHERE target_space = ANY($1::text[])
        ORDER BY target_space COLLATE "C", created_at, id`,
      [[...new Set(targetSpaces)]],
    )
    return (result.rows as ProviderAttachmentRow[]).map(providerAttachmentOfRow)
  },
  listForResourcesInSpaces: async (resourceIds, targetSpaces) => {
    if (resourceIds.length === 0 || targetSpaces.length === 0) {
      return []
    }
    await ctx.ensureInit()
    const result = await ctx.required.query(
      `SELECT * FROM provider_attachments
        WHERE resource_id = ANY($1::text[]) AND target_space = ANY($2::text[])
        ORDER BY target_space COLLATE "C", created_at, id`,
      [[...new Set(resourceIds)], [...new Set(targetSpaces)]],
    )
    return (result.rows as ProviderAttachmentRow[]).map(providerAttachmentOfRow)
  },
  pageIdsForSpace: async (targetSpace, pendingAfter, input) => {
    await ctx.ensureInit()
    const after = input.after
    const filter = `
      FROM provider_attachments
      WHERE target_space = $1 AND (state <> 'pending' OR expires_at > $2)`
    const [total, page] = await Promise.all([
      ctx.required.query(`SELECT COUNT(*) AS n ${filter}`, [targetSpace, pendingAfter]),
      ctx.required.query(
        `SELECT id ${filter}
          AND ($3::text IS NULL OR
            (created_at COLLATE "C", id COLLATE "C") >
            (($3::text) COLLATE "C", ($4::text) COLLATE "C"))
          ORDER BY created_at COLLATE "C", id COLLATE "C" LIMIT $5`,
        [
          targetSpace,
          pendingAfter,
          after?.sort ?? null,
          after?.id ?? '',
          Math.max(1, Math.min(input.limit, 1_000)),
        ],
      ),
    ])

    return {
      ids: (page.rows as Array<{ id: string }>).map(({ id }) => id),
      total: Number((total.rows[0] as { n: string | number }).n),
    }
  },
})
