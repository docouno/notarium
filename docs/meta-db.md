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
postgres/0000_baseline.sql
postgres/0001_revision_history.sql
postgres/0002_agent_state.sql
postgres/0003_causal_identity.sql
postgres/0004_import_reservations.sql
```

`0000_baseline` is the published `v0.1.0` support floor. Its bytes and pair
checksum are immutable. The four later carriers are the supported transition
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
- Ability preference writes and placement moves serialize on a package key,
  because a range rewrite cannot lock an owner row that does not exist yet.
  Scope-pin moves use the analogous target key.
- Two placement consumers still have no shared arbitration key. A concurrent
  `contextSets.attach` can commit the target id a Role has just left because it
  remains a helper-less autocommit statement; `agent_sessions.role_locator` is
  outside the ladder, so an exact resume with a stale address fails closed. These
  are current concurrency gaps, not compatibility paths in the migration ladder.
- Import cancellation and reaping enter the same job/header/path fence as a
  claimed write. Heartbeats remain outside so a slow member can renew its lease
  while holding the write fence.
- Revision append and purge share bounded Space, note, and blob lock stripes.
  A successful irreversible purge leaves a compact fence; a late direct SQL
  append is serialized and rejected by the database trigger.

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
