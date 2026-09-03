import type { PoolClient } from 'pg'
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
//   L0j  per-job import fence (advisory) → L1 `note_identity` →
//   L1r  `import_reservations` → L1p `import_reservation_paths`
//   L2a  `favorites` → L2b `context_set_attachments` → L2c `context_sets` →
//   L2d  `context_scope_pins` → L2e per-scope order advisory → L2f `context_order`
//   L3m  wide-scan mutex → L3s/L3n/L3b space/note/blob stripes → L3t revision tables
//   L4f  `folders` → L4a `ability_availability`/`ability_project_bindings` →
//   L4p  `ability_preferences` → L5k `secret_keyring` →
//   L5c `credentials` → L5r `provider_resources` → L5a `provider_attachments` →
//   L5g `provider_call_log`
//
// Tier 4 closes the note/ability contour. L5k begins the provider contour with its
// instance-global active-key fence; later provider tables append below it. Within
// tier 4 a whole-space purge and an availability write are one order only when
// `folders` outranks the ability tables — the other way round is a cycle, and
// Postgres resolves cycles with `40P01`.
//
// Postgres cannot enforce an ordering, so the enforcement is ours and it is in two
// halves, both required: ESLint keeps every tiered lock inside this module (a lock
// taken by an inline `client.query` puts the order back into prose, which is where
// four live violations came from), and `test/meta-db-contract/pgLockOrder.test.ts`
// observes the sequence each transaction actually takes. A transaction that derives
// the order for itself deadlocks against one that derived it differently.
// canon: docs/core.md#identity · docs/note-history.md

import { type ABILITY_AVAILABILITY_MODE } from '@notarium/contract'
import { parseAbilityLocator, serializeAbilityLocator } from '@notarium/core'

import {
  abilityPackageOfLocator,
  type LiveRoleContextTarget,
  ownedRoleLocatorOfContextTarget,
  type OwnedRolePlacementTrailEvidence,
  resolveLiveRoleContextTarget,
  type RoleContextTargetAddress,
  roleContextTargetOfLocator,
} from '../../abilityAddress'
import type { ChainRow } from '../../revisionQuarantine'
import type { ContextOrderRow, ContextSetRow, ScopePinRow } from '../../rows'

/** The levels in the order every transaction takes them; the INDEX is the order. */
export const LOCK_LEVELS = [
  'L0j',
  'L1',
  'L1r',
  'L1p',
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
  'L4f',
  'L4a',
  'L4p',
  'L5k',
  'L5c',
  'L5r',
  'L5a',
  'L5g',
] as const

export type LockLevel = (typeof LOCK_LEVELS)[number]

/** The level a statement belongs to when it MUTATES this table. DML is levelled by
 *  its target (`INSERT INTO|DELETE FROM|UPDATE <table>`), never by the table names it
 *  merely mentions in a subquery. A table absent from this map is outside the
 *  hierarchy and constrains nothing OF ITS OWN — but a FOREIGN KEY pointing AT it
 *  does, silently, and that edge is stated in `NO_FOREIGN_KEY_MAY_POINT_AT` below. */
export const LOCK_LEVEL_OF_TABLE: Readonly<Record<string, LockLevel>> = {
  note_identity: 'L1',
  import_reservations: 'L1r',
  import_reservation_paths: 'L1p',
  favorites: 'L2a',
  context_set_attachments: 'L2b',
  context_sets: 'L2c',
  context_scope_pins: 'L2d',
  context_order: 'L2f',
  note_revisions: 'L3t',
  revision_blobs: 'L3t',
  revision_purge_fences: 'L3t',
  activity_projection_status: 'L3t',
  activity_revision_order: 'L3t',
  activity_note_actor_states: 'L3t',
  activity_note_actor_heads: 'L3t',
  activity_projection_gc: 'L3t',
  folders: 'L4f',
  ability_availability: 'L4a',
  ability_project_bindings: 'L4a',
  ability_preferences: 'L4p',
  // The trail a placement move leaves so an override written at the address it left
  // still lands where the package is. Written and read under the same advisory, by the
  // same two transactions, so it is the same level — not a level of its own.
  ability_placement_trail: 'L4p',
  secret_keyring: 'L5k',
  credentials: 'L5c',
  provider_resources: 'L5r',
  provider_attachments: 'L5a',
  provider_call_log: 'L5g',
}

/** Tables no FOREIGN KEY may point at, and the reason the ladder cannot survive one.
 *
 *  A foreign key is a lock statement nobody wrote: `INSERT`/`UPDATE` of the CHILD
 *  takes `FOR KEY SHARE` on the PARENT row, at whatever moment the child is written,
 *  which for a tier-4 child is the very bottom of the ladder. That is harmless while
 *  the parent is either levelled here (the ladder then orders both ends: a binding's
 *  `folders` parent is L4f, above the L4a child that points at it) or row-locked only
 *  by transactions that hold NOTHING ELSE (`agent_sessions`, `oauth_clients`, `jobs`
 *  — their holders take one row and commit, so they can close no cycle).
 *
 *  `spaces` is neither. `purgeSpace` takes the space row `FOR UPDATE` while it holds
 *  tiers 1–3 and BEFORE it deletes `folders` (L4f) and the ability tables (L4a) below
 *  it. A foreign key from a tier-4 table therefore inverts the pair: the writer holds
 *  L4f and waits for the space row, the purge holds the space row and waits for L4f,
 *  and Postgres answers `40P01`. `ability_availability` carried exactly that edge through
 *  three review rounds — the only foreign key to `spaces` this schema has ever had, in
 *  a meta-DB where every other table names its Space with a plain column. The pair
 *  probe over it stayed green throughout, because the two sides were released from one
 *  queue and the writer simply won the race; it takes a deadlock now.
 *
 *  So: model the table (give it a level and a helper here) or drop the key. The
 *  schema is checked against this list by `test/meta-db-contract/pgTransactionRegistry.test.ts`,
 *  which reads the migrations of BOTH dialects — SQLite has one writer and cannot
 *  deadlock, but a schema that disagrees between dialects is its own defect. */
