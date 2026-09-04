// Row↔record mappers shared by the SQLite and Postgres driver twins.

import { ProviderLastChecksSchema, ProviderModelsSchema } from '@notarium/contract'
import {
  AGENT_SESSION_ATTACH,
  REVISION_INTEGRITY,
  REVISION_UNAVAILABLE_REASON,
  REVISION_UNAVAILABLE_TITLE,
  type RevisionKind,
} from '@notarium/core'
import type {
  AgentSessionAuditEvent,
  ContextOrderEntryKind,
  ContextOrderRecord,
  ContextSetAttachmentRecord,
  ContextSetItemRef,
  ContextSetRecord,
  ContextSetTargetKind,
  CredentialRecord,
  FolderRecord,
  JobRecord,
  JobStatus,
  OAuthAccessRecord,
  OAuthRefreshRecord,
  OAuthScope,
  PatRecord,
  ProjectRecord,
  ProjectStatus,
  ProviderAttachmentRecord,
  ProviderCallLogRecord,
  ProviderResourceRecord,
  RetrievalHit,
  RetrievalLogRecord,
  RetrievalTool,
  ScopePinRecord,
  SpaceRecord,
  SpaceRole,
  UserRecord,
} from './types'

const jsonOf = <T>(raw: string | null | undefined, fallback: T): T => {
  if (!raw) {
    return fallback
  }
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

const providerModelsOf = (
  raw: string,
  defaultModel: string | null,
): ProviderResourceRecord['models'] => {
  const models = ProviderModelsSchema.parse(JSON.parse(raw))

  if (defaultModel !== null && !models.some(({ name }) => name === defaultModel)) {
    throw new Error('provider default model must name one exact stored model')
  }

  return models
}

// ── provider facet rows ──────────────────────────────────────────────

export type CredentialRow = {
  id: string
  owner: string
  name: string
  kind: CredentialRecord['kind']
  secret: string
  origin: string
  injection: string
  disabled_at: string | null
  rpm: number | string | null
  tpm: number | string | null
  consent_epoch: number | string
  runtime_epoch: number | string
}

export const credentialOfRow = (row: CredentialRow): CredentialRecord => ({
  id: row.id,
  owner: row.owner,
  name: row.name,
  kind: row.kind,
  secret: row.secret,
  origin: row.origin,
  injection: jsonOf(row.injection, { header: '', prefix: '' }),
  disabledAt: row.disabled_at,
  rpm: row.rpm == null ? null : Number(row.rpm),
  tpm: row.tpm == null ? null : Number(row.tpm),
  consentEpoch: Number(row.consent_epoch),
  runtimeEpoch: Number(row.runtime_epoch),
})

export type ProviderResourceRow = {
  id: string
  owner: string
  name: string
  wire: ProviderResourceRecord['wire']
  base_url: string
  headers: string
  allow_private_network: number | boolean
  models: string
  default_model: string | null
  credential_id: string | null
  consent_epoch: number | string
  runtime_epoch: number | string
  disabled_at: string | null
  last_check: string
  first_byte_timeout_ms: number | string | null
  call_timeout_ms: number | string | null
}

export const providerResourceOfRow = (row: ProviderResourceRow): ProviderResourceRecord => {
  const models = providerModelsOf(row.models, row.default_model)
  const lastCheck = ProviderLastChecksSchema.parse(JSON.parse(row.last_check))
  const configuredCapabilities = new Set(models.flatMap(({ capabilities }) => capabilities))

  for (const capability of Object.keys(lastCheck)) {
    if (!configuredCapabilities.has(capability as keyof typeof lastCheck)) {
      throw new Error('provider last check requires a configured model capability')
    }
  }

  return {
    id: row.id,
    owner: row.owner,
    name: row.name,
    wire: row.wire,
    baseUrl: row.base_url,
    headers: jsonOf(row.headers, {}),
    allowPrivateNetwork: Boolean(row.allow_private_network),
    models,
    defaultModel: row.default_model,
    credentialId: row.credential_id,
    consentEpoch: Number(row.consent_epoch),
    runtimeEpoch: Number(row.runtime_epoch),
    disabledAt: row.disabled_at,
    lastCheck,
    firstByteTimeoutMs:
      row.first_byte_timeout_ms == null ? null : Number(row.first_byte_timeout_ms),
    callTimeoutMs: row.call_timeout_ms == null ? null : Number(row.call_timeout_ms),
  }
}

export type ProviderAttachmentRow = {
  id: string
  resource_id: string
  target_kind: ProviderAttachmentRecord['targetKind']
  target_id: string
  target_space: string
  state: ProviderAttachmentRecord['state']
  resource_epoch: number | string | null
  credential_epoch: number | string | null
  disclosure_snapshot: string | null
  created_at: string
  expires_at: string
}

export const providerAttachmentOfRow = (row: ProviderAttachmentRow): ProviderAttachmentRecord => ({
  id: row.id,
  resourceId: row.resource_id,
  targetKind: row.target_kind,
  targetId: row.target_id,
  targetSpace: row.target_space,
  state: row.state,
  resourceEpoch: row.resource_epoch == null ? null : Number(row.resource_epoch),
  credentialEpoch: row.credential_epoch == null ? null : Number(row.credential_epoch),
  disclosure: jsonOf(row.disclosure_snapshot, null),
  createdAt: row.created_at,
  expiresAt: row.expires_at,
})

export type ProviderCallLogRow = {
  id: string
  owner: string
  principal: string
  agent: string | null
  resource_id: string
  credential_id: string | null
  host: string
  spaces: string | null
  job_id: string | null
  job_call_key: string | null
  attempt_no: number | string | null
  delivery_state: ProviderCallLogRecord['deliveryState']
  retry_safe: number | boolean
  outcome: ProviderCallLogRecord['outcome']
  token_usage: string | null
  created_at: string
  settled_at: string | null
}

export const providerCallLogOfRow = (row: ProviderCallLogRow): ProviderCallLogRecord => ({
  id: row.id,
  owner: row.owner,
  principal: row.principal,
  agent: row.agent,
  resourceId: row.resource_id,
  credentialId: row.credential_id,
  host: row.host,
  spaces: jsonOf(row.spaces, []),
  jobId: row.job_id,
  jobCallKey: row.job_call_key,
  attemptNo: row.attempt_no == null ? null : Number(row.attempt_no),
  deliveryState: row.delivery_state,
  retrySafe: Boolean(row.retry_safe),
  outcome: row.outcome,
  usage: jsonOf(row.token_usage, null),
  createdAt: row.created_at,
  settledAt: row.settled_at,
})

/** A row of the `spaces` table. */
export type SpaceRow = {
  id: string
  slug: string
  notes_dir: string
  display_name: string
  aliases: string | null
  created_at: string
  archived_at?: string | null
  archived_by?: string | null
}

export const spaceOfRow = (r: SpaceRow): SpaceRecord => ({
  id: r.id,
  slug: r.slug,
  notesDir: r.notes_dir,
  displayName: r.display_name,
  aliases: parseAliases(r.aliases),
  createdAt: r.created_at,
  archivedAt: r.archived_at ?? null,
  archivedBy: r.archived_by ?? null,
})

export type UserRow = {
  id: string
  username: string
  email: string | null
  display_name: string
  password_hash: string | null
  admin: number | boolean
  disabled_at: string | null
  created_at: string
  personal_space: string | null
}

export const userOfRow = (r: UserRow): UserRecord => ({
  id: r.id,
  username: r.username,
  email: r.email ?? null,
  displayName: r.display_name,
  passwordHash: r.password_hash,
  admin: Boolean(r.admin),
  disabledAt: r.disabled_at,
  createdAt: r.created_at,
  // Legacy rows lack this column → undefined despite the type; normalise to null.
  personalSpace: r.personal_space ?? null,
})

export type PatRow = {
  id: string
  user_id: string
  name: string
  secret_hash: string
  scope: string
  spaces: string | null
  expires_at: string | null
  last_used_at: string | null
  revoked_at: string | null
  created_at: string
}

export const patOfRow = (r: PatRow): PatRecord => ({
  id: r.id,
  userId: r.user_id,
  name: r.name,
  secretHash: r.secret_hash,
  scope: r.scope as PatRecord['scope'],
  spaces: r.spaces == null ? null : (JSON.parse(r.spaces) as string[]),
  expiresAt: r.expires_at,
  lastUsedAt: r.last_used_at,
  revokedAt: r.revoked_at,
  createdAt: r.created_at,
})

export type SpaceRoleRow = { space: string; role: SpaceRole }

/** A row of the `folders` table (projects and plain folders, discriminated by `type`).
 *  canon: docs/projects.md#model */
export type ProjectRow = {
  id: string
  space: string
  path: string
  type: string
  slug: string
  aliases: string | null
  path_aliases: string | null
  display_name: string
  status: string
  last_seen: string
  created_at: string
}

export const projectOfRow = (r: ProjectRow): ProjectRecord => ({
  id: r.id,
  space: r.space,
  path: r.path,
  slug: r.slug,
  aliases: parseAliases(r.aliases),
  pathAliases: parseAliases(r.path_aliases),
  displayName: r.display_name,
  status: r.status as ProjectStatus,
  lastSeen: r.last_seen,
  createdAt: r.created_at,
})

/** The handle columns (slug/aliases/display_name/status) are inert for a plain folder. */
export const folderIdentityOfRow = (r: ProjectRow): FolderRecord => ({
  id: r.id,
  space: r.space,
  path: r.path,
  pathAliases: parseAliases(r.path_aliases),
  lastSeen: r.last_seen,
  createdAt: r.created_at,
})

/** Parse a JSON string-array column; NULL/absent/malformed → [] (defensive: we only write valid). */
export const parseAliases = (raw: string | null): string[] => {
  if (!raw) {
    return []
  }
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

// ── context sets rows ─────────────────────────────────────────────────

export type ContextSetRow = {
  id: string
  home_space: string
  name: string
  items: string | null
  created_at: string
}

export type ContextSetAttachmentRow = {
  set_id: string
  target_kind: string
  target_id: string
  target_space: string
  created_at: string
}

/** Parse the `items` JSON column to {space, noteId} refs; malformed entries dropped
 *  (defensive: a hand-edited DB or future schema shift must not crash a session). */
export const parseContextSetItems = (raw: string | null): ContextSetItemRef[] => {
  if (!raw) {
    return []
  }
  try {
    const v = JSON.parse(raw)

    if (!Array.isArray(v)) {
      return []
    }

    const items: ContextSetItemRef[] = []

    for (const item of v) {
      if (
        item &&
        typeof item === 'object' &&
        typeof (item as ContextSetItemRef).space === 'string' &&
        typeof (item as ContextSetItemRef).noteId === 'string'
      ) {
        items.push({
          space: (item as ContextSetItemRef).space,
          noteId: (item as ContextSetItemRef).noteId,
        })
      }
    }

    return items
  } catch {
    return []
  }
}

/** Reorder items to `noteIds`, SLOT-PRESERVING: only items named in `noteIds` are permuted
 *  (in request order) into their own slots; any item NOT named keeps its ORIGINAL slot — so a
 *  partial-view reorder never shoves a deduped-hidden or concurrently-added member to the tail
 *  (an append-to-tail scheme would silently relocate it across every attached scope). */
export const orderItems = (
  items: ContextSetItemRef[],
  order: ReadonlyArray<string | ContextSetItemRef>,
): ContextSetItemRef[] => {
  const byId = new Map<string, ContextSetItemRef>()
  const selected = new Map<string, ContextSetItemRef>()

  for (const item of items) {
    byId.set(item.noteId, item)
  }

  for (const entry of order) {
    const id = typeof entry === 'string' ? entry : entry.noteId
    const item = byId.get(id)

    if (item && !selected.has(id)) {
      selected.set(id, item)
    }
  }
  const queue = selected.values()

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]

    if (selected.has(item.noteId)) {
      items[index] = queue.next().value!
    }
  }

  return items
}

