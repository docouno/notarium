// The ONE statement of PostgreSQL lock order for this meta-DB, and — with
// `revisionLocks` — the ONLY module allowed to take a tiered lock at all. SQLite needs
// none of this: it has a single writer, so nothing here applies to it.
//
// A LEVEL is the unit of order, and the three rules over levels are:
//
//   1. a transaction's level indices never DECREASE;
//   2. a level is entered ONCE, through a helper of this module, which declares the
//      keys the transaction may then touch at that level;
//   3. keys that did not exist when the level was entered (an arbitration
//      `INSERT … ON CONFLICT`) are created in sorted order.
//
// The levels, in order:
//
//   L1   `note_identity`
//   L2a  `favorites` → L2b `context_set_attachments` → L2c `context_sets` →
//   L2d  `context_scope_pins` → L2e per-scope order advisory → L2f `context_order`
//   L3m  wide-scan mutex → L3s/L3n/L3b space/note/blob stripes → L3t revision tables
//
// Postgres cannot enforce an ordering, so the enforcement is ours and it is in two
// halves, both required: ESLint keeps every tiered lock inside this module (a lock
// taken by an inline `client.query` puts the order back into prose, which is where
// four live violations came from), and `test/meta-db-contract/pgLockOrder.test.ts`
// observes the sequence each transaction actually takes. A transaction that derives
// the order for itself deadlocks against one that derived it differently.
// canon: docs/core.md#identity · docs/note-history.md

import type { PoolClient } from 'pg'

import type { ChainRow } from '../../revisionQuarantine'
import type { ContextOrderRow, ContextSetRow, ScopePinRow } from '../../rows'

/** The levels in the order every transaction takes them; the INDEX is the order. */
export const LOCK_LEVELS = [
  'L1',
  'L2a',
  'L2b',
  'L2c',
  'L2d',
  'L2e',
  'L2f',
  'L3m',
  'L3s',
  'L3n',
  'L3b',
  'L3t',
] as const

export type LockLevel = (typeof LOCK_LEVELS)[number]

/** The level a statement belongs to when it MUTATES this table. DML is levelled by
 *  its target (`INSERT INTO|DELETE FROM|UPDATE <table>`), never by the table names it
 *  merely mentions in a subquery. A table absent from this map is outside the
 *  hierarchy and constrains nothing. */
export const LOCK_LEVEL_OF_TABLE: Readonly<Record<string, LockLevel>> = {
  note_identity: 'L1',
  favorites: 'L2a',
  context_set_attachments: 'L2b',
  context_sets: 'L2c',
  context_scope_pins: 'L2d',
  context_order: 'L2f',
  note_revisions: 'L3t',
  revision_blobs: 'L3t',
  revision_purge_fences: 'L3t',
}

/** The one place the hierarchy demands the PRESENCE of a lock rather than its order:
 *  the order overlay is rewritten DELETE-then-INSERT, so a writer that never entered
 *  the per-scope advisory level collides on the primary key with one that did. No
 *  amount of ordering catches that — `DELETE FROM context_order` carries no lock text
 *  for ESLint to see either. */
export const LOCK_LEVEL_REQUIRES: Readonly<Partial<Record<LockLevel, LockLevel>>> = {
  L2f: 'L2e',
}

/** What a helper hands back about the lock it just took: the level it entered, the
 *  keys the entry declared, and the ones that turned out to exist. `declared` minus
 *  `held` is the absent set — the keys rule 3 orders. A `range` hold could not name
 *  its keys up front (a whole-space sweep, a LIKE prefilter), so it declares what it
 *  actually locked and rules 2–3 do not apply to DML under it. */
export type LockHold = {
  level: LockLevel
  scope: 'keys' | 'range'
  declared: readonly string[]
  held: readonly string[]
}

const hold = (
  level: LockLevel,
  declared: readonly string[],
  held: readonly string[],
  scope: LockHold['scope'] = 'keys',
): LockHold => ({ level, scope, declared, held })

/** Namespaces the two-arg per-scope reorder lock so it can never alias the single-arg SETUP_LOCK_KEY. */
const CONTEXT_ORDER_LOCK_NS = 0x6374_4f72 // 'ctOr'

const hash32 = (s: string): number => {
  let h = 0

  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  }

  return h
}

/** Keys the per-scope advisory lock; a hash collision merely serializes two unrelated scopes, never a correctness issue. */
const contextOrderLockKey = (targetKind: string, targetId: string): number =>
  hash32(`${targetKind}:${targetId}`)

