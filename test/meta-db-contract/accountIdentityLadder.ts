// The seeded world the 0008_account_identity carrier is proven on, shared by the SQLite
// and PostgreSQL ladder tests. What every carrier column of the registry holds:
//
//   - a name-keyed column (`username` → `user_id`) and an owner column: a name that
//     resolves to a live user and one that does not (an orphan). The owner columns hold
//     the `@system` literal on top of that; a bare name-keyed column has no literal to
//     hold, because nothing but a username was ever written there.
//   - a principal column, and both `prepared_evidence` documents: a resolvable AND an
//     orphaned principal in each of the three schemes — `user:`, `pat:` and `oauth:` —
//     plus the `ui` literal in the columns (a JSON document never holds it). Each scheme
//     is its own carrier fragment, so a scheme nobody orphaned in a given column lets
//     that fragment lose its resolvability condition without turning one test red, and a
//     scheme nobody made resolvable there lets the fragment be deleted outright.
//
// The composite carriers add a decoy at the wrong path and a tail full of colons; and
// users bound to personal spaces in every non-active lifecycle phase prove that the
// rebuild of `users` repopulates before its BEFORE INSERT gate comes back.
//
// Sharing a seed is not by itself sharing the questions — the dialects answer the same
// one only where the seed reaches the same state on both, and statement granularity
// decides that. PostgreSQL defers AFTER ROW triggers to the end of a statement, so a
// single multi-row INSERT of revisions lets the initializer of the first row see the
// whole batch unordered and open the Activity projection already
// `rebuilding`. The revisions below therefore go in one statement per row, which leaves
// the projection `ready` on both dialects — the pre-state the ladder tests assert before
// they assert the carrier invalidated it.

import { expect } from 'vitest'

import { ACCOUNT_IDENTITY_CARRIERS } from './metaDbCatalog'

export const NON_ACTIVE_PHASES = [
  'closing',
  'archived',
  'purge-intent',
  'metadata-cleaned',
  'physical-cleaned',
  'purged',
] as const