export const contextSetOfRow = (r: ContextSetRow): ContextSetRecord => ({
  id: r.id,
  homeSpace: r.home_space,
  name: r.name,
  items: parseContextSetItems(r.items),
  createdAt: r.created_at,
})

export const contextSetAttachmentOfRow = (
  r: ContextSetAttachmentRow,
): ContextSetAttachmentRecord => ({
  setId: r.set_id,
  targetKind: r.target_kind as ContextSetTargetKind,
  targetId: r.target_id,
  targetSpace: r.target_space,
  createdAt: r.created_at,
})

// ── scope pins rows ───────────────────────────────────────────────────

export type ScopePinRow = {
  target_kind: string
  target_id: string
  target_space: string
  note_space: string
  note_id: string
  created_at: string
}

export const scopePinOfRow = (r: ScopePinRow): ScopePinRecord => ({
  targetKind: r.target_kind as ContextSetTargetKind,
  targetId: r.target_id,
  targetSpace: r.target_space,
  noteSpace: r.note_space,
  noteId: r.note_id,
  createdAt: r.created_at,
})

// ── context order rows ────────────────────────────────────────────────

export type ContextOrderRow = {
  target_kind: string
  target_id: string
  target_space: string
  entry_kind: string
  entry_ref: string
  rank: number
}

