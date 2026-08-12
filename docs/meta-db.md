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
sqlite/0003_revision_integrity.sql
sqlite/0004_scoped_purge_fences.sql
sqlite/0005_revision_entry_role.sql
postgres/0000_baseline.sql
postgres/0001_agent_sessions.sql
postgres/0002_agent_session_role.sql
postgres/0003_revision_integrity.sql
postgres/0004_scoped_purge_fences.sql
postgres/0005_revision_entry_role.sql
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

`0003_revision_integrity` adds the `integrity` axis to `note_revisions`. Existing rows
become `trusted`: they predate the global arbiter, so nothing has contaminated them yet.
A row turns `quarantined` only inside a settlement transaction, and every query then has
to classify, filter and count on the EFFECTIVE fields rather than the stored ones — see
[note-history.md](note-history.md#model).

`0004_scoped_purge_fences` scopes the permanent purge fence to a space. Before it, the
fence was keyed by note id alone, while the DELETE beside it was already space-scoped:
one space emptying its trash permanently silenced the journal of a COLLIDING id in
another, with no way to undo it. The migration adds `space` to `revision_purge_fences`,
puts it in the primary key, and rewrites the insert trigger to `space IN ('', NEW.space)`.
Legacy rows carry `space = ''` and stay GLOBAL: a purge decided before #327 cannot be
un-decided from here, and pretending otherwise would resurrect a journal the user
irreversibly erased. The new column is NOT NULL with no default in either dialect, so a
writer that omits the space does not silently write a global one. NOT NULL alone does not
carry that in SQLite: the pre-#327 writer is `INSERT OR IGNORE`, which swallows the
violation and would commit its purge with no fence at all — the permissive opposite. SQLite
therefore also gets a `BEFORE INSERT` guard, whose `RAISE(ABORT)` the statement's `OR
IGNORE` cannot suppress. In PostgreSQL that writer fails one step earlier, on its `ON
CONFLICT (kind, entity_id)`, which matches no constraint once the primary key moves. Either
way a purge attempted from an old process during a mixed-version window errors instead of
permanently silencing a colliding id it never knew about. That break is the deliberate half:
this fence is the one write in the schema that cannot be undone afterwards. It also
adds the indexes the quarantine closure walks (`base_rev`, `their_rev`, `source_rev`) and
the one the pin re-key seeks (`context_scope_pins(note_space, note_id)`); without them a
settlement of a long-lived note ran a full journal scan per revision, inside the
transaction that holds every other meta-DB write.

`0005_revision_entry_role` adds `entry_role` to `note_revisions` — what an entry IS in
its note's life, written by the writer instead of inferred by each reader (see
[note-history.md](note-history.md#model)). The backfill classifies the first row of each
`(space, note_id)` — `baseline` when it is `external`, `origin` otherwise — and keeps the
`base_rev IS NULL` conjunct byte-for-byte from the predicate it replaces: pre-#327 the
chain was keyed by note id alone across spaces, so a legacy first row CAN carry a parent,
and calling it a baseline would drop it out of Activity at migration time. It is written
as a set (`MIN(id) … GROUP BY space, note_id`), not as a correlated subquery: measured on
`node:sqlite`, the correlated form is quadratic in the space's journal (199 ms over 24k
rows, 15.5 s over 200k) against 55 ms and 562 ms for this one; PostgreSQL plans the same
text with an index subplan (185 ms / 2.0 s). The SQLite asset alone also creates
`idx_note_revisions_space_note`: `space` and `note_id` lead two different indexes, and
with no `sqlite_stat1` the planner walks the space's whole journal — `hasAnyFor` measured
0.565 ms/call over 24k rows against 0.0034 ms with the index, and the writer asks it once
per note. PostgreSQL needs no such index (`hasAnyFor` already seeks), so it does not get
one; asymmetric dialect assets are precedented by `0004`. The column is `NOT NULL DEFAULT
'change'` for the mixed-version window, which accepts two permanent consequences for rows
written by an old process during it: its synthetic baselines count as edits, and a note
BORN in that window reads as `edited` forever — inferring the role on read afterwards is
exactly what this column abolishes.

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
