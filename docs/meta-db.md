# Meta-DB schema migrations

The meta-DB contains state that cannot be reconstructed from Markdown alone:
stable identities, revision history and blobs, accounts and credentials,
memberships, durable jobs, OAuth state, and user curation. Its SQLite and
PostgreSQL drivers therefore share one forward-only, checksummed schema history.
Durable owner-scoped agent episodes and their delta positions live here too
(`agent_sessions`, including its selected role, `mcp_delta_owner_cursors`,
`mcp_delta_session_cursors`); they
are not reconstructible from note files. Session positions are deleted with the
episode; owner fallbacks survive episode retention and are removed with their
project.
The derived per-space search/index database has a different recovery contract:
it may be discarded and rebuilt, so its migration mechanism is deliberately not
unified with this one.

## Source of truth <a id="source-of-truth"></a>

Migration assets live under
`packages/server/src/services/metaDb/migrations/`:

```text
manifest.json
sqlite/0000_baseline.sql
sqlite/0001_agent_sessions.sql
sqlite/0002_agent_session_role.sql
postgres/0000_baseline.sql
postgres/0001_agent_sessions.sql
postgres/0002_agent_session_role.sql
```

`0001_agent_sessions` introduces durable agent episodes and separates each
`(session, project)` delta position from the owner fallback. A type-aware composite
foreign key follows the shared project/folder registry row; a guarded retype cascade
closes unmark, boot-prune, and purge races. During upgrade it recognizes the former
PAT/OAuth/UI principal keys in `mcp_bookmarks`, resolves current project ids plus
legacy root-space ids, current slugs, and retired aliases, then groups them by
authenticated owner and project and preserves the greatest revision as the fallback.
A legacy row migrates only when its scope resolves to exactly one project; unknown
principals, missing scopes, and namespace collisions remain inert instead of being
guessed. The old table stays for schema compatibility and inspection but is no
longer written by the gateway.

`0002_agent_session_role` adds the nullable selected role name to each durable episode.
`NULL` is the base mode. Role package content remains file truth in `.notarium/skills`; the
meta-DB stores only the episode's current selection.

Role context presets reuse the baseline's existing `context_set_attachments`,
`context_scope_pins`, and `context_order` tables with `target_kind='role'`. No new migration is
required: `target_kind` is deliberately text without a closed SQL `CHECK`, and both drivers already
key every facet by `(target_kind,target_id)`. The opaque role target id deterministically encodes
the exact owned placement's scope, stable space/project owner id, and package name; `target_space`
retains purge ownership. The application contract is the closed union
`personal | project | role`, even though storage remains evolution-friendly text.

Every manifest entry has one contiguous integer version, one snake-case name,
one SQLite/PostgreSQL file pair, and one checksum over the exact pair of files.
Versions are zero-padded sequence numbers, not timestamps. Concurrent branches
that both claim the next version must conflict and be rebased into an explicit
order.

The pair checksum is SHA-256 over:

```text
"sqlite\0" + sqlite bytes + "\0postgres\0" + postgres bytes
```

The loader rejects a missing or extra dialect file, a gap/reorder, an invalid
name or filename, an unsupported manifest format, an empty dialect, and a
checksum mismatch. The production build copies the manifest and both SQL
directories beside the server bundles; the release/backup smoke checks those
assets in the runtime image.

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

Startup has three accepted states:

1. A genuinely empty database executes `0000_baseline.sql` and writes its ledger
   row in the same transaction.
2. A database whose ledger is an exact prefix of the manifest validates every
   version, name and checksum, then applies the pending suffix.
3. A non-empty database without the ledger—including the retired
   `meta_schema` layout—fails before DDL or application queries. Conversion of
   such a database is a version-specific operator operation, never a heuristic
   runtime branch.

An empty ledger, a version gap, a renamed or edited applied migration, and an
unknown future row all fail closed. A failed SQL statement rolls back its DDL
and ledger stamp; the same database and adapter instance remain retryable after
the external cause or unapplied SQL is repaired.

SQLite takes a write reservation before re-reading state and applying the
pending suffix. A fresh file is born with incremental auto-vacuum before its
first table and then enters WAL mode. PostgreSQL wraps the whole operation in
one transaction under a database-and-schema-scoped transaction advisory lock,
so replicas cannot race on fresh or pending DDL. Migration startup owns a
dedicated non-pooled connection and physically closes it before the application
pool is created; temporary objects, role changes, session settings, listeners,
prepared statements, or session locks from an asset therefore cannot leak into
ordinary queries. Its connection must resolve to exactly one durable user schema
(`options=-csearch_path=<schema>` when the database default is ambiguous). The
runner pins that schema transaction-locally before locking and rejects a
migration that leaves a different effective `search_path`. Every application
backend is then pinned session-locally to the validated schema before the pool
can serve it; even a missing entry from the configured path that materializes
later therefore cannot silently shadow the ledger and data.

## Adding a migration <a id="adding"></a>

Schema changes are forward-only:

1. Add matching `NNNN_name.sql` files to `sqlite/` and `postgres/`, where
   `NNNN` is exactly the next manifest index.
2. Prefer expand/contract changes that tolerate mixed application versions.
   Destructive contraction follows a separate compatibility window and a
   verified backup; there are no `down` migrations.
   Each dialect file is executed inside the runner-owned transaction: do not
   add `BEGIN`, `COMMIT`, or statements that cannot run transactionally (for
   example PostgreSQL `CREATE INDEX CONCURRENTLY`). Both runners mechanically
   reject transaction control inside an asset, so it cannot prematurely commit
   DDL without its ledger row. A change that truly cannot be transactional needs
   an explicit runner/protocol design and dedicated failure-recovery tests
   before it enters the manifest.
3. Print the pair checksum:

   ```bash
   npm run meta-migrations:checksum -- 0001_name
   ```

4. Append the manifest entry and run:

   ```bash
   npm run meta-migrations:check
   make test-pg
   ```

5. Add regressions for the transition, rollback/retry boundary, and any rolling
   writer protocol it introduces. Once a migration has shipped, its name,
   checksum and SQL are immutable.

The current baseline is the support floor. Pre-baseline development ladders are
not product compatibility history. A future rebaseline is a deliberate support
policy change: fresh installations may start from a newer cumulative baseline,
while still-supported deployed releases retain the immutable upgrade path they
need.

## Operations <a id="operations"></a>

Backups, not reverse SQL, are the data rollback mechanism. Use the verified
image-native backup/restore flow in [backup.md](backup.md). Never stamp a ledger
row merely because tables appear to exist: an operator conversion must first
verify the exact expected source version and catalog, preserve a tested backup,
perform the stamp transaction while the application is stopped, and then pass
integrity plus application smoke checks.

The canonical container layout is the unified `/data` root described in
[architecture.md](architecture.md#data-root). A legacy split-layout move is
also an offline operator operation; it must not run alongside either the old or
new application stack.