export const NO_FOREIGN_KEY_MAY_POINT_AT: readonly string[] = ['spaces']

/** The one place the hierarchy demands the PRESENCE of a lock rather than its order:
 *  the order overlay is rewritten DELETE-then-INSERT, so a writer that never entered
 *  the per-scope advisory level collides on the primary key with one that did. No
 *  amount of ordering catches that — `DELETE FROM context_order` carries no lock text
 *  for ESLint to see either. */
export const LOCK_LEVEL_REQUIRES: Readonly<Partial<Record<LockLevel, LockLevel>>> = {
  L2f: 'L2e',
}

/** The levels a statement cannot enter by BEING a statement.
 *
 *  At most levels the write is its own lock: an exact-key `INSERT`/`UPDATE` takes the
 *  row it names, and two writers of that row meet on it whether or not either called a
 *  helper. Here they do not meet at all. What excludes at these levels is a lock on a
 *  KEY — an advisory, or the stripe standing in for a key set — and the writers pair
 *  off on keys they can both name rather than on rows either of them holds: an
 *  arbitration `INSERT` and a range `UPDATE` under READ COMMITTED are invisible to one
 *  another, so a transaction that declares one of these levels and calls no helper of
 *  this module holds NOTHING there. It is not out of order; it is unserialized, and
 *  the loser of the race is a write that silently disappears.
 *
 *  That is why the register is held to this list transaction by transaction
 *  (`pgTransactionRegistry.test.ts`): "the level has a helper somewhere" was true of
 *  `L4p` while both of its call sites could be deleted with every portable test green.
 *  A sweep with no key to name says so in its own register entry, by level and with a
 *  reason — the exemption is a fact about that transaction, not a hole in the rule. */
export const LEVELS_NO_STATEMENT_CAN_ENTER: readonly LockLevel[] = [
  'L0j',
  'L2b',
  'L2d',
  'L2e',
  'L3m',
  'L3s',
  'L3n',
  'L3b',
  'L4p',
  'L5k',
]

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

/** …and the pin advisory one level above it, on the SAME pair. Two namespaces because
 *  they are two levels: a transaction that takes both takes them in ladder order, and
 *  one that takes the pin lock alone must not be excluded by a reorder. */
const SCOPE_PIN_LOCK_NS = 0x7363_5069 // 'scPi'

const ROLE_CONTEXT_TARGET_LOCK_NS = 'notarium:role-context-target'
const ROLE_SCOPE_PIN_LOCK_NS = 'notarium:role-scope-pin'
const ROLE_CONTEXT_ORDER_LOCK_NS = 'notarium:role-context-order'

const hash32 = (s: string): number => {
  let h = 0

  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  }

  return h
}

/** Keys a per-scope advisory lock — the pin level and the reorder level below it name
 *  the same `(kind, id)` pair, so they hash it the same way and differ only in their
 *  namespace. A hash collision merely serializes two unrelated scopes, never a
 *  correctness issue. */
const scopeLockKey = (targetKind: string, targetId: string): number =>
  hash32(`${targetKind}:${targetId}`)

/** The advisory keys of a set of scopes, taken in one order by every caller of every
 *  level that keys by a scope. */
const takeScopeAdvisoryLocks = async (
  client: PoolClient,
  namespace: number,
  scopes: ReadonlyArray<{ targetKind: string; targetId: string }>,
): Promise<void> => {
  const seen = new Set<number>()
  // Sorted by the lock KEY, not by a rendered pair: the key is what Postgres orders
  // on, so two callers agree even when different scopes hash alike, and a target id
  // needs no separator escaping.
  const keys = scopes
    .map((scope) => scopeLockKey(scope.targetKind, scope.targetId))
    .filter((key) => !seen.has(key) && seen.add(key))
    .sort((left, right) => left - right)

  for (const key of keys) {
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [namespace, key])
  }
}

const lockRoleTargetEvidence = async (
  client: PoolClient,
  namespace: string,
  locators: readonly string[],
): Promise<{
  packages: string[]
  trails: ReadonlyMap<string, OwnedRolePlacementTrailEvidence>
}> => {
  const packages = [...new Set(locators.map(abilityPackageOfLocator))].sort()
  const trails = new Map<string, OwnedRolePlacementTrailEvidence>()

  for (const packageKey of packages) {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [
      namespace,
      packageKey,
    ])
  }
  // READ COMMITTED fixes one snapshot per statement. Reading the trail in the same
  // statement that waits on the advisory would therefore resume with evidence from
  // BEFORE the move commit it just waited for. This exact post-lock query is a second
  // statement on purpose: it owns the fresh snapshot that makes forwarding live.
  const result = await client.query(
    `SELECT from_locator, to_locator, registry_note_id, manifest_note_id
       FROM ability_placement_trail
      WHERE from_locator = ANY($1::text[])`,
    [[...new Set(locators)]],
  )

  for (const row of result.rows as Array<{
    from_locator: string
    to_locator: string
    registry_note_id: string
    manifest_note_id: string
  }>) {
    trails.set(row.from_locator, {
      toLocator: row.to_locator,
      registryNoteId: row.registry_note_id,
      manifestNoteId: row.manifest_note_id,
    })
  }

  return { packages, trails }
}