export const contextOrderOfRow = (r: ContextOrderRow): ContextOrderRecord => ({
  targetKind: r.target_kind as ContextSetTargetKind,
  targetId: r.target_id,
  targetSpace: r.target_space,
  entryKind: r.entry_kind as ContextOrderEntryKind,
  entryRef: r.entry_ref,
  rank: r.rank,
})

/** Dedup a context-order sequence by (entryKind, entryRef), first occurrence wins: those
 *  columns are the PK, so a duplicate would collide on INSERT — drop it before writing. */
export const dedupOrderEntries = <T extends { entryKind: ContextOrderEntryKind; entryRef: string }>(
  entries: readonly T[],
): T[] => {
  const seen = new Set<string>()
  return entries.filter((e) =>
    seen.has(`${e.entryKind}:${e.entryRef}`)
      ? false
      : (seen.add(`${e.entryKind}:${e.entryRef}`), true),
  )
}

// ── OAuth rows ─────────────────────────────────────────────────────────

export type OAuthAccessRow = {
  id: string
  token_hash: string
  user_id: string
  client_id: string
  scope: string
  /** Space-id allowlist; NULL = all grants (not none). */
  spaces: string | null
  expires_at: string
  refresh_id: string | null
  revoked_at: string | null
  created_at: string
  last_used_at: string | null
}

