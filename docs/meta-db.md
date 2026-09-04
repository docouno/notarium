# Meta-DB schema migrations

The meta-DB contains state that cannot be reconstructed from Markdown alone:
stable identities, revision history and blobs, accounts and credentials,
memberships, durable jobs, OAuth state, agent episodes and cursors, ability
policy, import claims, and causal recovery evidence. SQLite and PostgreSQL share
one forward-only, checksummed schema history. The derived per-space index has a
different recovery contract and keeps its own migrations.

## Source of truth <a id="source-of-truth"></a>

Migration assets live under
`packages/server/src/services/metaDb/migrations/`:

```text
manifest.json
sqlite/0000_baseline.sql
sqlite/0001_revision_history.sql
sqlite/0002_agent_state.sql
sqlite/0003_causal_identity.sql
sqlite/0004_import_reservations.sql
sqlite/0005_provider_contour.sql
sqlite/0006_agent_call_trace.sql
sqlite/0007_activity_projection.sql
sqlite/0008_account_identity.sql
postgres/0000_baseline.sql
postgres/0001_revision_history.sql
postgres/0002_agent_state.sql
postgres/0003_causal_identity.sql
postgres/0004_import_reservations.sql
postgres/0005_provider_contour.sql
postgres/0006_agent_call_trace.sql
postgres/0007_activity_projection.sql
postgres/0008_account_identity.sql
```

`0000_baseline` is the published `v0.1.0` support floor. Its bytes and pair
checksum are immutable. The eight later carriers are the supported transition
from that baseline to the current schema; development-only predecessor ladders
are not accepted prefixes.

Every entry has one contiguous integer version, one snake-case name, one
SQLite/PostgreSQL file pair, and one checksum over the exact pair:

```text
"sqlite\0" + sqlite bytes + "\0postgres\0" + postgres bytes
```

The loader rejects missing or extra dialect files, gaps or reorderings, invalid
names, empty assets, unsupported manifest formats, and checksum drift. The
production build copies the manifest and both SQL directories beside the server
bundles; release and backup smoke verify those runtime assets.

## Current ladder

### `0001_revision_history`

This carrier upgrades the published journal directly to its final row and
protocol:

- SQLite rebuilds `note_revisions` once while preserving ids, causal links, and
  the next AUTOINCREMENT id. PostgreSQL adds and backfills the same columns and
  converts `revision_blobs.content` from `TEXT` to `BYTEA`.
- `integrity` and `entry_role` are mandatory checked fields with no defaults.
  Baseline rows become `trusted`; the first parentless row in each
  `(space,note_id)` is `baseline` for an external sighting and `origin`
  otherwise; all remaining rows are `change`.
- `state_format` is the only format column. It is nullable for a baseline
  body-only row or an honest gap, and otherwise accepts `markdown-v1`,
  `markdown-v2`, `skill-markdown-v1`, or `opaque-v1`.
- Revision attribution, semantic fingerprint, restore safety, heads, append and
  purge fences, activity indexes, and the trusted-head trigger are installed in
  their final form.
- A legacy note purge fence remains global with `space=''`; every new note fence
  is scoped. PostgreSQL destructive writers must set the semantic protocol token
  `space-scoped-cas-v1`. The published baseline token `v26` fails closed.

Baseline blob hashes and bodies are retained byte-for-byte. A nullable
`state_format` is data compatibility, not permission for an old process to keep
writing the upgraded schema.

### `0002_agent_state`

This carrier creates durable agent and ability state in final form:

- `agent_sessions` stores public role name, exact `role_locator`, the project in
  which that role was selected, and a separate sticky `project_id` used for
  by-name resolution.
- `agent_retrievals` and `note_revisions` carry optional episode attribution;
  owner/session Activity indexes are final from the first target schema.
- `mcp_delta_owner_cursors` and `mcp_delta_session_cursors` bind to the shared
  project/folder registry with a type-aware foreign key and retype cleanup.
- Baseline `mcp_bookmarks` are parsed conservatively: `ui`, PAT, and OAuth actor
  keys map to owners; a legacy scope may resolve by exact project id, root-space
  id, current slug, or retired alias. Only exactly one project is accepted, and
  the greatest revision per owner/project survives. Unknown or ambiguous rows
  are not guessed. The legacy table is then dropped and has no runtime reader or
  purge path.
- Ability availability, project bindings, sparse owner preferences, placement
  trail, and durable create operations are created directly in current shape.
  Every placement hop requires both `registry_note_id` and
  `manifest_note_id`; no identity-less row exists. Rejected create history does
  not own the success replay key.