/** Seed SQL for a ladder migrated through `0007_activity_projection`. */
export const accountIdentitySeedSql = (postgres: boolean): string => {
  const bool = (value: boolean): string => (postgres ? String(value) : value ? '1' : '0')
  const personalSpaces = NON_ACTIVE_PHASES.map((_, index) => `sp-p${index + 1}`)

  return `
    INSERT INTO users (username, display_name, password_hash, admin, disabled_at, created_at)
    VALUES ('alice', 'Alice A.', 'scrypt-alice', ${bool(false)}, NULL, 't-alice'),
           ('bob', 'Bob B.', NULL, ${bool(true)}, 't-bob-disabled', 't-bob');
    INSERT INTO spaces (id, slug, notes_dir, display_name, created_at, archived_by)
    VALUES ('sp-a', 'a', 'a', 'A', 't', 'user:alice'),
           ('sp-b', 'b', 'b', 'B', 't', 'pat:bob:key:with:colons'),
           ('sp-c', 'c', 'c', 'C', 't', 'pat:ghost:key:with:colons'),
           ('sp-d', 'd', 'd', 'D', 't', 'oauth:alice:tok1'),
           ('sp-e', 'e', 'e', 'E', 't', 'oauth:ghost:tok2'),
           ('sp-ui', 'ui', 'ui', 'UI', 't', 'ui'),
           ('sp-ghost', 'ghost', 'ghost', 'Ghost', 't', 'user:ghost'),
           ${personalSpaces.map((space) => `('${space}', '${space}', '${space}', 'P', 't', NULL)`).join(',\n           ')};
    -- The lifecycle rows the trigger seeded copy \`archived_by\`; rewriting them here
    -- keeps the two carrier columns independent, so neither one can pass on the other's
    -- coverage. Between them the two hold a resolvable and an orphaned principal of
    -- every scheme, plus the \`ui\` literal.
    UPDATE space_lifecycle SET changed_by = 'oauth:alice:tok1' WHERE space = 'sp-a';
    UPDATE space_lifecycle SET changed_by = 'ui' WHERE space = 'sp-b';
    UPDATE space_lifecycle SET changed_by = 'user:bob' WHERE space = 'sp-c';
    UPDATE space_lifecycle SET changed_by = 'pat:alice:pat1' WHERE space = 'sp-d';
    UPDATE space_lifecycle SET changed_by = 'pat:ghost:pat2' WHERE space = 'sp-e';
    UPDATE space_lifecycle SET changed_by = 'oauth:ghost:tok2' WHERE space = 'sp-ui';
    UPDATE space_lifecycle SET changed_by = 'user:ghost' WHERE space = 'sp-ghost';
    INSERT INTO users (username, display_name, created_at, personal_space)
    VALUES ${personalSpaces
      .map(
        (space, index) => `('p${index + 1}', 'Person ${index + 1}', 't-p${index + 1}', '${space}')`,
      )
      .join(',\n           ')};
    ${NON_ACTIVE_PHASES.map(
      (phase, index) =>
        `UPDATE space_lifecycle SET phase = '${phase}' WHERE space = '${personalSpaces[index]}';`,
    ).join('\n    ')}
    INSERT INTO sessions (id_hash, username, created_at, expires_at)
    VALUES ('s1', 'alice', 't', 'z'), ('s2', 'ghost', 't', 'z');
    INSERT INTO pats (id, username, name, secret_hash, scope, created_at)
    VALUES ('pat1', 'alice', 'Laptop', 'hash', 'write', 't'),
           ('pat2', 'ghost', 'Gone', 'hash', 'read', 't');
    INSERT INTO space_members (space, username, role, created_at)
    VALUES ('sp-a', 'alice', 'owner', 't'), ('sp-a', 'ghost', 'reader', 't');
    INSERT INTO one_time_tokens (id_hash, username, purpose, expires_at, created_at)
    VALUES ('o1', 'alice', 'invite', 'z', 't'), ('o2', 'ghost', 'reset', 'z', 't');
    INSERT INTO oauth_auth_codes
      (code_hash, client_id, username, redirect_uri, scope, code_challenge, code_challenge_method, expires_at, created_at)
    VALUES ('c1', 'app', 'bob', 'https://app.example', 'read', 'ch', 'S256', 'z', 't'),
           ('c2', 'app', 'ghost', 'https://app.example', 'read', 'ch', 'S256', 'z', 't');
    INSERT INTO oauth_access_tokens (id, token_hash, username, client_id, scope, expires_at, created_at)
    VALUES ('tok1', 'hash', 'bob', 'app', 'read', 'z', 't'), ('tok2', 'hash', 'ghost', 'app', 'read', 'z', 't');
    INSERT INTO oauth_refresh_tokens (id, token_hash, username, client_id, scope, expires_at, created_at)
    VALUES ('ref1', 'hash', 'bob', 'app', 'read', 'z', 't'), ('ref2', 'hash', 'ghost', 'app', 'read', 'z', 't');
    INSERT INTO agent_sessions (id, owner, name, named, created_at, last_seen_at, calls)
    VALUES ('ses_1', 'alice', 'one', ${bool(true)}, 't', 't', 1),
           ('ses_2', '@system', 'two', ${bool(false)}, 't', 't', 1),
           ('ses_3', 'ghost', 'three', ${bool(false)}, 't', 't', 1);
    INSERT INTO agent_retrievals (owner, principal, tool, query, result_count, created_at)
    VALUES ('alice', 'pat:alice:pat1', 'search', 'q', 0, 't1'),
           ('@system', 'ui', 'search', 'q', 0, 't2'),
           ('ghost', 'user:ghost', 'search', 'q', 0, 't3'),
           ('alice', 'user:alice', 'search', 'q', 0, 't4'),
           ('ghost', 'pat:ghost:pat2', 'search', 'q', 0, 't5'),
           ('alice', 'oauth:alice:tok1', 'search', 'q', 0, 't6'),
           ('ghost', 'oauth:ghost:tok2', 'search', 'q', 0, 't7');
    INSERT INTO agent_calls
      (id, owner, principal, transport, tool, effect, domain, started_at, input_bytes, input_shape,
       fingerprint, projection_version, redacted, truncated)
    VALUES ('call1', 'bob', 'oauth:bob:tok1', 'mcp', 'search', 'read', 'notes', 't', 0, '{}', 'f', 1,
            ${bool(false)}, ${bool(false)}),
           ('call2', '@system', 'ui', 'mcp', 'search', 'read', 'notes', 't', 0, '{}', 'f', 1,
            ${bool(false)}, ${bool(false)}),
           ('call3', 'ghost', 'user:ghost', 'mcp', 'search', 'read', 'notes', 't', 0, '{}', 'f', 1,
            ${bool(false)}, ${bool(false)}),
           ('call4', 'bob', 'user:bob', 'mcp', 'search', 'read', 'notes', 't', 0, '{}', 'f', 1,
            ${bool(false)}, ${bool(false)}),
           ('call5', 'alice', 'pat:alice:pat1', 'mcp', 'search', 'read', 'notes', 't', 0, '{}', 'f', 1,
            ${bool(false)}, ${bool(false)}),
           ('call6', 'ghost', 'pat:ghost:pat2', 'mcp', 'search', 'read', 'notes', 't', 0, '{}', 'f', 1,
            ${bool(false)}, ${bool(false)}),
           ('call7', 'ghost', 'oauth:ghost:tok2', 'mcp', 'search', 'read', 'notes', 't', 0, '{}', 'f', 1,
            ${bool(false)}, ${bool(false)});
    INSERT INTO agent_session_cleanup_markers (owner, session_id, reason, accepted_at, cleanup_pending)
    VALUES ('alice', 'ses_1', 'retention', 't', ${bool(true)}),
           ('@system', 'ses_2', 'retention', 't', ${bool(true)}),
           ('ghost', 'ses_3', 'retention', 't', ${bool(true)});
    INSERT INTO folders (id, space, path, slug, display_name, status, last_seen, created_at, type)
    VALUES ('proj1', 'sp-a', 'p', 'proj1', 'Proj', 'active', 't', 't', 'project');
    INSERT INTO mcp_delta_owner_cursors (owner, project, last_rev, updated_at)
    VALUES ('alice', 'proj1', '1', 't'), ('@system', 'proj1', '2', 't'), ('ghost', 'proj1', '3', 't');
    INSERT INTO ability_preferences (owner, locator, updated_at)
    VALUES ('alice', 'loc', 't'), ('@system', 'loc', 't'), ('ghost', 'loc', 't');
    INSERT INTO credentials (id, owner, name, kind, secret, origin)
    VALUES ('cred1', 'alice', 'key', 'bearer', 'v1', 'origin'),
           ('cred2', 'ghost', 'key', 'bearer', 'v1', 'origin'),
           ('cred3', '@system', 'key', 'bearer', 'v1', 'origin');
    INSERT INTO provider_resources (id, owner, name, wire, base_url)
    VALUES ('res1', 'alice', 'llm', 'openai', 'https://llm.example'),
           ('res2', '@system', 'llm', 'openai', 'https://llm.example'),
           ('res3', 'ghost', 'llm', 'openai', 'https://llm.example');
    INSERT INTO provider_call_log (id, owner, principal, resource_id, host, delivery_state, outcome, created_at)
    VALUES ('pcl1', 'alice', 'user:alice', 'res1', 'llm.example', 'sent', 'ok', 't'),
           ('pcl2', '@system', 'ui', 'res2', 'llm.example', 'sent', 'ok', 't'),
           ('pcl3', 'ghost', 'user:ghost', 'res3', 'llm.example', 'sent', 'ok', 't'),
           ('pcl4', 'alice', 'pat:alice:pat1', 'res1', 'llm.example', 'sent', 'ok', 't'),
           ('pcl5', 'ghost', 'pat:ghost:pat2', 'res3', 'llm.example', 'sent', 'ok', 't'),
           ('pcl6', 'bob', 'oauth:bob:tok1', 'res1', 'llm.example', 'sent', 'ok', 't'),
           ('pcl7', 'ghost', 'oauth:ghost:tok2', 'res3', 'llm.example', 'sent', 'ok', 't');
    ${[
      `('n1', 'sp-a', 'write', 'N1', 't1', 'trusted', 'origin', 'user:alice', NULL, 'user-doc', '[]')`,
      `('n1', 'sp-a', 'write', 'N1', 't2', 'trusted', 'change', 'pat:alice:pat1', 'alice', 'user-doc', '[]')`,
      `('n2', 'sp-a', 'write', 'N2', 't3', 'trusted', 'origin', 'ui', '@system', 'user-doc', '[]')`,
      `('n3', 'sp-a', 'write', 'N3', 't4', 'trusted', 'origin', 'user:ghost', 'ghost', 'user-doc', '[]')`,
      `('n4', 'sp-a', 'external', 'N4', 't5', 'trusted', 'baseline', NULL, NULL, 'user-doc', '[]')`,
      `('n5', 'sp-a', 'write', 'N5', 't6', 'trusted', 'origin', 'pat:alice', NULL, 'user-doc', '[]')`,
      `('n6', 'sp-a', 'write', 'N6', 't7', 'trusted', 'origin', 'oauth:bob:tok:with:colons', 'bob', 'user-doc', '[]')`,
      `('n7', 'sp-a', 'write', 'N7', 't8', 'trusted', 'origin', 'pat:ghost:pat2', 'ghost', 'user-doc', '[]')`,
      `('n8', 'sp-a', 'write', 'N8', 't9', 'trusted', 'origin', 'oauth:ghost:tok2', 'ghost', 'user-doc', '[]')`,
    ]
      // One statement per row on purpose: a single multi-row INSERT defers every AFTER
      // ROW trigger to the end of the statement on PostgreSQL, and the projection would
      // initialize itself straight into `rebuilding` — the very state the carrier is
      // supposed to be the one to cause.
      .map(
        (row) => `INSERT INTO note_revisions
      (note_id, space, kind, title, created_at, integrity, entry_role, principal, agent_owner, class, tags)
    VALUES ${row};`,
      )
      .join('\n    ')}
    INSERT INTO jobs (id, space, kind, principal, run_at, created_at, updated_at)
    VALUES ('job1', 'sp-a', 'export', 'user:bob', 't', 't', 't'),
           ('job2', 'sp-a', 'export', 'ui', 't', 't', 't'),
           ('job3', 'sp-a', 'export', 'user:ghost', 't', 't', 't'),
           ('job4', 'sp-a', 'export', 'pat:alice:pat1', 't', 't', 't'),
           ('job5', 'sp-a', 'export', 'pat:ghost:pat2', 't', 't', 't'),
           ('job6', 'sp-a', 'export', 'oauth:bob:tok1', 't', 't', 't'),
           ('job7', 'sp-a', 'export', 'oauth:ghost:tok2', 't', 't', 't');
    INSERT INTO favorites (owner, space, kind, entity_id, created_at)
    VALUES ('user:alice', 'sp-a', 'note', 'n1', 't'),
           ('pat:bob:k1', 'sp-a', 'note', 'n1', 't'),
           ('user:ghost', 'sp-a', 'note', 'n1', 't'),
           ('pat:ghost:k1', 'sp-a', 'note', 'n1', 't'),
           ('oauth:bob:t1', 'sp-a', 'note', 'n1', 't'),
           ('oauth:ghost:t1', 'sp-a', 'note', 'n1', 't'),
           ('ui', 'sp-a', 'note', 'n1', 't');
    INSERT INTO restore_operations
      (id, space, note_id, endpoint, actor_digest, idempotency_digest, request_fingerprint, stage_binding,
       phase, prepared_evidence, created_at, updated_at)
    VALUES ('r1', 'sp-a', 'n1', 'restore', 'd1', 'i1', 'f', 'b', 'prepared', '{"principalId":"user:alice","k":1}', 't', 't'),
           ('r2', 'sp-a', 'n2', 'restore', 'd2', 'i2', 'f', 'b', 'prepared', '{"principalId":"user:ghost"}', 't', 't'),
           ('r3', 'sp-a', 'n3', 'restore', 'd3', 'i3', 'f', 'b', 'staged', NULL, 't', 't'),
           ('r4', 'sp-a', 'n4', 'restore', 'd4', 'i4', 'f', 'b', 'prepared',
            '{"principalId":"pat:bob:key:with:colons"}', 't', 't'),
           ('r5', 'sp-a', 'n5', 'restore', 'd5', 'i5', 'f', 'b', 'prepared',
            '{"principalId":"pat:ghost:key:with:colons"}', 't', 't'),
           ('r6', 'sp-a', 'n6', 'restore', 'd6', 'i6', 'f', 'b', 'prepared',
            '{"principalId":"oauth:alice:tok1"}', 't', 't'),
           ('r7', 'sp-a', 'n7', 'restore', 'd7', 'i7', 'f', 'b', 'prepared',
            '{"principalId":"oauth:ghost:tok2"}', 't', 't');
    INSERT INTO ability_create_operations
      (id, actor_digest, request_fingerprint, space, package_id, note_id, target_path, availability_required,
       stage_binding, phase, prepared_evidence, created_at, updated_at)
    VALUES ('a1', 'd', 'f', 'sp-a', 'pkg1', 'reg1', 'x/SKILL.md', ${bool(false)}, 'b', 'accepted',
            '{"attribution":{"principal":"pat:alice:pat1"},"principalId":"user:alice"}', 't', 't'),
           ('a2', 'd2', 'f', 'sp-a', 'pkg2', 'reg2', 'y/SKILL.md', ${bool(false)}, 'b', 'accepted',
            '{"attribution":{"principal":"oauth:bob:tok:with:colons"}}', 't', 't'),
           ('a3', 'd3', 'f', 'sp-a', 'pkg3', 'reg3', 'z/SKILL.md', ${bool(false)}, 'b', 'accepted',
            '{"attribution":{"principal":"user:alice"}}', 't', 't'),
           ('a4', 'd4', 'f', 'sp-a', 'pkg4', 'reg4', 'q/SKILL.md', ${bool(false)}, 'b', 'accepted',
            '{"attribution":{"principal":"user:ghost"}}', 't', 't'),
           ('a5', 'd5', 'f', 'sp-a', 'pkg5', 'reg5', 'w/SKILL.md', ${bool(false)}, 'b', 'accepted',
            '{"attribution":{"principal":"pat:ghost:pat2"}}', 't', 't'),
           ('a6', 'd6', 'f', 'sp-a', 'pkg6', 'reg6', 'v/SKILL.md', ${bool(false)}, 'b', 'accepted',
            '{"attribution":{"principal":"oauth:ghost:tok2"}}', 't', 't');
    INSERT INTO mcp_dedup (scope, key, note_id, version_token, created_at)
    VALUES ('idem:user:alice:create', 'k', 'n1', 'v', 't');
    INSERT INTO backup_generation_freeze
      (singleton, owner, generation, key_id, active_hash, acquired_at, heartbeat_at, expires_at)
    VALUES (1, 'alice', 1, 'ck_key', 'hash', 't', 't', 'u');
  `
}

