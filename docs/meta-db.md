# Meta-DB schema migrations

The meta-DB contains state that cannot be reconstructed from Markdown alone:
stable identities, revision history and blobs, accounts and credentials,
memberships, durable jobs, OAuth state, and user curation. Its SQLite and
PostgreSQL drivers therefore share one forward-only, checksummed schema history.
Authoritative revision heads, restore-operation evidence, space lifecycle,
receipt-backed owner proofs, installation generation, and the causal outbox live
in the same repository; filesystem bytes remain under the resource authority.
Durable owner-scoped agent episodes and their delta positions live here too
(`agent_sessions`, including its selected role and sticky project hint, `mcp_delta_owner_cursors`,
`mcp_delta_session_cursors`); they
are not reconstructible from note files. Session positions are deleted with the
episode; owner fallbacks survive episode retention and are removed with their
project. Sparse System/Owned ability preferences are likewise owner state: an
absent row means enabled and a retained row means disabled.
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
sqlite/0006_revision_state.sql
sqlite/0007_revision_purge_cas.sql
sqlite/0008_causal_metadata.sql
sqlite/0009_agent_activity.sql
sqlite/0010_import_reservations.sql
sqlite/0011_legacy_name_aliases.sql
sqlite/0012_identity_settlement_lineage.sql
sqlite/0013_agent_session_role_identity.sql
sqlite/0014_ability_availability.sql
sqlite/0015_ability_preferences.sql
sqlite/0016_ability_placement_trail.sql
sqlite/0017_ability_create_operations.sql
sqlite/0018_causal_operation_lifecycle.sql
sqlite/0019_ability_placement_identity.sql
sqlite/0020_ability_create_success_replay.sql
postgres/0000_baseline.sql
postgres/0001_agent_sessions.sql
postgres/0002_agent_session_role.sql
postgres/0003_revision_integrity.sql
postgres/0004_scoped_purge_fences.sql
postgres/0005_revision_entry_role.sql
postgres/0006_revision_state.sql
postgres/0007_revision_purge_cas.sql
postgres/0008_causal_metadata.sql
postgres/0009_agent_activity.sql
postgres/0010_import_reservations.sql
postgres/0011_legacy_name_aliases.sql
postgres/0012_identity_settlement_lineage.sql
postgres/0013_agent_session_role_identity.sql
postgres/0014_ability_availability.sql
postgres/0015_ability_preferences.sql
postgres/0016_ability_placement_trail.sql
postgres/0017_ability_create_operations.sql
postgres/0018_causal_operation_lifecycle.sql
postgres/0019_ability_placement_identity.sql
postgres/0020_ability_create_success_replay.sql
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

`0009_agent_activity` adds the owner-global Activity projection and its stable event cursor.

`0013_agent_session_role_identity` adds the nullable exact selection beside that public name:
the canonical serialized `role_locator`, its `role_context_project_id`, and a separate sticky
`project_id` for by-name ability resolution. Same-context hydration reopens the exact Owned package
across manifest rename and refuses a same-name replacement after deletion. A project context change
returns a typed diagnostic in base mode instead of silently rebinding. Only
`start_session(project)` changes the sticky hint; a resume without `project` preserves it and a fork
inherits it. Old rows with only `role` also hydrate in base mode until the user explicitly selects a
role; there is no name-backed compatibility resolver.

`0014_ability_availability` separates an ability's immutable Personal/Space home from the projects
where it is effective. It is keyed by `(home_space, package_id)` and package ids never collide
between roles and skills, so ONE pair of tables serves both kinds — the name says `ability`, not
`skill`, for that reason. One row stores `all-projects` or `selected-projects`; selected project ids
live in a child binding table and must belong to the home Space. Whole-set replacement and
per-project grant serialize on the shared ordered lock plan in PostgreSQL and the matching immediate
transaction in SQLite. Both refuse a write whose target is gone — the home Space purged or purging,
or the registry note purged for good — in the same machine-readable shape (`ABILITY_TARGET_PURGED`)
rather than as a driver's foreign-key code, and out of the same producer the preference facet uses
(`services/metaDb/abilityLifecycle`): one lifecycle, one question, one answer. Sweeping the row is
only half of an END; the fence is the other half, or the next write puts the row back on a
`package_id` — a directory name, reusable by construction — that the next package installed there
inherits. The fence is the NOTE's and never the directory's, for the same reason. The home Space is
a plain column, like every other Space reference here: the `REFERENCES spaces(id)` it briefly
carried was the only foreign key to `spaces` this schema has ever had, and its implicit `FOR KEY
SHARE` inverted the tier-4 lock order against `purgeSpace` (see below). Project
retype/delete and Space purge remove stale bindings, and permanent purge of the package's own
registry note forgets the policy with it. That note is a SECOND key, stored beside the package id:
a package directory is named by the durable id its manifest declares, but claim arbitration can
leave the note carrying a different one, so the two are equal only until it runs. A row whose writer
did not know the note id — and only such a row — is still swept by the package id, which is exactly
the pre-arbitration answer. The policy is instance-local and never written into portable `SKILL.md`
bytes.

