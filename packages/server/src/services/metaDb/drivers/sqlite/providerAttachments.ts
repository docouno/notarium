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
import type { SqliteDriverCtx } from './context'

export const transitionProviderAttachments = (
  ctx: SqliteDriverCtx,
  resourceIds: readonly string[],
): void => {
  const ids = [...new Set(resourceIds)]

  if (!ids.length) {
    return
  }
  ctx.required
    .prepare(
      `UPDATE provider_attachments SET state = 'awaiting-reconsent'
        WHERE state = 'active' AND resource_id IN (SELECT value FROM json_each(?))`,
    )
    .run(JSON.stringify(ids))
}

const targetIsLive = (ctx: SqliteDriverCtx, space: string): boolean => {
  const row = ctx.required
    .prepare(
      `SELECT spaces.id, spaces.archived_at, space_lifecycle.phase
         FROM spaces
         LEFT JOIN space_lifecycle ON space_lifecycle.space = spaces.id
        WHERE spaces.id = ?`,
    )
    .get(space) as { id: string; archived_at: string | null; phase: string | null } | undefined

  return Boolean(
    row &&
    row.archived_at === null &&
    row.phase !== 'purge-intent' &&
    row.phase !== 'metadata-cleaned' &&
    row.phase !== 'physical-cleaned' &&
    row.phase !== 'purged',
  )
}

const ownerIsMember = (ctx: SqliteDriverCtx, space: string, owner: string): boolean =>
  owner === '@system' ||
  Boolean(
    ctx.required
      .prepare('SELECT 1 FROM space_members WHERE space = ? AND username = ?')
      .get(space, owner),
  )

const transitionState = (
  ctx: SqliteDriverCtx,
  attachment: ProviderAttachmentRow,
): ProviderAttachmentTransitionState | null => {
  const resourceRow = ctx.required
    .prepare('SELECT * FROM provider_resources WHERE id = ?')
    .get(attachment.resource_id) as ProviderResourceRow | undefined

  if (!resourceRow) {
    return null
  }
  const resource = providerResourceOfRow(resourceRow)
  const credentialRow = resource.credentialId
    ? (ctx.required.prepare('SELECT * FROM credentials WHERE id = ?').get(resource.credentialId) as
        CredentialRow | undefined)
    : undefined

  return {
    record: providerAttachmentOfRow(attachment),
    resource,
    credential: credentialRow ? credentialOfRow(credentialRow) : null,
  }
}