// ── L1 · note_identity ───────────────────────────────────────────────────────

/** One identity row, as every facet of this driver reads it. The columns and the
 *  type live here because the primary read of a tiered table belongs with its lock:
 *  the caller that reads a row it did not lock is the bug this module prevents. */
export type IdentityRow = {
  id: string
  file_path: string
  space: string
  created_at: string | null
  materialized: boolean
  deleted_at: string | null
  address_revision: string | number
}

export const IDENTITY_COLUMNS =
  'id, file_path, space, created_at, materialized, deleted_at, address_revision'

/** An unlocked read needs no transaction, so the pool itself can run it. */
export type Queryable = Pick<PoolClient, 'query'>

/** UNLOCKED probe: which rows these ids have right now. Its only job is to widen the
 *  set the caller then locks in ONE pass — reading it proves nothing on its own. */
export const readIdentityRows = async (
  client: Queryable,
  noteIds: readonly string[],
): Promise<IdentityRow[]> => {
  const ids = [...new Set(noteIds)].sort()

  if (!ids.length) {
    return []
  }
  const res = await client.query(
    `SELECT ${IDENTITY_COLUMNS} FROM note_identity WHERE id = ANY($1) ORDER BY id`,
    [ids],
  )

  return res.rows as IdentityRow[]
}

/** UNLOCKED probe: the live rows standing at these paths — the successors a retired
 *  reference canonicalizes onto. Read once before the tier-1 entry (to widen the set)
 *  and once after it (to prove nothing appeared in between). */
export const readLiveIdentityAtPaths = async (
  client: Queryable,
  paths: ReadonlyArray<{ space: string; filePath: string }>,
): Promise<IdentityRow[]> => {
  if (!paths.length) {
    return []
  }
  const res = await client.query(
    `SELECT ${IDENTITY_COLUMNS} FROM note_identity
       WHERE deleted_at IS NULL
         AND (space, file_path) IN (SELECT * FROM unnest($1::text[], $2::text[]))
       ORDER BY id`,
    [paths.map((p) => p.space), paths.map((p) => p.filePath)],
  )

  return res.rows as IdentityRow[]
}

/** L1 — the identity rows a transaction may touch, sorted. */
export const lockIdentityRows = async (
  client: PoolClient,
  noteIds: readonly string[],
): Promise<{ lock: LockHold; rows: IdentityRow[] }> => {
  const ids = [...new Set(noteIds)].sort()

  if (!ids.length) {
    return { lock: hold('L1', [], []), rows: [] }
  }
  const res = await client.query(
    `SELECT ${IDENTITY_COLUMNS} FROM note_identity WHERE id = ANY($1) ORDER BY id FOR UPDATE`,
    [ids],
  )
  const rows = res.rows as IdentityRow[]

  return {
    lock: hold(
      'L1',
      ids,
      rows.map((row) => row.id),
    ),
    rows,
  }
}

/** L1 — every identity row of one space, for a whole-space operation that will
 *  delete them. Taken by key range rather than by id list: the caller does not know
 *  the ids, and it must still enter the hierarchy at the top. */
export const lockSpaceIdentityRows = async (
  client: PoolClient,
  space: string,
): Promise<{ lock: LockHold; ids: string[] }> => {
  const res = await client.query(
    `SELECT id FROM note_identity WHERE space = $1 ORDER BY id FOR UPDATE`,
    [space],
  )
  const ids = (res.rows as Array<{ id: string }>).map((row) => row.id)

  return { lock: hold('L1', ids, ids, 'range'), ids }
}

// ── causal row locks (outside the tier index) ───────────────────────────────
// These rows are serialized by the causal advisory plan, but their row locks
// still live here so every PostgreSQL lock remains visible to the same finite
// surface. They do not acquire a LockLevel and therefore do not participate in
// the L1→L3 observer; callers must take any identity tier before their causal plan.

export const lockSpaceLifecycleRow = async <T>(
  client: PoolClient,
  space: string,
  mode: 'share' | 'update' = 'update',
): Promise<T | undefined> => {
  const result = await client.query(
    mode === 'share'
      ? 'SELECT * FROM space_lifecycle WHERE space = $1 FOR SHARE'
      : 'SELECT * FROM space_lifecycle WHERE space = $1 FOR UPDATE',
    [space],
  )

  return result.rows[0] as T | undefined
}