Creation reserves the exact policy before a Space package becomes readable. The reservation row
holds `registry_note_id = NULL` and already carries either `all-projects` or the deduplicated
`selected-projects` set; only a successful package publication may CAS-finalize it with the actual
registry note id, and only an unfinalized row may be cancelled. Space Skills reserve both modes
because their absent-row default is unavailable; Space Roles reserve only explicit availability,
while an unstated policy keeps their historical absent-row `all-projects` default. A stale row makes
creation mint a fresh package id instead of overwriting somebody else's lifecycle state.

`0017_ability_create_operations` makes Custom ability publication restart-recoverable across the
filesystem/meta-DB boundary. An accepted row binds actor/idempotency/request digests to package id,
settled note id, target path, exact reach and strict-stage evidence. The storage adapter owns the
restart-durable candidate and physical receipt. Once publication succeeds, one terminal transaction
materializes identity, writes the attributed `origin` revision and receipt-backed owner proof,
finalizes reach with the actual note id, appends the causal outbox event and records the replay
result. This `metadata-committed` transaction is the semantic point of no return; the later
`succeeded` transition only acknowledges projection/stage cleanup. A committed transaction whose
acknowledgement was lost is replayed; a physical effect whose
terminal commit was interrupted stays recoverable and blocks public resource admission until boot
recovery completes. Pre-physical rejection alone may release the provisional identity/reach rows.
The derived engine adopts the same receipt under the shared causal-publication admission before the
terminal transaction, preventing boot or watcher reconciliation from reappearing as a second
anonymous external edit. Cleanup/reconcile failure after the terminal transaction leaves the outbox
pending and does not turn the committed create into a 500.

`0018_causal_operation_lifecycle` keeps lifecycle closure an admission fence rather than aborting
work already admitted durably. The revision trigger still rejects ordinary writes outside `active`,
but recognizes the exact `physical-published` restore or ability-create operation that owns the
terminal revision. Both terminal writers accept `active` and `closing`; fresh operation acceptance
remains `active`-only, and neither path can write after the lifecycle reaches `archived`.

`0019_ability_placement_identity` binds every new placement-trail hop to two independent identities:
the registry note projected for the package and the physical owner claim read from its manifest
under source admission. Claim arbitration may make them different, so neither substitutes for the
other. A locator names an address and that address can be reoccupied; a recorded target is accepted
only when both live identities match their respective trail values. Rows written before this
migration keep nullable identities because opaque locators cannot be backfilled honestly; their
presence still retires the old spelling, but resolution fails closed. Both dialects reject a new or
rewritten trail row without either identity while allowing legacy rows to remain until a later
supported move replaces or removes them.

`0020_ability_create_success_replay` separates operation history from ownership of an idempotency
key. Rejected create rows remain available for lifecycle/audit inspection, but the unique replay
index and both replay lookups exclude them. A corrected request may therefore reuse the same key
after the pre-publication refusal is removed; accepted, recoverable and committed operations still
own it and retain request-fingerprint conflict detection in both SQLite and PostgreSQL.

An absent row is not the same answer for both kinds. A Space Skill is a dependency a Role opts into,
so absence reads as `selected-projects` with nothing selected — unavailable until stated. A Space
Role applied everywhere in its Space before availability existed, so absence reads as `all-projects`:
that default is what lets availability arrive without a data migration.