const roleContextKeys = (
  locators: readonly string[],
  trails: ReadonlyMap<string, OwnedRolePlacementTrailEvidence>,
): string[] => {
  const keys = new Set<string>()

  for (const serialized of locators) {
    const locator = parseAbilityLocator(serialized)

    if (locator?.source !== 'owned' || locator.kind !== 'role') {
      continue
    }
    const target = roleContextTargetOfLocator(locator)
    keys.add(`role:${target.targetId}`)
    keys.add(
      `role:${resolveLiveRoleContextTarget(target, trails.get(serialized) ?? null).target.targetId}`,
    )
  }

  return [...keys].sort()
}

/** L2b — package-invariant Role target arbitration plus exact one-hop evidence. */
export const lockRoleContextTargets = async (client: PoolClient, locators: readonly string[]) => {
  const evidence = await lockRoleTargetEvidence(client, ROLE_CONTEXT_TARGET_LOCK_NS, locators)
  const keys = roleContextKeys(locators, evidence.trails)

  return { lock: hold('L2b', keys, keys), trails: evidence.trails }
}

export const lockLiveRoleContextTarget = async (
  client: PoolClient,
  target: RoleContextTargetAddress,
): Promise<{ lock: LockHold; live: LiveRoleContextTarget }> => {
  const locator = ownedRoleLocatorOfContextTarget(target)

  if (!locator) {
    throw new Error('invalid Owned Role context target projection')
  }
  const serialized = serializeAbilityLocator(locator)
  const locked = await lockRoleContextTargets(client, [serialized])

  return {
    lock: locked.lock,
    live: resolveLiveRoleContextTarget(target, locked.trails.get(serialized) ?? null),
  }
}

export const lockRoleScopePinTargets = async (client: PoolClient, locators: readonly string[]) => {
  const evidence = await lockRoleTargetEvidence(client, ROLE_SCOPE_PIN_LOCK_NS, locators)
  const keys = roleContextKeys(locators, evidence.trails)

  return { lock: hold('L2d', keys, keys), trails: evidence.trails }
}

export const lockLiveRoleScopePinTarget = async (
  client: PoolClient,
  target: RoleContextTargetAddress,
): Promise<{ lock: LockHold; live: LiveRoleContextTarget }> => {
  const locator = ownedRoleLocatorOfContextTarget(target)

  if (!locator) {
    throw new Error('invalid Owned Role context target projection')
  }
  const serialized = serializeAbilityLocator(locator)
  const locked = await lockRoleScopePinTargets(client, [serialized])

  return {
    lock: locked.lock,
    live: resolveLiveRoleContextTarget(target, locked.trails.get(serialized) ?? null),
  }
}

export const lockRoleContextOrderPackages = async (
  client: PoolClient,
  locators: readonly string[],
): Promise<{ lock: LockHold }> => {
  const packages = [...new Set(locators.map(abilityPackageOfLocator))].sort()

  for (const packageKey of packages) {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [
      ROLE_CONTEXT_ORDER_LOCK_NS,
      packageKey,
    ])
  }
  const keys = roleContextKeys(locators, new Map())

  return { lock: hold('L2e', keys, keys) }
}

const SECRET_KEYRING_LOCK_NS = 0x7365_634b // 'secK'

/** The common provider/Space fence. These rows are deliberately outside the tier
 * ladder: `spaces` cannot be an FK parent of provider rows, and membership must be
 * held before entering L5 so offer and removeMember cannot pass each other. Every
 * provider lifecycle transaction takes them in this exact order: Space, member,
 * credential, resource, attachment. */
export const lockProviderSpaceRow = async (
  client: PoolClient,
  space: string,
): Promise<{ exists: boolean; archivedAt: string | null; phase: string | null }> => {
  const result = await client.query(
    `SELECT spaces.id, spaces.archived_at, space_lifecycle.phase
       FROM spaces
       LEFT JOIN space_lifecycle ON space_lifecycle.space = spaces.id
      WHERE spaces.id = $1
      FOR UPDATE OF spaces`,
    [space],
  )
  const row = result.rows[0] as
    { id: string; archived_at: string | null; phase: string | null } | undefined

  return { exists: Boolean(row), archivedAt: row?.archived_at ?? null, phase: row?.phase ?? null }
}

export const lockProviderMembershipRows = async (
  client: PoolClient,
  space: string,
  usernames: readonly string[],
): Promise<ReadonlySet<string>> => {
  const keys = [...new Set(usernames.filter((username) => username !== '@system'))].sort()

  if (!keys.length) {
    return new Set()
  }
  const result = await client.query(
    `SELECT username FROM space_members
      WHERE space = $1 AND username = ANY($2::text[])
      ORDER BY username FOR UPDATE`,
    [space, keys],
  )

  return new Set((result.rows as Array<{ username: string }>).map(({ username }) => username))
}

export const lockProviderMembershipRow = async (
  client: PoolClient,
  space: string,
  username: string,
): Promise<boolean> =>
  username === '@system' ||
  (await lockProviderMembershipRows(client, space, [username])).has(username)

/** L5k — the instance-global active-key fence. The advisory covers the empty-table
 *  bootstrap case; row locks then keep every existing generation stable until commit. */