export const lockRestoreOperationRow = async <T>(
  client: PoolClient,
  operationId: string,
  mode: 'share' | 'update' = 'update',
): Promise<T | undefined> => {
  const result = await client.query(
    mode === 'share'
      ? 'SELECT * FROM restore_operations WHERE id = $1 FOR SHARE'
      : 'SELECT * FROM restore_operations WHERE id = $1 FOR UPDATE',
    [operationId],
  )

  return result.rows[0] as T | undefined
}

export const lockRestoreParentRow = async (
  client: PoolClient,
  operationId: string,
  space: string,
): Promise<boolean> => {
  const result = await client.query(
    `SELECT id FROM restore_operations
      WHERE id = $1 AND space = $2
        AND endpoint = 'trash-restore-many'
        AND phase NOT IN ('succeeded', 'rejected')
      FOR SHARE`,
    [operationId, space],
  )

  return result.rows.length > 0
}

export const lockOwnerProofRow = async <T>(
  client: PoolClient,
  noteId: string,
): Promise<T | undefined> => {
  const result = await client.query(
    'SELECT * FROM note_owner_proofs WHERE note_id = $1 FOR UPDATE',
    [noteId],
  )

  return result.rows[0] as T | undefined
}

export const lockInstallationGenerationRow = async <T>(
  client: PoolClient,
): Promise<T | undefined> => {
  const result = await client.query(
    'SELECT * FROM installation_generation WHERE singleton = 1 FOR UPDATE',
  )

  return result.rows[0] as T | undefined
}

export const lockBackupGenerationFreezeRow = async <T>(
  client: PoolClient,
): Promise<T | undefined> => {
  const result = await client.query(
    'SELECT * FROM backup_generation_freeze WHERE singleton = 1 FOR UPDATE',
  )

  return result.rows[0] as T | undefined
}

// ── L2a · favorites ──────────────────────────────────────────────────────────

export type FavoriteNoteRow = {
  owner: string
  entity_id: string
  created_at: string
  rank: number | null
}

/** L2a — this space's note favourites for the given entity ids. */
export const lockFavoriteNoteRows = async (
  client: PoolClient,
  space: string,
  entityIds: readonly string[],
): Promise<{ lock: LockHold; rows: FavoriteNoteRow[] }> => {
  const ids = [...new Set(entityIds)].sort()
  const res = await client.query(
    `SELECT owner, entity_id, created_at, rank FROM favorites
      WHERE space = $1 AND kind = 'note' AND entity_id = ANY($2)
      ORDER BY owner, entity_id FOR UPDATE`,
    [space, ids],
  )
  const rows = res.rows as FavoriteNoteRow[]

  return { lock: hold('L2a', ids, [...new Set(rows.map((row) => row.entity_id))]), rows }
}

// ── L2c · context_sets ───────────────────────────────────────────────────────

export type ContextSetItemsRow = { id: string; items: string | null }

/** L2c — one set by id, for the read-modify-write of its item array. */
export const lockContextSetRow = async (
  client: PoolClient,
  setId: string,
): Promise<{ lock: LockHold; row: ContextSetRow | null }> => {
  const res = await client.query(
    'SELECT id, home_space, name, items, created_at FROM context_sets WHERE id = $1 FOR UPDATE',
    [setId],
  )
  const row = (res.rows[0] as ContextSetRow | undefined) ?? null

  return { lock: hold('L2c', [setId], row ? [setId] : []), row }
}

/** L2c — every set whose payload MENTIONS this id. A LIKE prefilter keeps the strict
 *  parse (which REFUSES a malformed payload) off every set in the base; the escape is
 *  here rather than at the call site because the predicate and the lock are one thing. */
export const lockContextSetsMentioning = async (
  client: PoolClient,
  noteId: string,
): Promise<{ lock: LockHold; rows: ContextSetItemsRow[] }> => {
  const res = await client.query(
    `SELECT id, items FROM context_sets WHERE items LIKE $1 ESCAPE '\\' ORDER BY id FOR UPDATE`,
    [`%${noteId.replace(/[\\%_]/g, (c) => '\\' + c)}%`],
  )
  const rows = res.rows as ContextSetItemsRow[]
  const ids = rows.map((row) => row.id)

  return { lock: hold('L2c', ids, ids, 'range'), rows }
}

// ── L2d · context_scope_pins ─────────────────────────────────────────────────

/** L2d — every scope's pin of these notes, wherever it lives. The rows of BOTH sides
 *  of a re-key are taken together: the target's row is a merge partner, and filtering
 *  it out by `note_space` would leave the row the INSERT then collides with unlocked. */