export type LadderReader = {
  one(sql: string): Promise<unknown>
  all(sql: string): Promise<unknown[]>
}

const parsedJson = (value: unknown): unknown => (value == null ? null : JSON.parse(String(value)))

/** The columns the rebuild of `users` — the only table the carrier rebuilds — copies
 *  over untouched, read in a stable order. The ladder tests take this snapshot before
 *  the carrier and compare it against the same snapshot after, so a column dropped from
 *  the INSERT…SELECT, transposed with its neighbour or replaced by a column default is
 *  a diff rather than a green run: `id` and `email` are the only two the carrier is
 *  allowed to introduce, and they are asserted separately. */
export const usersCarriedColumnsSql =
  'SELECT username, display_name, password_hash, admin, disabled_at, created_at,' +
  ' personal_space FROM users ORDER BY username'

/** The Activity projection state of the seeded space. The carrier is supposed to trip
 *  the invalidation of group D, which proves nothing unless the seed left the projection
 *  built — hence both dialects assert `ready` before the ladder runs and `rebuilding`
 *  after it, and hence the seed inserts revisions one statement at a time. */
export const expectActivityProjectionState = async (
  read: LadderReader,
  state: 'ready' | 'rebuilding',
): Promise<void> => {
  expect(
    await read.one("SELECT state FROM activity_projection_status WHERE space = 'sp-a'"),
  ).toEqual({ state })
}