An absent availability row has kind-specific meaning: a Space Skill is
unavailable until stated, while a Space Role retains its historical
all-projects default. Availability and preferences carry the stable Space and
registry-note lifecycle keys needed by permanent purge. The package directory
id is not a substitute for the registry note because claim arbitration can make
them differ.

### `0003_causal_identity`

This carrier installs the current identity and recovery model:

- address revisions, legacy name aliases, settlement lineage, and the partial
  unique live `(space,file_path)` identity index;
- receipt-backed owner proofs, restore operations, authoritative space
  lifecycle, causal outbox and deliveries;
- installation generation and the bounded backup-generation freeze;
- `context_set_attachments.home_space` with a one-time baseline backfill;
- lifecycle triggers for every Space-owned producer.

The revision lifecycle trigger is created once in final form. It rejects new
work after a Space leaves `active`, except the exact terminal revision of an
already admitted `physical-published` restore or ability-create operation.
Fresh operation admission remains active-only; archived state has no writer
escape hatch.

Strict restore completion is one persistence transaction. It binds prepared
evidence and physical receipt to the current head, address revision, owner
proof, and lifecycle; appends the restore revision/blob; updates identity and
proof; stores the terminal result; and appends the outbox event. Replay returns
that stored result without a second revision or event.

The causal outbox is a projection-repair queue, not a payload transport. A
replica rereads committed file and metadata truth before acknowledging. Startup
drains it after lifecycle recovery and before public admission; runtime delivery
is at least once.

### `0004_import_reservations`

The import carrier creates the final path-claim pair:

- one header per `(space,upload_ref)` with job, lease fence, and active/closing
  status;
- one row per archive member with a unique `(space,destination_path)` claim;
- a cascading path-to-header foreign key and the indexes used by whole-batch and
  single-destination reads.