export const accessOfRow = (r: OAuthAccessRow): OAuthAccessRecord => ({
  id: r.id,
  tokenHash: r.token_hash,
  userId: r.user_id,
  clientId: r.client_id,
  scope: r.scope as OAuthScope,
  spaces: r.spaces == null ? null : (JSON.parse(r.spaces) as string[]),
  expiresAt: r.expires_at,
  refreshId: r.refresh_id,
  revokedAt: r.revoked_at,
  createdAt: r.created_at,
  lastUsedAt: r.last_used_at,
})

export type OAuthRefreshRow = {
  id: string
  token_hash: string
  user_id: string
  client_id: string
  scope: string
  /** Space-id allowlist; NULL = all grants (not none). */
  spaces: string | null
  expires_at: string
  rotated_to: string | null
  revoked_at: string | null
  created_at: string
}

export const refreshOfRow = (r: OAuthRefreshRow): OAuthRefreshRecord => ({
  id: r.id,
  tokenHash: r.token_hash,
  userId: r.user_id,
  clientId: r.client_id,
  scope: r.scope as OAuthScope,
  spaces: r.spaces == null ? null : (JSON.parse(r.spaces) as string[]),
  expiresAt: r.expires_at,
  rotatedTo: r.rotated_to,
  revokedAt: r.revoked_at,
  createdAt: r.created_at,
})

// ── job rows ─────────────────────────────────────────────────

/** A row of the `jobs` table. `artifact_bytes` is INTEGER on sqlite but BIGINT on pg, and
 *  node-pg hands a BIGINT back as a STRING — hence the Number() coercion (a GB archive stays
 *  within Number's safe-integer range). canon: docs/jobs.md#model */
export type JobRow = {
  id: string
  space: string
  kind: string
  status: string
  principal: string
  params: string | null
  progress_done: number
  progress_total: number | null
  phase: string | null
  attempts: number
  max_attempts: number
  run_at: string
  locked_at: string | null
  locked_by: string | null
  artifact_ref: string | null
  artifact_bytes: number | string | null
  artifact_name: string | null
  result: string | null
  error: string | null
  created_at: string
  updated_at: string
  started_at: string | null
  completed_at: string | null
  expires_at: string | null
}

/** Defensive JSON decode for a `params`/`result` column — null/absent/malformed → null
 *  (a poisoned row must not crash a list). */