export const offerProviderAttachment = async (
  ctx: SqliteDriverCtx,
  record: Parameters<ProviderAttachmentLifecyclePersistence['offerProviderAttachment']>[0],
  _disclosureOf: ProviderDisclosureBuilder,
): Promise<ProviderAttachmentOfferResult> => {
  void _disclosureOf
  await ctx.ensureInit()
  const db = ctx.required
  db.exec('BEGIN IMMEDIATE')
  try {
    if (!targetIsLive(ctx, record.targetSpace)) {
      db.exec('COMMIT')
      return { status: 'target-gone' }
    }
    const resourceRow = db
      .prepare('SELECT * FROM provider_resources WHERE id = ?')
      .get(record.resourceId) as ProviderResourceRow | undefined

    if (!resourceRow) {
      db.exec('COMMIT')
      return { status: 'missing-resource' }
    }
    const resource = providerResourceOfRow(resourceRow)

    if (!ownerIsMember(ctx, record.targetSpace, resource.owner)) {
      db.exec('COMMIT')
      return { status: 'owner-not-member' }
    }
    const existing = db
      .prepare(
        `SELECT * FROM provider_attachments
          WHERE resource_id = ? AND target_kind = ? AND target_id = ?`,
      )
      .get(record.resourceId, record.targetKind, record.targetId) as
      ProviderAttachmentRow | undefined

    if (existing && existing.state !== ATTACHMENT_STATE.pending) {
      const state = transitionState(ctx, existing)
      db.exec('COMMIT')
      return state ? { status: 'already-attached', ...state } : { status: 'missing-resource' }
    }
    if (existing) {
      db.prepare(
        `UPDATE provider_attachments SET target_space = ?, created_at = ?, expires_at = ?
          WHERE id = ?`,
      ).run(record.targetSpace, record.createdAt, record.expiresAt, existing.id)
    } else {
      db.prepare(
        `INSERT INTO provider_attachments
          (id, resource_id, target_kind, target_id, target_space, state,
           resource_epoch, credential_epoch, disclosure_snapshot, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        record.id,
        record.resourceId,
        record.targetKind,
        record.targetId,
        record.targetSpace,
        record.state,
        record.resourceEpoch,
        record.credentialEpoch,
        null,
        record.createdAt,
        record.expiresAt,
      )
    }
    const stored = db
      .prepare(
        `SELECT * FROM provider_attachments
          WHERE resource_id = ? AND target_kind = ? AND target_id = ?`,
      )
      .get(record.resourceId, record.targetKind, record.targetId) as ProviderAttachmentRow
    const state = transitionState(ctx, stored)
    db.exec('COMMIT')
    return state ? { status: 'offered', ...state } : { status: 'missing-resource' }
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export const acceptProviderAttachment = async (
  ctx: SqliteDriverCtx,
  input: Parameters<ProviderAttachmentLifecyclePersistence['acceptProviderAttachment']>[0],
  disclosureOf: ProviderDisclosureBuilder,
): Promise<ProviderAttachmentAcceptResult> => {
  await ctx.ensureInit()
  const db = ctx.required
  db.exec('BEGIN IMMEDIATE')
  try {
    const row = db.prepare('SELECT * FROM provider_attachments WHERE id = ?').get(input.id) as
      ProviderAttachmentRow | undefined

    if (!row) {
      db.exec('COMMIT')
      return { status: 'missing' }
    }
    if (!targetIsLive(ctx, row.target_space)) {
      db.exec('COMMIT')
      return { status: 'target-gone' }
    }
    const state = transitionState(ctx, row)

    if (!state) {
      db.exec('COMMIT')
      return { status: 'missing' }
    }
    if (
      !ownerIsMember(ctx, row.target_space, state.resource.owner) ||
      (input.manager !== null && !ownerIsMember(ctx, row.target_space, input.manager))
    ) {
      db.exec('COMMIT')
      return { status: 'owner-not-member' }
    }
    const currentCredentialEpoch = state.credential?.consentEpoch ?? null
    const currentDisclosure = disclosureOf(state.resource, state.credential, row.target_space)
    const currentPairMatches =
      row.resource_epoch === state.resource.consentEpoch &&
      row.credential_epoch === currentCredentialEpoch

    if (row.state === ATTACHMENT_STATE.active) {
      if (currentPairMatches) {
        db.exec('COMMIT')
        return { status: 'already-active', ...state }
      }
      db.prepare("UPDATE provider_attachments SET state = 'awaiting-reconsent' WHERE id = ?").run(
        input.id,
      )
      const changed = {
        ...state,
        record: { ...state.record, state: ATTACHMENT_STATE.awaitingReconsent },
      }
      db.exec('COMMIT')
      return { status: 'epoch-conflict', ...changed }
    }
    if (row.state === ATTACHMENT_STATE.pending && row.expires_at <= input.acceptedAt) {
      db.exec('COMMIT')
      return { status: 'expired', ...state }
    }
    if (
      input.expectedResourceEpoch !== state.resource.consentEpoch ||
      input.expectedCredentialEpoch !== currentCredentialEpoch
    ) {
      db.exec('COMMIT')
      return { status: 'epoch-conflict', ...state }
    }
    db.prepare(
      `UPDATE provider_attachments SET
         state = 'active', resource_epoch = ?, credential_epoch = ?, disclosure_snapshot = ?
       WHERE id = ?`,
    ).run(
      state.resource.consentEpoch,
      currentCredentialEpoch,
      JSON.stringify(currentDisclosure),
      input.id,
    )
    const accepted = {
      ...state,
      record: {
        ...state.record,
        state: ATTACHMENT_STATE.active,
        resourceEpoch: state.resource.consentEpoch,
        credentialEpoch: currentCredentialEpoch,
        disclosure: currentDisclosure,
      },
    }
    db.exec('COMMIT')
    return { status: 'accepted', ...accepted }
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export const detachProviderAttachment = async (
  ctx: SqliteDriverCtx,
  input: Parameters<ProviderAttachmentLifecyclePersistence['detachProviderAttachment']>[0],
): Promise<
  Awaited<ReturnType<ProviderAttachmentLifecyclePersistence['detachProviderAttachment']>>
> => {
  await ctx.ensureInit()
  const { id } = input
  const db = ctx.required
  db.exec('BEGIN IMMEDIATE')
  try {
    const row = db.prepare('SELECT target_space FROM provider_attachments WHERE id = ?').get(id) as
      { target_space: string } | undefined

    if (!row) {
      db.exec('COMMIT')
      return { status: 'missing' }
    }
    if (!targetIsLive(ctx, row.target_space)) {
      db.exec('COMMIT')
      return { status: 'target-gone' }
    }
    if (input.manager !== null && !ownerIsMember(ctx, row.target_space, input.manager)) {
      db.exec('COMMIT')
      return { status: 'manager-not-member' }
    }
    db.prepare('DELETE FROM provider_attachments WHERE id = ?').run(id)
    db.exec('COMMIT')
    return { status: 'detached', targetSpace: row.target_space }
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export const createProviderAttachmentsFacet = (
  ctx: SqliteDriverCtx,
): ProviderAttachmentsPersistence => ({
  get: async (id) => {
    await ctx.ensureInit()
    const row = ctx.required.prepare('SELECT * FROM provider_attachments WHERE id = ?').get(id) as
      ProviderAttachmentRow | undefined
    return row ? providerAttachmentOfRow(row) : null
  },
  getMany: async (ids) => {
    if (ids.length === 0) {
      return []
    }
    await ctx.ensureInit()
    return (
      ctx.required
        .prepare(
          'SELECT * FROM provider_attachments WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id',
        )
        .all(JSON.stringify([...new Set(ids)])) as ProviderAttachmentRow[]
    ).map(providerAttachmentOfRow)
  },
  listForResource: async (resourceId) => {
    await ctx.ensureInit()
    return (
      ctx.required
        .prepare('SELECT * FROM provider_attachments WHERE resource_id = ? ORDER BY created_at, id')
        .all(resourceId) as ProviderAttachmentRow[]
    ).map(providerAttachmentOfRow)
  },
  listForSpace: async (targetSpace) => {
    await ctx.ensureInit()
    return (
      ctx.required
        .prepare(
          'SELECT * FROM provider_attachments WHERE target_space = ? ORDER BY created_at, id',
        )
        .all(targetSpace) as ProviderAttachmentRow[]
    ).map(providerAttachmentOfRow)
  },
  listForSpaces: async (targetSpaces) => {
    if (targetSpaces.length === 0) {
      return []
    }
    await ctx.ensureInit()
    return (
      ctx.required
        .prepare(
          `SELECT * FROM provider_attachments
            WHERE target_space IN (SELECT value FROM json_each(?))
            ORDER BY target_space, created_at, id`,
        )
        .all(JSON.stringify([...new Set(targetSpaces)])) as ProviderAttachmentRow[]
    ).map(providerAttachmentOfRow)
  },
  listForResourcesInSpaces: async (resourceIds, targetSpaces) => {
    if (resourceIds.length === 0 || targetSpaces.length === 0) {
      return []
    }
    await ctx.ensureInit()
    return (
      ctx.required
        .prepare(
          `SELECT * FROM provider_attachments
            WHERE resource_id IN (SELECT value FROM json_each(?))
              AND target_space IN (SELECT value FROM json_each(?))
            ORDER BY target_space, created_at, id`,
        )
        .all(
          JSON.stringify([...new Set(resourceIds)]),
          JSON.stringify([...new Set(targetSpaces)]),
        ) as ProviderAttachmentRow[]
    ).map(providerAttachmentOfRow)
  },
  pageIdsForSpace: async (targetSpace, pendingAfter, input) => {
    await ctx.ensureInit()
    const after = input.after
    const filter = `
      FROM provider_attachments
      WHERE target_space = ?
        AND (state <> 'pending' OR expires_at > ?)`
    const total = ctx.required
      .prepare(`SELECT COUNT(*) AS n ${filter}`)
      .get(targetSpace, pendingAfter) as { n: number }
    const rows = ctx.required
      .prepare(
        `SELECT id ${filter}
          AND (? IS NULL OR created_at COLLATE BINARY > ? OR
            (created_at COLLATE BINARY = ? AND id COLLATE BINARY > ?))
          ORDER BY created_at COLLATE BINARY, id COLLATE BINARY LIMIT ?`,
      )
      .all(
        targetSpace,
        pendingAfter,
        after?.sort ?? null,
        after?.sort ?? '',
        after?.sort ?? '',
        after?.id ?? '',
        Math.max(1, Math.min(input.limit, 1_000)),
      ) as Array<{ id: string }>

    return { ids: rows.map(({ id }) => id), total: total.n }
  },
})