export const lockScopePinsForNotes = async (
  client: PoolClient,
  noteIds: readonly string[],
): Promise<{ lock: LockHold; rows: ScopePinRow[] }> => {
  const ids = [...new Set(noteIds)].sort()

  if (!ids.length) {
    return { lock: hold('L2d', [], []), rows: [] }
  }
  const res = await client.query(
    `SELECT target_kind, target_id, target_space, note_space, note_id, created_at
       FROM context_scope_pins
      WHERE note_id = ANY($1)
      ORDER BY target_kind, target_id, note_id FOR UPDATE`,
    [ids],
  )
  const rows = res.rows as ScopePinRow[]

  return { lock: hold('L2d', ids, [...new Set(rows.map((row) => row.note_id))]), rows }
}

/** L2d — one scope's pins of these notes, for a reorder that must know each entry's
 *  home space. The membership row is the ONLY structural source of that space. */
export const lockScopePinsInScope = async (
  client: PoolClient,
  targetKind: string,
  targetId: string,
  noteIds: readonly string[],
): Promise<{ lock: LockHold; rows: ScopePinRow[] }> => {
  const ids = [...new Set(noteIds)].sort()

  if (!ids.length) {
    return { lock: hold('L2d', [], []), rows: [] }
  }
  const res = await client.query(
    `SELECT target_kind, target_id, target_space, note_space, note_id, created_at
       FROM context_scope_pins
      WHERE target_kind = $1 AND target_id = $2 AND note_id = ANY($3)
      ORDER BY note_id FOR UPDATE`,
    [targetKind, targetId, ids],
  )
  const rows = res.rows as ScopePinRow[]

  return { lock: hold('L2d', ids, [...new Set(rows.map((row) => row.note_id))]), rows }
}

// ── L2e · per-scope order advisory ───────────────────────────────────────────

/** L2e — the per-scope context-order locks, sorted by scope. The overlay is
 *  rewritten DELETE-then-INSERT, and under READ COMMITTED two such transactions miss
 *  each other's committed rows and collide on the primary key. */
const takeContextOrderScopeLocks = async (
  client: PoolClient,
  scopes: ReadonlyArray<{ targetKind: string; targetId: string }>,
): Promise<void> => {
  const seen = new Set<number>()
  // Sorted by the lock KEY, not by a rendered pair: the key is what Postgres orders
  // on, so two callers agree even when different scopes hash alike, and a target id
  // needs no separator escaping.
  const keys = scopes
    .map((scope) => contextOrderLockKey(scope.targetKind, scope.targetId))
    .filter((key) => !seen.has(key) && seen.add(key))
    .sort((left, right) => left - right)

  for (const key of keys) {
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [CONTEXT_ORDER_LOCK_NS, key])
  }
}

export const lockContextOrderScopes = async (
  client: PoolClient,
  scopes: ReadonlyArray<{ targetKind: string; targetId: string }>,
): Promise<{ lock: LockHold }> => {
  await takeContextOrderScopeLocks(client, scopes)
  const declared = [...new Set(scopes.map((scope) => `${scope.targetKind}:${scope.targetId}`))]

  return { lock: hold('L2e', declared, declared) }
}

/** L2e — every scope a whole-space purge is about to drop the overlay of. The scope
 *  set can only be READ, and a reader cannot lock what does not exist yet: a
 *  `setOrder` committing a brand-new scope for this space after the read would have
 *  its overlay deleted without its lock, or outlive the purge as an orphan. So the
 *  read repeats UNDER the locks already held — the second pass sees everything the
 *  first missed, and a scope newer than that belongs to pins this transaction has
 *  already deleted. One helper, so the level is still entered exactly once. */
export const lockContextOrderScopesOfSpace = async (
  client: PoolClient,
  space: string,
): Promise<{ lock: LockHold }> => {
  const held = new Map<string, { targetKind: string; targetId: string }>()

  for (let pass = 0; pass < 2; pass++) {
    const found = await client.query(
      'SELECT DISTINCT target_kind, target_id FROM context_order WHERE target_space = $1',
      [space],
    )
    const fresh = (found.rows as Array<{ target_kind: string; target_id: string }>)
      .map((row) => ({ targetKind: row.target_kind, targetId: row.target_id }))
      .filter((scope) => !held.has(`${scope.targetKind}:${scope.targetId}`))

    if (!fresh.length) {
      break
    }
    for (const scope of fresh) {
      held.set(`${scope.targetKind}:${scope.targetId}`, scope)
    }
    await takeContextOrderScopeLocks(client, fresh)
  }
  const keys = [...held.keys()]

  return { lock: hold('L2e', keys, keys, 'range') }
}