`0015_ability_preferences` stores only disabled System/Owned overrides, keyed by owner plus the
canonical exact locator. Catalog is excluded by TYPE, not by schema: a preference target is a System
or Owned locator and nothing else, and the row has no `source` column to constrain — the earlier
`CHECK` on one was dropped when this table was rewritten around the whole locator. The locator IS
the key, so nothing it already spells — source, kind, package id, placement — is denormalised beside
it. Owned rows carry the two keys the locator does not answer, the ones a lifecycle END is found by:
stable Space and registry note, both present or both absent. A placement move rewrites the locator
for every owner at once and can therefore name no prefix of the `(owner, locator)` primary key, so
`ability_preferences_locator` indexes that column on its own, and `0016_ability_placement_trail`
records where the address went (see the lock order below). Reversible note deletion keeps the row.
Permanent note purge deletes rows for the exact registry note, while whole-Space purge deletes all
rows for that Space. A concurrent disable cannot recreate an orphan: SQLite performs the lifecycle
and purge-fence check in the same immediate transaction; PostgreSQL takes the Space and note revision
locks before the same check and write. The lifecycle half of that check reads `space_lifecycle.phase`
and not only the `spaces` row, because `purge-intent` is the one ended phase that still HAS a row —
a Space sits in it for as long as a pinned restore keeps the sweep from starting, and a fence of
`SELECT 1 FROM spaces` alone calls such a Space live. Both refuse in the same machine-readable shape
(`ABILITY_TARGET_PURGED`), for either value of the flag — there is nothing to re-enable on a target
that is gone for good, and the refusal is what lets a route answer "not found" instead of 500.

The PostgreSQL lock order these tables join is stated and enforced in
`services/metaDb/drivers/pg/lockOrder.ts`, not here; the shape of tier 4 is the part worth repeating
because two transactions meet in it from opposite directions. The order is `folders` (L4f) →
`ability_availability`/`ability_project_bindings` (L4a) → `ability_preferences` (L4p), below the
whole revision tier. A whole-space purge arrives from above and drops the registry after the journal;
an availability write reads the project rows it is about to bind BEFORE writing the binding. Both
are one order only while `folders` outranks the ability tables — the other way round is a cycle, and
PostgreSQL resolves cycles with `40P01`. Every `folders` lock is therefore a tiered lock, including
the project parent row the agent delta cursors take.

A FOREIGN KEY is a lock statement nobody writes, and the ladder cannot order what it cannot see:
`INSERT`/`UPDATE` of the child takes `FOR KEY SHARE` on the parent row at whatever depth the child
sits. That is why `spaces` is on `lockOrder`'s `NO_FOREIGN_KEY_MAY_POINT_AT` list and every other
table names its Space with a plain column — `purgeSpace` holds the space row `FOR UPDATE` from
inside tier 3 all the way down past `folders`, so a key from tier 4 makes each side hold what the
other waits for. The schema is held to that list by a portable check over both dialects'
migrations. Where a parent IS ordered the key is welcome: a binding's `folders` parent is L4f, above
the L4a child that points at it, and the writer already holds those exact rows `FOR SHARE`.

L4p is entered through an advisory rather than through a row lock, because its two writers cannot
meet on a row: a disable writes an `(owner, locator)` that need not exist yet, and a placement move
rewrites the `locator` column for every owner at once. Under READ COMMITTED the move's range
`UPDATE` neither sees nor locks a row inserted after its snapshot, so without a key both sides can
name the two pass through each other and one of the writes is simply lost. The key is the PACKAGE
(`abilityPackageOfLocator`) and not the locator, because the locator is exactly what the move
changes: a disable that still names the address the package has left has to reach the same stripe as
the move that left it. The two sweeps of that table do not take it and cannot — they are keyed by
the lifecycle columns and have no package to name, and the tier-3 stripes above already order them
against the disable; both say so in their register entries instead.

L2d is the same shape two tiers up, and for the same pair. `scopePins.addPin` inserts a row keyed by
`(target_kind, target_id, note_id)` while the same move re-addresses every pin of a target by range,
so the two are serialized on the TARGET or not at all — and "not at all" is a note the user pinned
landing on the address the role has just left, where nothing but the opposite move will ever read it
again. Its two sweeps (a settlement by note, a whole-Space purge by `target_space`) have no target to
name and meet a pin writer on rows or above them.

Two tables the same move re-addresses have no such key today, and that is a statement of where the
schema stands rather than a claim that it does not matter. `context_set_attachments` (L2b) is written
by `contextSets.attach`, a single autocommit statement that would have to become a registered
transaction first — `pgTransactionRegistry.test.ts` records the level as helper-less for exactly that
reason. `agent_sessions.role_locator` is outside the ladder altogether, and an episode that binds
itself to the address the role is leaving resumes in base mode instead of with its role, which exact
resume is fail-closed about by design.