export const lockSecretKeyring = async (
  client: PoolClient,
): Promise<{ lock: LockHold; rows: Array<{ key_id: string }> }> => {
  await client.query('SELECT pg_advisory_xact_lock($1, $2)', [SECRET_KEYRING_LOCK_NS, 0])
  const result = await client.query(
    'SELECT * FROM secret_keyring WHERE retired_at IS NULL ORDER BY generation FOR UPDATE',
  )

  return {
    lock: hold('L5k', ['credential-keyring'], ['credential-keyring'], 'range'),
    rows: result.rows as Array<{ key_id: string }>,
  }
}

const lockProviderRows = async (
  client: PoolClient,
  table: 'credentials' | 'provider_resources' | 'provider_attachments',
  ids: readonly string[],
): Promise<{ keys: string[]; rows: Array<{ id: string }> }> => {
  const keys = [...new Set(ids)].sort()

  if (!keys.length) {
    return { keys, rows: [] }
  }
  const result = await client.query(
    `SELECT id FROM ${table} WHERE id = ANY($1::text[]) ORDER BY id FOR UPDATE`,
    [keys],
  )
  const rows = result.rows as Array<{ id: string }>

  return { keys, rows }
}

/** Provider contour locks. Each returns a LockHold so the live order observer sees
 * the entry; missing ids remain declared-but-unheld and their INSERT is ordered. */
export const lockProviderCredentialRows = async (client: PoolClient, ids: readonly string[]) => {
  const { keys, rows } = await lockProviderRows(client, 'credentials', ids)
  return {
    lock: hold(
      'L5c',
      keys,
      rows.map((row) => row.id),
    ),
    rows,
  }
}

export const lockProviderResourceRows = async (client: PoolClient, ids: readonly string[]) => {
  const { keys, rows } = await lockProviderRows(client, 'provider_resources', ids)
  return {
    lock: hold(
      'L5r',
      keys,
      rows.map((row) => row.id),
    ),
    rows,
  }
}

export const lockProviderAttachmentRows = async (client: PoolClient, ids: readonly string[]) => {
  const { keys, rows } = await lockProviderRows(client, 'provider_attachments', ids)
  return {
    lock: hold(
      'L5a',
      keys,
      rows.map((row) => row.id),
    ),
    rows,
  }
}

const PROVIDER_CALL_LOG_LOCK_NS = 0x7063_614c // 'pcaL'

/** L5g — the journal tail, and the one provider level whose key is not a row id.
 *  An interactive intent inserts an id nobody else can name, so the statement is its
 *  own lock and the helper only declares the key rule 3 orders. A durable job call is
 *  different: two re-claims of the SAME logical call have no row to meet on until one
 *  of them has inserted, and under READ COMMITTED they would both read "no attempt
 *  yet" and both send. The advisory is where they meet instead. */
export const lockProviderCallLogEntry = async (
  client: PoolClient,
  entry: { id: string; job: { jobId: string; jobCallKey: string } | null },
): Promise<{ lock: LockHold }> => {
  if (!entry.job) {
    return { lock: hold('L5g', [entry.id], []) }
  }
  const key = `${entry.job.jobId}\u0000${entry.job.jobCallKey}`
  await client.query('SELECT pg_advisory_xact_lock($1, $2)', [
    PROVIDER_CALL_LOG_LOCK_NS,
    hash32(key),
  ])

  return { lock: hold('L5g', [key], [key], 'range') }
}

/** Full-carrier recovery/rotation scans cannot discover their row ids before they
 * exclude inserts. Table locks make the scanned set stable; ordinary writers still
 * enter by their exact row helpers in the same provider-level order. */
export const lockProviderCredentialRange = async (
  client: PoolClient,
): Promise<{ lock: LockHold }> => {
  await client.query('LOCK TABLE credentials IN SHARE ROW EXCLUSIVE MODE')
  return { lock: hold('L5c', [], [], 'range') }
}

export const lockProviderResourceRange = async (
  client: PoolClient,
): Promise<{ lock: LockHold }> => {
  await client.query('LOCK TABLE provider_resources IN SHARE ROW EXCLUSIVE MODE')
  return { lock: hold('L5r', [], [], 'range') }
}

// ── L0j · per-job import fence ───────────────────────────────────────────────

/** Namespaces the per-job advisory so it can never alias another single-arg key. */
const IMPORT_JOB_LOCK_NS = 0x696d_704a // 'impJ'

/** L0j — the fence every durable import path enters FIRST, and the only one that
 *  outranks identity: reserve, adopt, the fenced physical write, terminal close, and
 *  the transitions that invalidate a run FROM OUTSIDE it — cancel and reap.
 *  `release`, `succeed` and `fail` are deliberately not here: a run performs those on
 *  itself, after its own last write returned, so there is nothing for them to
 *  interleave with and taking the fence would only make a worker wait for its own
 *  lock. Transaction-scoped, so COMMIT/ROLLBACK releases it and no file I/O can
 *  outlive it by accident.
 *
 *  The heartbeat deliberately does NOT take it. A member that takes minutes must be
 *  able to keep its lease alive while the fence is held, or the reaper would kill the
 *  very job that is making progress — which is why the reaper re-checks staleness
 *  AFTER it gets the fence.
 *
 *  A hash collision merely serializes two unrelated jobs; it is never a correctness
 *  issue, exactly as for the per-scope order lock above. */