// ── L2f · context_order ──────────────────────────────────────────────────────

/** L2f — the order overlays of these scopes, in rank order within each. All the
 *  scopes at once: a level is entered once, so a per-scope loop of locking reads is
 *  the very shape the rule forbids. */
export const lockContextOrderRows = async (
  client: PoolClient,
  scopes: ReadonlyArray<{ targetKind: string; targetId: string }>,
): Promise<{ lock: LockHold; rows: ContextOrderRow[] }> => {
  const keys = [...new Set(scopes.map((scope) => `${scope.targetKind}:${scope.targetId}`))].sort()

  if (!keys.length) {
    return { lock: hold('L2f', [], []), rows: [] }
  }
  const res = await client.query(
    `SELECT target_kind, target_id, target_space, entry_kind, entry_ref, rank
       FROM context_order
      WHERE (target_kind, target_id) IN (SELECT * FROM unnest($1::text[], $2::text[]))
      ORDER BY target_kind, target_id, rank ASC FOR UPDATE`,
    [scopes.map((scope) => scope.targetKind), scopes.map((scope) => scope.targetId)],
  )
  const rows = res.rows as ContextOrderRow[]

  return {
    lock: hold('L2f', keys, [...new Set(rows.map((row) => `${row.target_kind}:${row.target_id}`))]),
    rows,
  }
}

// ── L3m · wide-scan mutex ────────────────────────────────────────────────────

/** L3m — one mutex for the transactions whose revision keys are not a sorted set
 *  known before the first lock. Sorting within a tier is what keeps it deadlock-free,
 *  and two callers cannot obey that: a quarantine closure grows as it is walked, and a
 *  purge discovers its notes and blobs from rows it has already locked. Taking turns
 *  is the only order they can share. An append needs none of this — it takes exactly
 *  one note and one blob, in that order, and can therefore never hold a key one of
 *  these wants while waiting for a key it holds.
 *
 *  It comes AFTER tiers 1 and 2, like every other revision lock. */
export const lockRevisionWideScan = async (client: PoolClient): Promise<{ lock: LockHold }> => {
  await client.query(`SELECT pg_advisory_xact_lock(hashtext('notarium:revision:wide'), 0)`)

  return { lock: hold('L3m', ['wide'], ['wide']) }
}

// ── L3t · revision rows ──────────────────────────────────────────────────────

// Cast the BIGINT columns to TEXT so the shared planner compares ids as the
// strings the port speaks, matching the SQLite twin exactly.
export const REVISION_CHAIN_COLUMNS = `id::text AS id, note_id, space,
    base_rev::text AS base_rev, their_rev::text AS their_rev,
    source_rev::text AS source_rev, integrity`

/** L3t — the revision rows of a contamination closure, sorted by id. Only reachable
 *  behind the wide-scan mutex: the closure re-expands as it is held. */
export const lockRevisionChainRows = async (
  client: PoolClient,
  revisionIds: readonly string[],
): Promise<{ lock: LockHold; rows: ChainRow[] }> => {
  const ids = [...revisionIds].sort()

  if (!ids.length) {
    return { lock: hold('L3t', [], []), rows: [] }
  }
  const res = await client.query(
    `SELECT ${REVISION_CHAIN_COLUMNS} FROM note_revisions
      WHERE id = ANY($1::bigint[]) ORDER BY id FOR UPDATE`,
    [ids],
  )
  const rows = res.rows as ChainRow[]

  return {
    lock: hold(
      'L3t',
      ids,
      rows.map((row) => row.id),
    ),
    rows,
  }
}
/** L3t — every revision row of ONE note, for a transaction that must write rows the
 *  contamination closure never contained (the target of a re-key already has its own
 *  history). Only reachable behind the wide-scan mutex, like the closure lock itself. */
export const lockRevisionChainRowsOfNote = async (
  client: PoolClient,
  space: string,
  noteId: string,
): Promise<{ lock: LockHold; rows: ChainRow[] }> => {
  const res = await client.query(
    `SELECT ${REVISION_CHAIN_COLUMNS} FROM note_revisions
      WHERE space = $1 AND note_id = $2 ORDER BY id FOR UPDATE`,
    [space, noteId],
  )
  const rows = res.rows as ChainRow[]
  const ids = rows.map((row) => row.id)

  return { lock: hold('L3t', ids, ids, 'range'), rows }
}