Serializing decides which of them goes first and nothing else, which is why `0016_ability_placement_trail`
exists: whichever side loses, one of them computed an address before the other committed. The move is
the only writer that knows both ends of the hop, so it records `from_locator → to_locator` (with the
Space the row is swept by), and every read and write of an override resolves through it — a disable
written at the address just left lands where the package IS, and a caller still holding the old
spelling gets the same answer instead of "enabled". The trail is kept one hop deep by the move
itself: a move INTO an address deletes the row pointing out of it, a move OUT of one re-points
whatever pointed at it, so no reader ever walks a chain and a promotion undone by hand leaves no
cycle. All three implementations of the port do this — both dialects and the in-memory twin — and
the contract arc is `applies a disable written at the address the move has already left`.

The same recorded hop is the only stale-address bridge for Ability authoring. Authority is selected
before any exact package read: no row means the input address, while any recorded row retires that
spelling even if a new package occupies it. Under a shared package admission the resolver rechecks
the same authority, exact-reads only the selected address, and for a hop also requires both the
physical owner claim and projected registry note id recorded by `0019`. Invalid/legacy evidence or
a missing live target means not found; scanning sibling projects for the same package id is not
evidence that the package moved. The resulting snapshot carries both identities with the package
bytes; application detail may be derived after release without reopening that same fair gate. Every
later metadata update, move or delete reopens the exact target and verifies both identities at its
own mutation point.

An authored manifest write additionally joins the ordinary store order instead of wrapping it from
outside. `MutationCoordinator` first owns the note/path claim; its `aroundWrite` bracket then takes
the target placement/package admission, revalidates the snapshot identities, performs the admitted
physical CAS write and releases in `finally`. Taking placement first and then calling the public
store writer is forbidden: an ordinary writer takes the claim first, so the reverse order forms a
claim↔placement cycle.

Which transactions must enter these levels through a helper is not prose: `LEVELS_NO_STATEMENT_CAN_ENTER`
lists the levels no statement can enter by itself, and `pgTransactionRegistry.test.ts` holds every
registered transaction that declares one of them to a helper call in its own body — statically, so a
removed advisory turns red without a database. A sweep that has no key to name declares that fact,
by level and with a reason, in its own register entry.

Both ability writers therefore fence themselves ABOVE tier 4 instead, on the Space stripe (L3s) and,
when the caller knows it, the registry note stripe (L3n) — the levels a whole-space purge and an
exact note purge take first and hold to COMMIT. That is what makes the refusal honest rather than
lucky: a writer that passes the fence cannot be running while a purge decides, and one that arrives
after it waits, reads the fence the purge left, and answers `ABILITY_TARGET_PURGED`.

`0006_revision_state` adds nullable `note_revisions.snapshot_format`. Its original
complete rows use `markdown-v1`; existing rows remain `NULL` and are read as legacy
body-only snapshots. Later byte-safe formats are additive per row. The migration
never guesses or rewrites missing metadata.

`0007_revision_purge_cas` advances the PostgreSQL fenced-writer protocol to the
compare-and-purge generation and adds the byte-safe document-state format. A
rolling peer using the previous unconditional purge protocol is rejected after
migration. PostgreSQL converts CAS blobs to `BYTEA`; SQLite preserves its dynamic
TEXT/BLOB distinction. SQLite serializes append and latest-row compare-and-purge
with an immediate write transaction.

`0008_causal_metadata` adds the authoritative head, live address revision,
owner-proof receipts, restore operations, space lifecycle, causal outbox, and
the witnessed installation generation plus its bounded backup-freeze lease. It
also persists `note_revisions.semantic_fingerprint` and `restore_safety`, so exact
source identity and eligibility survive restart instead of being recomputed from a
possibly newer parser.
Key transitions and freeze acquire/renew/release serialize on the same
installation barrier; a crashed producer's expired lease is removed before
startup recovery. Lifecycle triggers reject delayed space-owned producers
after closing in both dialects. PostgreSQL uses the shared ordered advisory-lock
namespace; SQLite uses the matching immediate transaction boundary. Purge retains
a hidden lifecycle tombstone and immutable cleanup manifest after deleting the
ordinary registry row, so startup can finish physical cleanup before disk discovery.