export const lockImportJobAdvisory = async (
  client: PoolClient,
  jobId: string,
): Promise<{ lock: LockHold }> => {
  await client.query('SELECT pg_advisory_xact_lock($1, $2)', [IMPORT_JOB_LOCK_NS, hash32(jobId)])

  return { lock: hold('L0j', [jobId], [jobId]) }
}

export type ImportJobPremise =
  { ok: true; lock: LockHold } | { ok: false; lock: LockHold; detail: string }

/** L0j — the fence PLUS the premise a reservation path may not proceed without: this
 *  job row is running, under this very lease.
 *
 *  The row is re-read with a plain SELECT, deliberately not `FOR UPDATE`. Holding a
 *  jobs row lock across the caller's file write is the thing this design refuses: the
 *  advisory is the mutual exclusion, the row read is only the premise, and the
 *  heartbeat must stay free to touch that row throughout. A mismatch aborts here,
 *  before any lower level is entered. */
export const lockImportJobFence = async (
  client: PoolClient,
  jobId: string,
  workerLease: string,
): Promise<ImportJobPremise> => {
  const { lock } = await lockImportJobAdvisory(client, jobId)
  const res = await client.query('SELECT status, locked_by FROM jobs WHERE id = $1', [jobId])
  const row = res.rows[0] as { status?: string; locked_by?: string | null } | undefined

  if (!row) {
    return { ok: false, lock, detail: `job ${jobId} no longer exists` }
  }
  if (row.status !== 'running' || row.locked_by !== workerLease) {
    return {
      ok: false,
      lock,
      detail: `job ${jobId} is ${row.status ?? 'gone'} under lease ${row.locked_by ?? 'none'}`,
    }
  }

  return { ok: true, lock }
}

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
  legacy_name_aliases: string | null
  settlement_successor_id: string | null
}

export const IDENTITY_COLUMNS =
  'id, file_path, space, created_at, materialized, deleted_at, address_revision, legacy_name_aliases, settlement_successor_id'

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

/** UNLOCKED probe: live occupants at exact paths. Restore uses it only to widen and
 *  re-check its destination conflict set; reference lineage is id-addressed through
 *  `settlement_successor_id`, never inferred from this path lookup. */
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

// ── L1r · import_reservations · L1p · import_reservation_paths ───────────────

export type ImportReservationHeaderRow = {
  id: string
  space: string
  job_id: string
  upload_ref: string
  fence: string
  status: 'active' | 'closing'
}

export type ImportReservationPathRow = {
  entry_key: string
  destination_path: string
  target_id: string
  expected_id: string | null
  ownership: 'existing-reference' | 'fresh-owned'
}

const RESERVATION_COLUMNS = 'id, space, job_id, upload_ref, fence, status'

/** A claim carries the PLAN and nothing derived from it — see the type in
 *  `metaDb/types.ts` for why "did it land" is not a column here. */
export const IMPORT_RESERVATION_PATH_COLUMNS =
  'entry_key, destination_path, target_id, expected_id, ownership'

/** The ONE vocabulary of L1p keys, for every helper of this level: the claim rows
 *  are arbitrated by the unique index on `(space, destination_path)`, so that pair —
 *  and not `entry_key`, which is only unique WITHIN a reservation — is what two
 *  transactions actually contend for. A level whose keys are declared in one
 *  vocabulary and written in another is a level the gate cannot check. */
const reservationPathKey = (space: string, destinationPath: string): string =>
  `${space}:${destinationPath}`

/** L1r — the reservation header, addressed the three ways its lifecycle needs it:
 *  by upload (reserve/adopt, the immutable key), by id (a fenced write), by job
 *  (terminal cleanup). One helper per address, still ONE entry per transaction. */
export const lockImportReservationByUpload = async (
  client: PoolClient,
  space: string,
  uploadRef: string,
): Promise<{ lock: LockHold; row: ImportReservationHeaderRow | null }> => {
  const key = `${space}:${uploadRef}`
  const res = await client.query(
    `SELECT ${RESERVATION_COLUMNS} FROM import_reservations
       WHERE space = $1 AND upload_ref = $2 FOR UPDATE`,
    [space, uploadRef],
  )
  const row = (res.rows[0] as ImportReservationHeaderRow | undefined) ?? null
  // The same row, addressed two ways: FOUND by its natural key, WRITTEN by its
  // surrogate id. Both belong to the declaration — one that named only the key
  // would forbid the very write this level is entered for. The composite is
  // spelled with `:` because the statement reaches SQL with the parts as
  // parameters, and either spelling counts as naming the row.
  const declared = row ? [key, row.id] : [key]

  return { lock: hold('L1r', declared, row ? declared : []), row }
}

export const lockImportReservationById = async (
  client: PoolClient,
  reservationId: string,
): Promise<{ lock: LockHold; row: ImportReservationHeaderRow | null }> => {
  const res = await client.query(
    `SELECT ${RESERVATION_COLUMNS} FROM import_reservations WHERE id = $1 FOR UPDATE`,
    [reservationId],
  )
  const row = (res.rows[0] as ImportReservationHeaderRow | undefined) ?? null

  return { lock: hold('L1r', [reservationId], row ? [reservationId] : []), row }
}

export const lockImportReservationByJob = async (
  client: PoolClient,
  jobId: string,
): Promise<{ lock: LockHold; row: ImportReservationHeaderRow | null }> => {
  const res = await client.query(
    `SELECT ${RESERVATION_COLUMNS} FROM import_reservations WHERE job_id = $1 ORDER BY id FOR UPDATE`,
    [jobId],
  )
  const row = (res.rows[0] as ImportReservationHeaderRow | undefined) ?? null

  return { lock: hold('L1r', [jobId], row ? [jobId] : [], 'range'), row }
}