const parseJson = (raw: string | null): unknown => {
  if (raw == null) {
    return null
  }
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export const jobOfRow = (r: JobRow): JobRecord => ({
  id: r.id,
  space: r.space,
  kind: r.kind,
  status: r.status as JobStatus,
  principal: r.principal,
  params: parseJson(r.params),
  progressDone: Number(r.progress_done),
  progressTotal: r.progress_total == null ? null : Number(r.progress_total),
  phase: r.phase,
  attempts: Number(r.attempts),
  maxAttempts: Number(r.max_attempts),
  runAt: r.run_at,
  lockedAt: r.locked_at,
  lockedBy: r.locked_by,
  artifactRef: r.artifact_ref,
  artifactBytes: r.artifact_bytes == null ? null : Number(r.artifact_bytes),
  artifactName: r.artifact_name,
  result: parseJson(r.result),
  error: r.error,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  startedAt: r.started_at,
  completedAt: r.completed_at,
  expiresAt: r.expires_at,
})

/** A raw `agent_retrievals` row. */
export type RetrievalRow = {
  id: number | bigint | string
  agent_call_id: string | null
  owner: string
  principal: string
  agent: string | null
  session_id: string | null
  session_name: string | null
  session_attach: string | null
  tool: string
  query: string
  project: string | null
  class_filter: string | null
  result_count: number | string
  top_score: number | string | null
  hits: string | null
  created_at: string
}

/** Defensive decode of the `hits` JSON array; a poisoned/absent value yields [], shapeless
 *  entries dropped (a bad row can't crash the history list). */
const parseHits = (raw: string | null): RetrievalHit[] => {
  const parsed = parseJson(raw)

  if (!Array.isArray(parsed)) {
    return []
  }
  const out: RetrievalHit[] = []

  for (const h of parsed) {
    if (!h || typeof h !== 'object') {
      continue
    }
    const noteId = (h as { noteId?: unknown }).noteId

    if (typeof noteId !== 'string') {
      continue
    }
    const title = (h as { title?: unknown }).title
    const score = (h as { score?: unknown }).score
    const cls = (h as { class?: unknown }).class
    out.push({
      noteId,
      ...(typeof title === 'string' ? { title } : {}),
      ...(typeof score === 'number' ? { score } : {}),
      ...(typeof cls === 'string' ? { class: cls } : {}),
    })
  }

  return out
}

export const retrievalOfRow = (r: RetrievalRow): RetrievalLogRecord => ({
  id: String(r.id),
  agentCallId: r.agent_call_id ?? null,
  owner: r.owner,
  principal: r.principal,
  agent: r.agent,
  sessionId: r.session_id,
  sessionName: r.session_name,
  sessionAttach:
    r.session_attach === AGENT_SESSION_ATTACH.declared ||
    r.session_attach === AGENT_SESSION_ATTACH.inferred
      ? r.session_attach
      : null,
  tool: r.tool as RetrievalTool,
  query: r.query,
  project: r.project,
  classFilter: r.class_filter,
  resultCount: Number(r.result_count),
  topScore: r.top_score == null ? null : Number(r.top_score),
  hits: parseHits(r.hits),
  createdAt: r.created_at,
})

/** A raw session-audit event row: a retrieval, or a `note_revisions` write joined
 *  into the same stream (the write-only columns are NULL on a retrieval row). */
export type AuditEventRow = RetrievalRow & {
  event_type: 'retrieval' | 'write'
  source_rank: number
  note_id: string | null
  space: string | null
  revision_kind: string | null
  revision_title: string | null
  revision_class: string | null
  revision_integrity: string | null
}

type AuditWriteEvent = Extract<AgentSessionAuditEvent, { type: 'write' }>

/** Serve a contaminated write as a GAP — the session audit's twin of `revisionGapOf`,
 *  written once because the audit's shape is not a `Revision`. The write still
 *  HAPPENED in this session: its linkage, time and revision kind stay exact so counts,
 *  cursors and pages do not shift. What it was, and who is behind it, is withheld
 *  (#327). canon: docs/core.md#identity */
export const auditWriteGapOf = (e: AuditWriteEvent): AuditWriteEvent => ({
  ...e,
  principal: null,
  agent: null,
  title: REVISION_UNAVAILABLE_TITLE,
  class: null,
  unavailableReason: REVISION_UNAVAILABLE_REASON.identityConflict,
})

/** The ONE place a stored audit row becomes a served event, for both driver twins. */
export const auditEventOfRow = (r: AuditEventRow): AgentSessionAuditEvent => {
  if (r.event_type === 'retrieval') {
    return { type: 'retrieval', record: retrievalOfRow(r) }
  }
  const write: AuditWriteEvent = {
    type: 'write',
    id: String(r.id),
    at: r.created_at,
    principal: r.principal,
    agent: r.agent,
    sessionId: r.session_id,
    sessionName: r.session_name,
    sessionAttach:
      r.session_attach === AGENT_SESSION_ATTACH.declared ||
      r.session_attach === AGENT_SESSION_ATTACH.inferred
        ? r.session_attach
        : null,
    noteId: r.note_id ?? '',
    space: r.space ?? '',
    title: r.revision_title ?? '',
    class: r.revision_class,
    revisionKind: r.revision_kind as RevisionKind,
  }
  return r.revision_integrity === REVISION_INTEGRITY.quarantined ? auditWriteGapOf(write) : write
}