Strict restore completion uses the `restoreTerminal` persistence facet rather
than composing the ordinary facets in application code. One transaction binds
the accepted operation's prepared evidence and physical receipt to the current
revision head, identity/address revision, lifecycle, and owner-proof revision;
then it appends the restore revision/blob, updates the live identity and
receipt-backed proof, stores the terminal operation result, and appends the
outbox event. A retry of an already succeeded operation returns the stored
result without adding a second revision or event. PostgreSQL takes the complete
causal barrier plan in the global order (installation, lifecycle, note,
address, proof, operation, blob, outbox) and also joins the legacy revision-GC
locks; ordinary identity writers join the same address barriers.

Durable bulk restore reuses `restore_operations`: one parent row stores the normalized
selection and frozen ordered item roster in prepared evidence; each accepted item is a
normal strict child with a deterministic replay key. Evidence updates use compare-and-
swap (`expectedPreparedEvidence`) so two resumptions cannot lose a child result. A
nonterminal parent is a lifecycle blocker. While a space is `closing`, persistence
rejects fresh restore admission but permits a deterministic child whose validated
parent was accepted before closing; this lets the bounded roster drain without opening
a fresh mutation channel.

The causal outbox is a durable projection-repair queue, not a payload transport.
Each replica rereads committed file/metadata truth and runs its local store
reconcile before acknowledging an event. Startup drains it strictly after space
lifecycle recovery and before public admission; a projection failure therefore
leaves the row pending and fails startup closed. Runtime delivery is at-least-once:
local commits wake the worker and peer commits are found by polling. An inactive
space has no live projection to repair and its next activation cold-boots from
truth, so its event can be acknowledged without warming archived data.
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

`0010_import_reservations` adds the two tables a Markdown-tree import claims its
destinations in (#302). The header is keyed by `(space, upload_ref)` — the staged upload
is immutable for the life of the job, so a retry of that job reserves once and adopts
thereafter, while a DIFFERENT upload aiming at the same paths conflicts before the first
write rather than half a tree in. Its `fence` is handed out on reserve/adopt and re-proved
by every write, so a reclaimed job's newer fence is what stops the previous run's writes;
`status` is `active` while the job may still write and `closing` once terminal cleanup
began dropping it — a close is two statements in one synchronous step, so `closing` is a
state only a process that DIED between them can leave behind, and reserve/adopt refuse
such a row rather than reviving a claim already given up. The path table holds one row per
planned destination, and its `UNIQUE (space, destination_path)` is the point of the
migration: that one live reservation owns a path is stated by the database, not by a race.
It is also how one claim is FOUND for a fenced write — that lookup addresses a row by
`(space, destination_path)`, and the reservation is then a filter on the row that index
returned rather than a scan of the batch. Whole-batch reads use the primary key whose
leading column is `reservation_id`; using that predicate for the per-write lookup made every
write cost the size of the import.
Each row also carries what the plan settled — the id the path will get, the id it expected
to already stand there, and whether that identity is this import's own or an existing
note's merely referenced — but those three are DESCRIPTION, recorded per archive member so
a claim can be read back and attributed. No write proves itself against them: the sidecar
plan a run re-reads is the authority on ids. What this table arbitrates is the PATH, which
is also why nothing here ever releases an identity.
What the table deliberately does NOT have is a "the bytes landed"
column: publishing the file and recording that fact are two writes with a crash window
between them, so the flag could only repeat the question it was meant to answer. A row is
a claim on a PATH; whether the previous attempt published is asked of the note at that
path, by the retry, under the write's own compare-and-swap. Both dialects ship the same
shapes so the shared persistence contract holds them to one behaviour. A space purge
deletes its reservations directly: a header left pointing into a space that no longer
exists would hold paths forever and keep terminal cleanup chasing a job row the same purge
removed. See [import.md](import.md#who-owns-a-destination-while-the-import-runs).

Role context presets reuse the baseline's existing `context_set_attachments`,
`context_scope_pins`, and `context_order` tables with `target_kind='role'`. No new migration is
required: `target_kind` is deliberately text without a closed SQL `CHECK`, and both drivers already
key every facet by `(target_kind,target_id)`. The opaque role target id deterministically encodes
the exact owned placement's scope, stable space/project owner id, and immutable package id; `target_space`
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