/** L1p — this reservation's destination claims, in entry order. */
export const lockImportReservationPaths = async (
  client: PoolClient,
  space: string,
  reservationId: string,
): Promise<{ lock: LockHold; rows: ImportReservationPathRow[] }> => {
  const res = await client.query(
    `SELECT ${IMPORT_RESERVATION_PATH_COLUMNS}
       FROM import_reservation_paths WHERE reservation_id = $1
      ORDER BY entry_key FOR UPDATE`,
    [reservationId],
  )
  const rows = res.rows as ImportReservationPathRow[]
  const keys = rows.map((row) => reservationPathKey(space, row.destination_path))

  return { lock: hold('L1p', keys, keys, 'range'), rows }
}

/** L1p — ONE destination claim, the unit a fenced write actually works on. Locking
 *  the whole reservation to find one row made every write cost the size of the
 *  import: a 10 000-note tree took 10 000 row locks per note, held across a file
 *  write. The level is entered once either way; only the key set narrows.
 *
 *  Addressed by `(space, destination_path)` — the UNIQUE index — and NOT by
 *  `(reservation_id, destination_path)`, which no index serves: that predicate made
 *  Postgres seq-scan the whole batch (10 000 claims: `Rows Removed by Filter: 9999`,
 *  7.4 ms) for the one row a write needs. The reservation is then a FILTER on the row
 *  the index found: a claim held by somebody else's import is not this write's, and
 *  the caller refuses the destination exactly as it does for one nobody claimed. */
export const lockImportReservationPath = async (
  client: PoolClient,
  space: string,
  reservationId: string,
  destinationPath: string,
): Promise<{ lock: LockHold; row: ImportReservationPathRow | null }> => {
  const res = await client.query(
    `SELECT reservation_id, ${IMPORT_RESERVATION_PATH_COLUMNS}
       FROM import_reservation_paths
      WHERE space = $1 AND destination_path = $2 FOR UPDATE`,
    [space, destinationPath],
  )
  const claimed = res.rows[0] as (ImportReservationPathRow & { reservation_id: string }) | undefined
  const key = reservationPathKey(space, destinationPath)

  // The key is declared whether or not a row stands at it: the level was entered for
  // this destination, and that is what the transaction may touch here.
  return {
    lock: hold('L1p', [key], claimed ? [key] : []),
    row: claimed?.reservation_id === reservationId ? claimed : null,
  }
}

/** L1p — the destinations a reserve is about to CLAIM. They do not exist yet, so the
 *  level is entered by creating them, and rule 3 applies: sorted by the unique key
 *  `(space, destination_path)`, so two imports whose sets overlap collide in one
 *  agreed order instead of deadlocking halfway through each other's list.
 *
 *  The UNIQUE violation IS the answer here — another live import owns one of these
 *  paths — so the caller reads it as a refusal, not as an error. */