type CompositeProbe = {
  /** One row per stored value, aliased `value`, in a stable order. */
  readonly select: string
  /** The principal the carrier must have left at the registry's path, in that order. */
  readonly expected: (ids: { alice: string; bob: string }) => unknown[]
}

/** Every composite carrier of the registry, with the selection that reads its principal
 *  back out after the carrier. Schema introspection is blind to this class — the value
 *  is a string or a JSON document, not a column named like a carrier — so the registry
 *  is the only list of it, and a fourth entry added there without a probe here turns the
 *  key comparison below red before a single value is read. The path is taken from the
 *  registry rather than repeated, so a probe cannot silently read a different one. */
const COMPOSITE_PROBES: Record<string, CompositeProbe> = {
  // Not rewritten but emptied: the scope interpolates the principal into an idempotency
  // key with a one-day TTL, and an empty table is honest where half of one would not be.
  'mcp_dedup.scope': {
    select: 'SELECT scope AS value FROM mcp_dedup ORDER BY scope',
    expected: () => [],
  },
  'restore_operations.prepared_evidence': {
    select: 'SELECT prepared_evidence AS value FROM restore_operations ORDER BY id',
    expected: ({ alice, bob }) => [
      `user:${alice}`,
      'user:ghost',
      null,
      `pat:${bob}:key:with:colons`,
      'pat:ghost:key:with:colons',
      `oauth:${alice}:tok1`,
      'oauth:ghost:tok2',
    ],
  },
  'ability_create_operations.prepared_evidence': {
    select: 'SELECT prepared_evidence AS value FROM ability_create_operations ORDER BY id',
    expected: ({ alice, bob }) => [
      `pat:${alice}:pat1`,
      `oauth:${bob}:tok:with:colons`,
      `user:${alice}`,
      'user:ghost',
      'pat:ghost:pat2',
      'oauth:ghost:tok2',
    ],
  },
}