The claim owns a path, not an identity. Target and expected ids describe the
frozen import plan; the plan remains the authority. There is deliberately no
“bytes landed” flag because publication and such a flag cannot be atomic across
the filesystem/database boundary. See [import.md](import.md#who-owns-a-destination-while-the-import-runs).

### `0005_provider_contour`

One carrier for one subsystem: the master-key witness, the registry a call is
addressed by, and the journal it is recorded in. They are not three carriers
because no supported deployment has ever had a subset of them.

- `secret_keyring` records the canary and generation witness of each credential
  master key. Key files and the active pointer stay filesystem state; `state` is
  only that pointer's projection. A key is admitted `readable`, the pointer is
  published, then the row becomes `active` — the prepublication witness is what
  separates crash recovery from restoring an older database beside a descendant
  keyring, without a phase or candidate column.
- `credentials` and `provider_resources` are owner state; `provider_attachments`
  binds a resource to a Space. Credential secrets and resource header values are
  reversible envelopes and the database stores no plaintext copy. The resource
  `models` JSON holds exact authored names/capabilities plus system-owned dimensions
  and capability-scoped status; there is no resource-level `purposes` column.
- A resource may omit its credential, but a present reference is
  `ON DELETE RESTRICT`; deleting a resource cascades its attachments.
  `target_space` stays a plain, non-null indexed column, because a foreign key to
  `spaces` would take an implicit parent lock from below the ladder — the explicit
  lifecycle fence prevents a late offer and `purgeSpace` deletes the rows itself.
- `provider_call_log` holds one row per request the executor was allowed to send,
  written in two phases: the intent commits before the transport may send and the
  outcome closes the same row. It has no foreign key at all — `resource_id` and
  `credential_id` are historical snapshots, where a `RESTRICT` would make a
  credential delete a lie and a `CASCADE` would erase the evidence.

Credentials and resources survive a Space purge because they are owner state, and
so does the journal: whether a Space's content left through some resource is a
question asked after the Space is gone. A resource mutation replaces a row only at
the `runtime_epoch` the caller read, so two call configurations cannot commit under
one epoch, and a credential mutation serializes at its own epoch — call-affecting
fields bump it and reset every referencing resource's `last_check` in the same
credential→resource transaction, while origin and injection also bump the separate
consent epoch. A `validate` outcome is written the same way rather than by a short
`UPDATE`, since `last_check` is a per-capability collection and model measurements
are field deltas merged into the transaction-current row. Its condition spans both
the resource epoch and the referenced
credential's, because a secret rotation moves no resource field yet must invalidate
a check in flight. Complete keyring-loss recovery is one transaction over both
ciphertext carriers and rolls the whole change back rather than landing half of it.

Providers were not present in the published `v0.1.0` baseline. The corrected
`0005_provider_contour` is therefore the only supported `v0.1.0 → current` carrier;
there is no `0006` compatibility migration. A development database that applied an
older `0005` checksum is refused and must be reset.

The journal carries no prompt or response column: it is an audit of who called
what, not a second store of user content. `delivery_state` is three-valued — the
transport can only say whether bytes could have left, while `sent` is the
executor's stronger fact that the provider answered — and `retry_safe` is explicit
rather than derived from a status code. `UNIQUE (job_id, job_call_key, attempt_no)`
is the durable send-fence and the index a job re-claim reads its latest attempt by;
all three are null for an interactive call and nulls are distinct, so those rows
never collide. Spend lives on the event with the source that reported it, absent
counters mean unknown rather than zero, and no total is stored anywhere — the
rollup is summed from the rows.

### `0006_agent_call_trace`

The agent observability carrier adds terminal `agent_calls`, optional expiring
`agent_call_details`, transport-neutral `agent_call_id` links on retrievals and revisions, one
host-global CAS-versioned telemetry configuration row, and durable owner/session cleanup markers.
The marker reason is monotone: `human-delete` dominates `retention`.

Compact calls are the primary Activity event. Linked retrieval/revision rows enrich that call and
never re-enter the legacy top-level fallback. Human deletion removes session diagnostics while
leaving revision rows and note state untouched; automatic retention removes only linked new-data
diagnostics, so historical unlinked audit remains honestly partial.

The marker is also a read fence: call detail, unexpired Detail, linked rows, compatibility
retrieval audit and recurring diagnostics cannot expose a logically removed episode while a 202
cleanup is still physical. PostgreSQL cleanup reads the current reason only after taking the
owner/session advisory guard and clears `cleanup_pending` with a same-reason predicate, so a stale
retention worker cannot complete a later human deletion. Retrieval, agent and recurring-problem
aggregates probe owner markers inside the same read snapshot as their complete result: the ordinary
no-marker path uses covering partial indexes, while the guarded path retains the per-session
anti-join. Retrieval top/miss groups share one materialized grouping inside that snapshot. Separate
partial indexes keep legacy unlinked agent rows out of wide retrieval/revision scans, so adding
Compact calls does not restore the pre-RC Activity aggregate regression.

Retention candidates come from indexed `agent_sessions.last_seen_at`; terminal writes advance that
timestamp unless the call is one of the explicit attribution-without-touch reads. A partial index
proves the episode-opening `new|forked` start, and Outside expiry has its own expression index. The
background worker accepts one session batch on the 60-second discovery tick. A pending marker then
continues after one-second event-loop yields, one fixed batch per turn, until physical cleanup is
complete. It never performs a grouped whole-`agent_calls` scan, a multi-session SQLite cleanup
transaction, or an hours-long interval-only cleanup on request traffic.
### `0007_activity_projection`

The Activity carrier is O(schema): it creates empty status, commit-order,
cumulative-state, bucket-head and generation-GC tables plus database triggers. It
does not enumerate journal rows, discover Spaces or create status rows. The first
prepare/append initializes exactly one Space. Existing history freezes an indexed
legacy revision boundary and rebuilds; an empty or genuinely fresh Space is ready.

Every post-carrier revision, including a baseline or gap, receives one per-Space
`source_ordinal` in the journal transaction. PostgreSQL serializes only this trigger
tail on the status row, so a lower raw id committed later receives a higher source
ordinal. A ready qualifying append also writes an immutable cumulative actor/class
state and advances its bounded head. The same trigger covers ordinary append,
restore/ability terminal writers, prepared INSERT and COPY; no application helper
writes the projection.

Rebuild consumes legacy rows then the order ledger in bounded set-oriented batches.
For file-backed SQLite, one narrow Activity worker owns a second WAL connection and
executes the scheduler-permitted rebuild/GC unit; the safe interactive source batch is
ten rows, GC deletes ten rows per unit, and WAL checkpoints stay off the main event
loop. The same worker serves unbounded standing Activity reads. It is not a generic SQL executor: bounded reads,
scheduler priority, readiness and route composition stay in the main process.
In-memory SQLite uses the local reference path; PostgreSQL remains async in-process.
The Node worker lifecycle, IPC DTO and connection/checkpoint adapter are deliberately
disposable once the canonical Go `ActivityReader` owns this path; source ordering,
generation/lease semantics and cross-language fixtures remain the cutover contract.

PostgreSQL progress uses ten-row batches but does not hold the status-row allocator
lock while deriving/inserting cumulative states. It reads one generation/cursor
snapshot, performs the batch, then conditionally advances that exact generation's
cursor; concurrent append can allocate and commit a later source ordinal meanwhile.
The turn does hold the shared revision-Space lifecycle fence, which is compatible
with append but exclusive against Space purge: a batch committed before purge is
swept by it, while a turn admitted after purge sees the durable fence and cannot
recreate projection metadata.
Initialization and final publication still take the status row, and publication still
enters the exclusive revision-Space fence before the final source recheck.

Final catch-up and pointer publication run under `BEGIN IMMEDIATE` (SQLite) or the
exclusive revision-Space advisory fence (PostgreSQL). Publication and source restart
only enqueue inert generations. Scheduler-paced GC deletes bounded state then head
batches and is crash-resumable; it never runs an unbounded delete in the publication
transaction. Rekey, quarantine, origin demotion and permanent note purge invalidate
the source generation fail-closed. A committed revision's Space is immutable in both
dialects; a cross-Space update is rejected atomically before the journal, source order
or projection status can diverge. PostgreSQL Space purge removes the generation-GC
queue before states/heads, matching the GC transaction's row order and preventing a
queue↔state deadlock. Space purge explicitly removes every projection, order and GC
row before deleting journal truth.

### `0008_account_identity`

The account carrier gives every user a stable opaque id and moves each carrier
that keyed a row by username onto it, so a handle becomes a mutable attribute:

- `users` is the only table rebuilt: `id TEXT PRIMARY KEY` (16 lowercase hex,
  minted once — by `lower(hex(randomblob(8)))` on SQLite and
  `gen_random_uuid()` on PostgreSQL for existing rows, by the server for new
  ones), `username` becomes `NOT NULL UNIQUE`, and the optional `email` arrives
  `UNIQUE` on the same table. That `UNIQUE` compares bytes: the address is
  lower-cased on the way in by `EmailSchema`, the one normalizer every writer
  goes through, not by the column. Its two lifecycle triggers
  are recreated after repopulation, because the `BEFORE INSERT` gate would
  refuse a user bound to a non-active personal space and abort the ladder.
- Seven username-keyed columns (`sessions`, `pats`, `space_members`,
  `one_time_tokens`, `oauth_auth_codes`, `oauth_access_tokens`,
  `oauth_refresh_tokens`) are renamed in place to `user_id` and backfilled; ten
  owner columns keep their name because they also hold the `@system` literal;
  eight principal-string columns and the two `prepared_evidence` JSON documents
  rewrite the owner segment of `user:` / `pat:` / `oauth:` to the id. A value
  that resolves to no live user, the `ui` and `@system` literals, and an
  agent form without a credential tail stay byte-for-byte. `mcp_dedup` is
  emptied: its scope keys embed the principal string and expire within a day.
- Rewriting `note_revisions.principal` trips the Activity invalidation trigger
  on purpose: every initialized Space rebuilds its projection once, with id
  keys, at the recovery pace documented above. The Activity projection tables
  and `backup_generation_freeze.owner` (a lease token, not a user) are not
  touched, and no foreign key onto `users` is introduced.
- The registry of user-reference columns lives in
  `test/meta-db-contract/metaDbCatalog.ts`; both ladder suites introspect the
  live schema against it, so a future carrier that adds an owner column fails
  until it is listed.

Operationally the carrier is one-way: a backup taken after it does not restore
into an image without it (the ledger refuses an unknown future migration), so
take the backup before the upgrade. PostgreSQL 13 or newer is required from
this carrier on.

## Lock and lifecycle invariants

The normative PostgreSQL order lives in
`packages/server/src/services/metaDb/drivers/pg/lockOrder.ts`. The schema must
not introduce hidden edges that contradict it.

- No foreign key points at `spaces`. `purgeSpace` holds the Space row above the
  folder and ability tiers; a lower-tier insert taking an implicit
  `FOR KEY SHARE` on that row would invert the order. Explicit lifecycle checks
  provide typed refusal and purge deletes the child rows itself.
- A binding may reference `folders`: the parent is ordered above the ability
  child, and the writer already holds those project rows.
- An Owned Role locator is the placement authority. The existing
  `<scope>:<encoded-owner>:<package-id>` context target remains the compatible
  storage/wire projection; one pure adapter owns both directions and Project reverse
  projection requires `target_space`. Placement trail rows are one-hop, primary-key
  lookups bound to registry and manifest identity. Exact record/cancel replay returns
  before pointer DML; contradictory destination or identity evidence fails closed.
- Role attachment, pin, and order writers serialize with placement moves on the
  immutable package key at L2b/L2d/L2e, then resolve the one-hop trail through one
  exact post-lock PK read and write only the live compatible target. The read is a
  separate statement deliberately: under `READ COMMITTED`, a statement that waited
  on the advisory would otherwise keep its pre-wait snapshot. Non-Role writers keep
  their prior statement shape. Ability preferences use the same package invariant at
  L4p. `sessions.setRole` takes the session row first, resolves the stale locator with
  the same fresh exact read, and compares the resolved locator before reporting a
  change; the placement move rewrites the same row, so either commit order converges
  idempotently on the live locator.
- The provider contour follows tier 4, opening with the instance-global
  `secret_keyring` fence and continuing credentials → resources → attachments →
  call journal. Every ciphertext writer enters the keyring fence first, and a
  whole-Space purge enters only the attachment tail. Recovery and rotation scans
  take range locks before reading the carrier inventory, so an insert cannot
  appear behind the scan. The journal tail is the one provider level keyed by
  something other than a row id: two re-claims of one logical job call have no
  row to meet on until one has inserted, so they meet on an advisory over that
  call.
- Import cancellation and reaping enter the same job/header/path fence as a
  claimed write. Heartbeats remain outside so a slow member can renew its lease
  while holding the write fence.
- Revision append and purge share bounded Space, note, and blob lock stripes.
  A successful irreversible purge leaves a compact fence; a late direct SQL
  append is serialized and rejected by the database trigger.
- Session bind/touch/role, retrieval/detail/finalize and cleanup acceptance share one
  owner/session guard. Either the diagnostic writer commits before the marker and cleanup sees it,
  or the marker wins and the writer appends nothing. PostgreSQL uses the same advisory key for all
  participants and re-reads marker reason after acquiring it; SQLite's immediate writer transaction
  provides the equivalent order.

## Database ledger and startup <a id="startup"></a>

Applied history is stored in:

```sql
meta_migrations(
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL
)
```

Startup accepts exactly three states:

1. A genuinely empty database executes `0000_baseline.sql` and writes its ledger
   row in the same transaction.
2. A database whose ledger is an exact manifest prefix validates every version,
   name, and checksum, then applies the pending suffix.
3. A non-empty database without the ledger fails before DDL or application
   queries. Conversion is a version-specific offline operator operation, never a
   heuristic runtime branch.

An empty ledger, a gap, an edited applied migration, a removed development
carrier, and an unknown future row all fail closed. Failed SQL rolls back with
its ledger stamp and the same adapter remains retryable.

SQLite reserves the writer before re-reading and applying the suffix. A fresh
file starts with incremental auto-vacuum and then enters WAL mode. PostgreSQL
uses one transaction under a database-and-schema advisory lock on a dedicated
non-pooled connection. It pins exactly one durable schema before DDL, rejects a
migration that changes the effective `search_path`, and closes that connection
before the application pool is created.

## Adding a migration <a id="adding"></a>

Schema changes are forward-only:

1. Add matching `NNNN_name.sql` files for both dialects at the next manifest
   index.
2. Keep transaction ownership in the runner: assets contain no transaction
   control and no non-transactional DDL such as PostgreSQL
   `CREATE INDEX CONCURRENTLY`.
3. Print the pair checksum:

   ```bash
   npm run meta-migrations:checksum -- 0005_name
   ```

4. Append the manifest entry and run:

   ```bash
   npm run meta-migrations:check
   make test-pg
   ```

5. Add transition, rollback/retry, and relevant writer-protocol regressions.

Prefer expand/contract when application versions must overlap. A destructive
contraction needs an explicit compatibility boundary and a verified backup.
Once a migration ships, its name, checksum, and bytes are immutable. A future
rebaseline is a deliberate support-policy change, not routine cleanup.

## Operations <a id="operations"></a>

Backups, not reverse SQL, are the rollback mechanism. Use the image-native flow
in [backup.md](backup.md). Never stamp a ledger row because tables merely appear
to exist: an operator conversion verifies the exact source catalog, preserves a
tested backup, runs while the application is stopped, and then passes integrity
and application smoke.

The canonical container layout is the unified `/data` root in
[architecture.md](architecture.md#data-root). A legacy layout move is likewise
offline and cannot run beside either application stack.