export const insertImportReservationPaths = async (
  client: PoolClient,
  reservationId: string,
  space: string,
  entries: ReadonlyArray<{
    entryKey: string
    destinationPath: string
    targetId: string
    expectedId: string | null
    ownership: 'existing-reference' | 'fresh-owned'
  }>,
): Promise<{ lock: LockHold }> => {
  const sorted = [...entries].sort((left, right) =>
    left.destinationPath < right.destinationPath
      ? -1
      : left.destinationPath > right.destinationPath
        ? 1
        : 0,
  )

  for (const entry of sorted) {
    await client.query(
      `INSERT INTO import_reservation_paths
         (reservation_id, entry_key, space, destination_path, target_id, expected_id, ownership)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        reservationId,
        entry.entryKey,
        space,
        entry.destinationPath,
        entry.targetId,
        entry.expectedId,
        entry.ownership,
      ],
    )
  }
  // Declared but NOT held: every one of these keys was absent when the level was
  // entered — creating them IS the entry. `declared` minus `held` is the set rule 3
  // orders, so calling them held would make the one rule this helper exists to obey
  // vacuous, which is exactly what it was.
  const keys = sorted.map((entry) => reservationPathKey(space, entry.destinationPath))

  return { lock: hold('L1p', keys, []) }
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

export const lockAbilityCreateOperationRow = async <T>(
  client: PoolClient,
  operationId: string,
  mode: 'share' | 'update' = 'update',
): Promise<T | undefined> => {
  const result = await client.query(
    mode === 'share'
      ? 'SELECT * FROM ability_create_operations WHERE id = $1 FOR SHARE'
      : 'SELECT * FROM ability_create_operations WHERE id = $1 FOR UPDATE',
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

// ── L4f/L4a · ability availability ──────────────────────────────────────────

/** Serialize replacement of one package's availability record. The advisory
 * namespace cannot alias any other application lock; a hash collision only
 * serializes unrelated packages. */
export const lockAbilityAvailabilityPackage = async (
  client: PoolClient,
  homeSpace: string,
  packageId: string,
): Promise<void> => {
  await client.query(
    `SELECT pg_advisory_xact_lock(
       hashtext('notarium:ability-availability'),
       hashtext($1)
     )`,
    [JSON.stringify([homeSpace, packageId])],
  )
}

/** L4f — the project rows whose membership validates a selected-project binding. The
 *  share lock is what makes the check hold to COMMIT, and taking it here rather than
 *  inline is what makes the level visible: a whole-space purge drops these same rows,
 *  and the two orders have to be one order. */
export const lockAbilityHomeProjects = async (
  client: PoolClient,
  homeSpace: string,
  projectIds: readonly string[],
): Promise<{ ids: string[]; lock: LockHold }> => {
  const declared = [...new Set(projectIds)].sort()

  if (!declared.length) {
    return { ids: [], lock: hold('L4f', [], []) }
  }
  const result = await client.query(
    `SELECT id FROM folders
      WHERE type = 'project' AND space = $1 AND id = ANY($2::text[])
      ORDER BY id
      FOR SHARE`,
    [homeSpace, declared],
  )
  const ids = (result.rows as Array<{ id: string }>).map(({ id }) => id)

  return { ids, lock: hold('L4f', declared, ids) }
}

/** L4f — one project parent row, keyed exactly. The delta cursors take it so their
 *  child rows are written under the same parent-first order a retype trigger and a
 *  project delete take; it was an inline `FOR KEY SHARE` with a note saying `folders`
 *  is "outside the note-identity hierarchy", which stopped being true the moment the
 *  table became L4f. Nothing else about that transaction changes: it enters one level
 *  and writes tables the hierarchy does not know. */
export const lockProjectParentRow = async (
  client: PoolClient,
  projectId: string,
): Promise<{ ids: string[]; lock: LockHold }> => {
  const result = await client.query(
    "SELECT id FROM folders WHERE id = $1 AND type = 'project' FOR KEY SHARE",
    [projectId],
  )
  const ids = (result.rows as Array<{ id: string }>).map(({ id }) => id)

  return { ids, lock: hold('L4f', [projectId], ids) }
}

/** L4a — the optional current availability row, after its package advisory lock. */
export const lockAbilityAvailabilityRow = async (
  client: PoolClient,
  homeSpace: string,
  packageId: string,
): Promise<{
  mode:
    | typeof ABILITY_AVAILABILITY_MODE.allProjects
    | typeof ABILITY_AVAILABILITY_MODE.selectedProjects
    | undefined
  lock: LockHold
}> => {
  const key = `${homeSpace}:${packageId}`
  const result = await client.query(
    `SELECT mode FROM ability_availability
      WHERE home_space = $1 AND package_id = $2
      FOR UPDATE`,
    [homeSpace, packageId],
  )
  const row = result.rows[0] as
    | {
        mode:
          | typeof ABILITY_AVAILABILITY_MODE.allProjects
          | typeof ABILITY_AVAILABILITY_MODE.selectedProjects
      }
    | undefined

  return { mode: row?.mode, lock: hold('L4a', [key], row ? [key] : []) }
}

// ── L4p · ability preferences ───────────────────────────────────────────────

/** Namespaces the per-package override lock; it can alias no other application key. */
const ABILITY_PREFERENCES_LOCK_NS = 'notarium:ability-preferences'

/** L4p — the PACKAGES a transaction may rewrite owner state for, and the only entry
 *  this level has.
 *
 *  An advisory rather than a row lock, because the two writers of `ability_preferences`
 *  cannot meet on a row at all. `setEnabled` writes one `(owner, locator)` that need
 *  not exist yet; a placement move rewrites the `locator` COLUMN for every owner at
 *  once and can therefore name no prefix of that primary key. Under READ COMMITTED the
 *  move's range `UPDATE` neither sees nor locks a row inserted after its snapshot, so
 *  without this the two simply pass through each other and one of the writes is lost.
 *
 *  Keyed by the PACKAGE (`abilityPackageOfLocator`) although the rows are keyed by the
 *  locator, and that is the point: the locator is exactly what the move changes. A
 *  locator key holds only while both sides spell the address the same way, and the
 *  case this level exists for is the one where they do not — a disable that names the
 *  address the package has just left has to reach the same stripe as the move that
 *  left it, or it resolves its address forward (`ability_placement_trail`) with no lock
 *  over the answer. The package is invariant under a move, so the package is the
 *  stripe, and every transaction here needs exactly ONE key.
 *
 *  Sorted anyway, and the set is a set: a move takes both of its addresses, and two of
 *  them mirrored would otherwise each hold the other's first key for Postgres to
 *  resolve with `40P01`. Sorting keeps that impossible even if the two addresses ever
 *  stop naming one package.
 *
 *  What it does NOT cover, on purpose: the two SWEEPS of this table
 *  (`revisions.purgeNotes`, `pgMetaDb.purgeSpace`) are keyed by the lifecycle columns
 *  and have no package to name. They are already ordered against `setEnabled` by the
 *  tier-3 stripes its lifecycle fence takes first, which is why `LOCK_LEVEL_REQUIRES`
 *  has no L4p entry — a presence rule here would be unsatisfiable for exactly the
 *  transactions that do not need it. Both say so in their register entries instead,
 *  where `pgTransactionRegistry.test.ts` holds every other transaction to the helper.
 *
 *  A hash collision only serializes two unrelated packages. */
export const lockAbilityPreferencePackages = async (
  client: PoolClient,
  locators: readonly string[],
): Promise<{ lock: LockHold }> => {
  const declared = [...new Set(locators.map(abilityPackageOfLocator))].sort()

  for (const packageKey of declared) {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [
      ABILITY_PREFERENCES_LOCK_NS,
      packageKey,
    ])
  }

  // An advisory key is never ABSENT — there is no row for it to be missing — so what
  // this entry makes live is rule 3: a statement at L4p names a package declared here
  // or it is a lock this transaction never took. Same shape as L0j, L2d and L2e.
  return { lock: hold('L4p', declared, declared) }
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

/** L2d — the TARGETS a transaction may pin a note at, or re-address every pin of.
 *
 *  An advisory rather than the row locks below it, and for the same reason `L4p` is
 *  one: these two writers cannot meet on a row. `addPin` INSERTs a row keyed by
 *  `(target_kind, target_id, note_id)` that need not exist yet; a placement move
 *  rewrites `target_id` for every pin of a target at once and can name no note of it.
 *  Under READ COMMITTED the move's range `UPDATE` neither sees nor locks a row
 *  inserted after its snapshot, so without this the two pass straight through each
 *  other — the pin lands on the target id the role has just LEFT, and nothing ever
 *  sweeps `context_scope_pins` by target except the opposite move, so the note the
 *  user pinned is gone from that role's context for good. The target is the one key
 *  both sides can name, so the target is the stripe.
 *
 *  Sorted inside, because a move names TWO of them: two moves with mirrored pairs
 *  would otherwise each hold the other's first key and Postgres would answer `40P01`.
 *  The sort is the shared one, on the KEY, so this level and the reorder advisory a
 *  level below agree about the order of the same pair.
 *
 *  What it does NOT cover, on purpose: the two sweeps of this table
 *  (`identity.settleFileClaim` by note, `pgMetaDb.purgeSpace` by `target_space`) have
 *  no target to name. Both meet a pin writer on rows or above it — the settlement on
 *  the pin rows themselves, the purge on the Space row and the tier-3 stripes — which
 *  is why their register entries declare the sweep rather than a helper. */
export const lockScopePinTargets = async (
  client: PoolClient,
  targets: ReadonlyArray<{ targetKind: string; targetId: string }>,
): Promise<{ lock: LockHold }> => {
  await takeScopeAdvisoryLocks(client, SCOPE_PIN_LOCK_NS, targets)
  const declared = [
    ...new Set(targets.map((target) => `${target.targetKind}:${target.targetId}`)),
  ].sort()

  // An advisory key is never ABSENT — there is no row for it to be missing — so what
  // this entry makes live is rule 3, exactly as at L0j, L2e and L4p.
  return { lock: hold('L2d', declared, declared) }
}

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

export const lockLiveRoleScopePinsInScope = async (
  client: PoolClient,
  target: RoleContextTargetAddress,
  noteIds: readonly string[],
): Promise<{ lock: LockHold; live: LiveRoleContextTarget; rows: ScopePinRow[] }> => {
  const locator = ownedRoleLocatorOfContextTarget(target)

  if (!locator) {
    throw new Error('invalid Owned Role context target projection')
  }
  const serialized = serializeAbilityLocator(locator)
  const locked = await lockRoleScopePinTargets(client, [serialized])
  const live = resolveLiveRoleContextTarget(target, locked.trails.get(serialized) ?? null)
  const ids = [...new Set(noteIds)].sort()

  if (!ids.length) {
    return { lock: locked.lock, live, rows: [] }
  }
  const result = await client.query(
    `SELECT target_kind, target_id, target_space, note_space, note_id, created_at
       FROM context_scope_pins
      WHERE target_kind = 'role' AND target_id = $1 AND note_id = ANY($2)
      ORDER BY note_id FOR UPDATE`,
    [live.target.targetId, ids],
  )

  return { lock: locked.lock, live, rows: result.rows as ScopePinRow[] }
}

// ── L2e · per-scope order advisory ───────────────────────────────────────────

/** L2e — the per-scope context-order locks, sorted by scope. The overlay is
 *  rewritten DELETE-then-INSERT, and under READ COMMITTED two such transactions miss
 *  each other's committed rows and collide on the primary key. */
export const lockContextOrderScopes = async (
  client: PoolClient,
  scopes: ReadonlyArray<{ targetKind: string; targetId: string }>,
): Promise<{ lock: LockHold }> => {
  await takeScopeAdvisoryLocks(client, CONTEXT_ORDER_LOCK_NS, scopes)
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
    await takeScopeAdvisoryLocks(client, CONTEXT_ORDER_LOCK_NS, fresh)
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

/** L3t — the per-space Activity projection tail. Append triggers, initialization
 * and final publication serialize on this row. Ordinary progress builds from a
 * non-locking snapshot and conditionally updates this exact row only after its
 * state batch, so it cannot hold commit-order allocation across set-oriented work. */
export const lockActivityProjectionStatus = async <T>(
  client: PoolClient,
  space: string,
): Promise<{ lock: LockHold; row: T | undefined }> => {
  const result = await client.query(
    'SELECT * FROM activity_projection_status WHERE space = $1 FOR UPDATE',
    [space],
  )

  return {
    lock: hold('L3t', [space], result.rows.length ? [space] : []),
    row: result.rows[0] as T | undefined,
  }
}

/** L3t — one durable inert-generation queue row, in generation order. */
export const lockActivityProjectionGcRow = async <T extends { generation: unknown }>(
  client: PoolClient,
  space: string,
): Promise<{ lock: LockHold; row: T | undefined }> => {
  const result = await client.query(
    `SELECT generation, phase FROM activity_projection_gc
      WHERE space = $1 ORDER BY generation LIMIT 1 FOR UPDATE`,
    [space],
  )
  const row = result.rows[0] as T | undefined

  return {
    lock: hold(
      'L3t',
      row ? [`${space}:${String(row.generation)}`] : [],
      row ? [`${space}:${String(row.generation)}`] : [],
    ),
    row,
  }
}