const atPath = (document: unknown, path: readonly string[]): unknown =>
  path.reduce<unknown>(
    (node, key) => (node == null ? null : ((node as Record<string, unknown>)[key] ?? null)),
    document,
  )

/** Reads every composite carrier the registry declares, through the registry. */
const expectCompositeCarriers = async (
  read: LadderReader,
  ids: { alice: string; bob: string },
): Promise<void> => {
  expect(Object.keys(COMPOSITE_PROBES).sort()).toEqual(
    ACCOUNT_IDENTITY_CARRIERS.composite.map(({ column }) => column).sort(),
  )

  for (const carrier of ACCOUNT_IDENTITY_CARRIERS.composite) {
    const probe = COMPOSITE_PROBES[carrier.column]
    const rows = (await read.all(probe.select)) as Array<{ value: string | null }>
    const principals = rows.map(({ value }) =>
      'path' in carrier ? atPath(parsedJson(value), carrier.path) : value,
    )

    expect(principals, carrier.column).toEqual(probe.expected(ids))
  }
}

/** What the seeded world must look like after the carrier, given the minted ids. */
export const expectAccountIdentityWorld = async (
  read: LadderReader,
  { alice, bob }: { alice: string; bob: string },
): Promise<void> => {
  expect(await read.all('SELECT id_hash, user_id FROM sessions ORDER BY id_hash')).toEqual([
    { id_hash: 's1', user_id: alice },
    { id_hash: 's2', user_id: 'ghost' },
  ])
  expect(await read.all('SELECT id, user_id FROM pats ORDER BY id')).toEqual([
    { id: 'pat1', user_id: alice },
    { id: 'pat2', user_id: 'ghost' },
  ])
  expect(
    await read.all("SELECT user_id, role FROM space_members WHERE space = 'sp-a' ORDER BY role"),
  ).toEqual([
    { user_id: alice, role: 'owner' },
    { user_id: 'ghost', role: 'reader' },
  ])
  expect(await read.all('SELECT id_hash, user_id FROM one_time_tokens ORDER BY id_hash')).toEqual([
    { id_hash: 'o1', user_id: alice },
    { id_hash: 'o2', user_id: 'ghost' },
  ])
  expect(
    await read.all('SELECT code_hash, user_id FROM oauth_auth_codes ORDER BY code_hash'),
  ).toEqual([
    { code_hash: 'c1', user_id: bob },
    { code_hash: 'c2', user_id: 'ghost' },
  ])
  expect(await read.all('SELECT id, user_id FROM oauth_access_tokens ORDER BY id')).toEqual([
    { id: 'tok1', user_id: bob },
    { id: 'tok2', user_id: 'ghost' },
  ])
  expect(await read.all('SELECT id, user_id FROM oauth_refresh_tokens ORDER BY id')).toEqual([
    { id: 'ref1', user_id: bob },
    { id: 'ref2', user_id: 'ghost' },
  ])
  expect(await read.all('SELECT id, owner FROM agent_sessions ORDER BY id')).toEqual([
    { id: 'ses_1', owner: alice },
    { id: 'ses_2', owner: '@system' },
    { id: 'ses_3', owner: 'ghost' },
  ])
  expect(
    await read.all('SELECT owner, principal FROM agent_retrievals ORDER BY created_at'),
  ).toEqual([
    { owner: alice, principal: `pat:${alice}:pat1` },
    { owner: '@system', principal: 'ui' },
    { owner: 'ghost', principal: 'user:ghost' },
    { owner: alice, principal: `user:${alice}` },
    { owner: 'ghost', principal: 'pat:ghost:pat2' },
    { owner: alice, principal: `oauth:${alice}:tok1` },
    { owner: 'ghost', principal: 'oauth:ghost:tok2' },
  ])
  expect(await read.all('SELECT id, owner, principal FROM agent_calls ORDER BY id')).toEqual([
    { id: 'call1', owner: bob, principal: `oauth:${bob}:tok1` },
    { id: 'call2', owner: '@system', principal: 'ui' },
    { id: 'call3', owner: 'ghost', principal: 'user:ghost' },
    { id: 'call4', owner: bob, principal: `user:${bob}` },
    { id: 'call5', owner: alice, principal: `pat:${alice}:pat1` },
    { id: 'call6', owner: 'ghost', principal: 'pat:ghost:pat2' },
    { id: 'call7', owner: 'ghost', principal: 'oauth:ghost:tok2' },
  ])
  expect(
    await read.all(
      'SELECT owner, session_id FROM agent_session_cleanup_markers ORDER BY session_id',
    ),
  ).toEqual([
    { owner: alice, session_id: 'ses_1' },
    { owner: '@system', session_id: 'ses_2' },
    { owner: 'ghost', session_id: 'ses_3' },
  ])
  expect(
    await read.all('SELECT owner, last_rev FROM mcp_delta_owner_cursors ORDER BY last_rev'),
  ).toEqual([
    { owner: alice, last_rev: '1' },
    { owner: '@system', last_rev: '2' },
    { owner: 'ghost', last_rev: '3' },
  ])
  expect(
    ((await read.all('SELECT owner FROM ability_preferences')) as Array<{ owner: string }>)
      .map(({ owner }) => owner)
      .sort(),
  ).toEqual([alice, '@system', 'ghost'].sort())
  expect(await read.all('SELECT id, owner FROM credentials ORDER BY id')).toEqual([
    { id: 'cred1', owner: alice },
    { id: 'cred2', owner: 'ghost' },
    { id: 'cred3', owner: '@system' },
  ])
  expect(await read.all('SELECT id, owner FROM provider_resources ORDER BY id')).toEqual([
    { id: 'res1', owner: alice },
    { id: 'res2', owner: '@system' },
    { id: 'res3', owner: 'ghost' },
  ])
  expect(await read.all('SELECT id, owner, principal FROM provider_call_log ORDER BY id')).toEqual([
    { id: 'pcl1', owner: alice, principal: `user:${alice}` },
    { id: 'pcl2', owner: '@system', principal: 'ui' },
    { id: 'pcl3', owner: 'ghost', principal: 'user:ghost' },
    { id: 'pcl4', owner: alice, principal: `pat:${alice}:pat1` },
    { id: 'pcl5', owner: 'ghost', principal: 'pat:ghost:pat2' },
    { id: 'pcl6', owner: bob, principal: `oauth:${bob}:tok1` },
    { id: 'pcl7', owner: 'ghost', principal: 'oauth:ghost:tok2' },
  ])
  expect(
    await read.all('SELECT note_id, principal, agent_owner FROM note_revisions ORDER BY id'),
  ).toEqual([
    { note_id: 'n1', principal: `user:${alice}`, agent_owner: null },
    { note_id: 'n1', principal: `pat:${alice}:pat1`, agent_owner: alice },
    { note_id: 'n2', principal: 'ui', agent_owner: '@system' },
    { note_id: 'n3', principal: 'user:ghost', agent_owner: 'ghost' },
    { note_id: 'n4', principal: null, agent_owner: null },
    { note_id: 'n5', principal: 'pat:alice', agent_owner: null },
    { note_id: 'n6', principal: `oauth:${bob}:tok:with:colons`, agent_owner: bob },
    { note_id: 'n7', principal: 'pat:ghost:pat2', agent_owner: 'ghost' },
    { note_id: 'n8', principal: 'oauth:ghost:tok2', agent_owner: 'ghost' },
  ])
  expect(await read.all('SELECT id, principal FROM jobs ORDER BY id')).toEqual([
    { id: 'job1', principal: `user:${bob}` },
    { id: 'job2', principal: 'ui' },
    { id: 'job3', principal: 'user:ghost' },
    { id: 'job4', principal: `pat:${alice}:pat1` },
    { id: 'job5', principal: 'pat:ghost:pat2' },
    { id: 'job6', principal: `oauth:${bob}:tok1` },
    { id: 'job7', principal: 'oauth:ghost:tok2' },
  ])
  expect(
    ((await read.all('SELECT owner FROM favorites')) as Array<{ owner: string }>)
      .map(({ owner }) => owner)
      .sort(),
  ).toEqual(
    [
      `user:${alice}`,
      `pat:${bob}:k1`,
      'user:ghost',
      'pat:ghost:k1',
      `oauth:${bob}:t1`,
      'oauth:ghost:t1',
      'ui',
    ].sort(),
  )
  expect(
    await read.all('SELECT id, archived_by FROM spaces WHERE archived_by IS NOT NULL ORDER BY id'),
  ).toEqual([
    { id: 'sp-a', archived_by: `user:${alice}` },
    { id: 'sp-b', archived_by: `pat:${bob}:key:with:colons` },
    { id: 'sp-c', archived_by: 'pat:ghost:key:with:colons' },
    { id: 'sp-d', archived_by: `oauth:${alice}:tok1` },
    { id: 'sp-e', archived_by: 'oauth:ghost:tok2' },
    { id: 'sp-ghost', archived_by: 'user:ghost' },
    { id: 'sp-ui', archived_by: 'ui' },
  ])
  expect(
    await read.all(
      'SELECT space, changed_by FROM space_lifecycle' +
        " WHERE space IN ('sp-a', 'sp-b', 'sp-c', 'sp-d', 'sp-e', 'sp-ghost', 'sp-ui')" +
        ' ORDER BY space',
    ),
  ).toEqual([
    { space: 'sp-a', changed_by: `oauth:${alice}:tok1` },
    { space: 'sp-b', changed_by: 'ui' },
    { space: 'sp-c', changed_by: `user:${bob}` },
    { space: 'sp-d', changed_by: `pat:${alice}:pat1` },
    { space: 'sp-e', changed_by: 'pat:ghost:pat2' },
    { space: 'sp-ghost', changed_by: 'user:ghost' },
    { space: 'sp-ui', changed_by: 'oauth:ghost:tok2' },
  ])
  const restores = (await read.all(
    'SELECT id, prepared_evidence FROM restore_operations ORDER BY id',
  )) as Array<{ id: string; prepared_evidence: string | null }>
  expect(
    restores.map((row) => ({ id: row.id, evidence: parsedJson(row.prepared_evidence) })),
  ).toEqual([
    { id: 'r1', evidence: { principalId: `user:${alice}`, k: 1 } },
    { id: 'r2', evidence: { principalId: 'user:ghost' } },
    { id: 'r3', evidence: null },
    // The tail may itself contain colons, and it is carried over whole.
    { id: 'r4', evidence: { principalId: `pat:${bob}:key:with:colons` } },
    // An orphan is left byte-for-byte in every scheme, not just in `user:`.
    { id: 'r5', evidence: { principalId: 'pat:ghost:key:with:colons' } },
    { id: 'r6', evidence: { principalId: `oauth:${alice}:tok1` } },
    { id: 'r7', evidence: { principalId: 'oauth:ghost:tok2' } },
  ])
  const creates = (await read.all(
    'SELECT id, prepared_evidence FROM ability_create_operations ORDER BY id',
  )) as Array<{ id: string; prepared_evidence: string }>
  // The nested path moves; the same-named top-level key is a decoy and must not.
  expect(
    creates.map((row) => ({ id: row.id, evidence: parsedJson(row.prepared_evidence) })),
  ).toEqual([
    {
      id: 'a1',
      evidence: { attribution: { principal: `pat:${alice}:pat1` }, principalId: 'user:alice' },
    },
    { id: 'a2', evidence: { attribution: { principal: `oauth:${bob}:tok:with:colons` } } },
    { id: 'a3', evidence: { attribution: { principal: `user:${alice}` } } },
    // The orphan of each scheme is what makes a lost resolvability condition visible
    // here: this column is NOT NULL, so json_set on an unresolved name would either
    // write a JSON null over the attribution or abort the ladder outright.
    { id: 'a4', evidence: { attribution: { principal: 'user:ghost' } } },
    { id: 'a5', evidence: { attribution: { principal: 'pat:ghost:pat2' } } },
    { id: 'a6', evidence: { attribution: { principal: 'oauth:ghost:tok2' } } },
  ])
  // Beside the hard-wired documents above, the same three carriers are read once more
  // through the registry: that branch is what guards the fourth one nobody has written
  // an expectation for yet.
  await expectCompositeCarriers(read, { alice, bob })
  expect(await read.one('SELECT owner FROM backup_generation_freeze')).toEqual({ owner: 'alice' })
  expect(
    await read.all(
      "SELECT username, personal_space FROM users WHERE username LIKE 'p_' ORDER BY username",
    ),
  ).toEqual(
    NON_ACTIVE_PHASES.map((_, index) => ({
      username: `p${index + 1}`,
      personal_space: `sp-p${index + 1}`,
    })),
  )
}

/** Every column of the schema whose name can carry a user reference, as the registry
 *  accounts for it — the set the ladder tests compare a live schema against. */
export const accountIdentityRegistry = (): string[] =>
  [
    ...ACCOUNT_IDENTITY_CARRIERS.userId,
    ...ACCOUNT_IDENTITY_CARRIERS.owner,
    ...ACCOUNT_IDENTITY_CARRIERS.principal,
    ...ACCOUNT_IDENTITY_CARRIERS.excluded,
    'users.username',
  ].sort()
