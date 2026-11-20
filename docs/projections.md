# Structural projections

`notarium-projections` serves structural snapshots, note listings, declarative
Markdown views, link queries and Space graphs over data built from the canonical
change stream. The engine exposes `StructuralReadPort`, `ViewGraphPort` and
`LinkReadPort`. Applications compose `ProjectedNoteReadPort` for note listings
(including visible folder cover notes) and canonical point reads. The projector
provides board facts to the canonical writer, which commits card fields and rank
changes together. The service crates can compose these ports directly.

## Storage and lifecycle

Each generation has a dedicated SQLite database at
`v1/derived_gen_<N>/derived.sqlite`. A PostgreSQL deployment uses a derived schema
and keeps the mmap cache on the serving node. Both backends maintain the same
20-table current-state layout covering watermarks, folders, notes, view
descriptors, view ranks, link candidates, resolved links, aliases, chat threads
and references, graph clusters, trusted checkpoints, guards, staging pages and
replay journals. Reads are lock-free over `Arc<PublishedCut>` (`mmap + L0`) and
issue zero SQL writes. The local database uses WAL and secure deletion. Field
filters use bitmaps and bit-sliced numeric, date and timestamp indexes.

Each Space's immutable `v1/derived_gen_<N>/spaces/<space_id>/fast_index_<seq>.mmap`
contains the dense-ID lookup, ordering headers, filter indexes, forward and reverse
graph edges and community assignments. The writer synchronizes the file before
publishing its trusted digest. Opening checks the format, locked CRoaring ABI,
Space and history, section bounds and alignment, and digest before using aligned
bitmap views. Resident mappings have a bounded least-recently-used pool with
defaults of 64 Spaces on Desktop and 256 on Server and Cloud. On Unix, purges
unlink erased checkpoint files immediately while active mappings remain valid
until released.

The projector consumes complete canonical commands and advances durable
watermarks at command boundaries. Ordinary incremental commands apply directly
in a single write transaction; unusually large commands spill to bounded staging
pages before atomic publication. Large link-resolution commands and cold seeds
can spill their lookup keys to a temporary SQLite file on the serving node.
An in-memory delta carries changes since the
last checkpoint, and a durable slot journal reopens that delta from derived rows.
Missing or corrupt mmap files can be rebuilt from valid derived rows. Recovery
also retires obsolete local checkpoints left by an interrupted publication.
Missing derived state is seeded from bounded canonical keysets at a
fixed cut, then caught up from the durable change stream. Recovery applies
canonical purge and chat redaction markers before publishing a cut. When erasure
requires a reseed or a checkpoint requires repair, existing subscriptions receive
a resync after the replacement cut can serve reads. The resync repeats the
subscriber's last delivered cursor. A retained cursor identifies its original
history, generation and cut; when derived state advances past a cursor's cut in
the same generation, continuation returns `CursorStale` so callers reopen on the
current cut, while `StructuralReadPort::hydrate` can fall back to canonical
storage at the requested cut. Cursor expiry releases the retained checkpoint
even when the Space receives no further reads or changes. A restored history gets
a new identity and requires clients to reopen their reads. Canonical storage
and CAS are the authoritative recovery inputs. See [canonical storage](storage.md).

The active generation serves reads while its successor catches up under
single-owner Blue-Green rotation. Pass the next generation number to
`ProjectorRuntime::rotate`. The runtime opens the candidate in the active
installation. SQLite publishes a durable local descriptor. PostgreSQL scopes
the rotation lock to the installation's control schema and holds it through
candidate recovery or activation. A concurrent PostgreSQL startup or rotation
that needs the same lock returns `NotReady` and can be retried after the first
operation completes. Each Space binds its visibility lookup independently before
admitting new reads in the new generation. The prior lookup keeps its local
file available until that Space rebinds. Previously opened cursors at the final
cut of the retired generation remain readable across rotation while checking the
owner's current visibility state. PostgreSQL records single-Space ownership
state outside the portable backup; ownership handoffs require a completed drain
or explicit evidence that the previous owner process has terminated. Cluster-wide
multi-peer generation handoff is deferred to the horizontal transport wave.

Startup can rebuild a recognized older layout into a new generation under the
same single-owner control descriptor and reclaim obsolete schemas and cache files
once open handles release. Cache files are reclaimed on the node that owns them.
Give each PostgreSQL serving process its own cache root. A runtime restart within
the same process can reuse the root while a detached canonical writer or a
retained snapshot holds it.

## Authoring a view

A fenced `nota` block defines a table, list, board or calendar. Its stable `id`
identifies the view within its note. The source selects the scope, classes and
tags. Its filter and sort control membership and row order. A board also
selects a scalar group field. A calendar selects a date or timestamp field.

```nota
id: v_0123456789abcdef0123456789abcdef
type: board
source:
  scope: space
  tags: [planning]
filter:
  eq: {key: priority, value: high}
sort:
  - {field: updated_at, direction: desc}
group_by: status
options:
  columns: [todo, doing, done]
```

The compiler validates filters against declared field types and evaluates
undeclared fields from their observed values. A scalar value and a list element
use different indexes. Null, missing, invalid and empty-list values retain their
own meanings. A pending or invalid block returns a typed view error, so an editor
can keep an incomplete block while the author repairs it. Declared field schema
changes trigger recompilation.

Board reads return column counts and bounded card pages from one read cut.
Canonical rank overlays order cards within a column. Timestamp-ordered boards
seek eligible ranked cards by column, rank and note ID. Sparse selections and
custom field sorts can fetch placements for candidate notes. When only a few
cards in a column have ranks, continuation reads those placements through the
column index and selects the unranked page from the checkpoint. A continuation
can verify its leading candidates in one batch. If that yields too few cards, it
continues the rank scan until it has covered the group or checked as many
placements as there are remaining candidates. The query keeps its
exact receipt replacements separate until the final window is merged. `options.columns` applies
to grouped and board views (up to 256 columns) without interfering with
table/list presentation options, and contradictory `scope: space` or
`scope: project` sources with an explicit `folder` are rejected. An exact read
can apply the specific note and rank revisions selected by up to eight mutation
receipts when no intervening schema or folder mutation invalidated the base cut.
When a mutation cannot be represented in the bounded overlay, the read waits
for projection through its command boundary. A deadline or cancellation ends
that wait. A continuation keeps its opened cut while derived state stays at that
cut (or across rotation on the retired generation's final cut) and still checks
current lifecycle and authority; once derived advances in the same generation,
continuation returns `CursorStale`. Each Space uses its own event broadcast
channel so bursts in one Space do not lag subscribers in another, and purges
scrub queued board payloads in memory. For a queued board event at an older cut,
the stream checks the original and current source before sending a resync
signal. Group counts and ranks come from events at the current cut. When a
command exceeds the notification budget, a restricted subscription receives a
resync only after a paginated canonical read confirms a visible change.
See [history and causal reads](core-contracts.md#history-and-causal-reads).

## Links and graph

A stable note ID in the current format resolves only to that identity. A
legacy-shaped name checks for an exact live legacy ID before applying the
human-name rules. An unqualified name tries its source folder, then the Space's
filenames, titles, frontmatter slugs, authored aliases and historical note
aliases. Explicit paths preserve their directory qualification. They check
filenames, titles and frontmatter slugs within the live folder, then historical
note aliases scoped to that folder. If a directory segment no longer exists,
the folder-move aliases can resolve it when each segment and the final note are
unambiguous. Active candidates tie-break by creation time and then note ID.
A folder move updates matching path references and keeps the unqualified
title candidates. For a subtree moving between active ancestors, the projector
shifts the subtree membership bitmap and active note count across the affected
ancestor chains. A note's project membership comes from its parent folder, so
the move can update that membership without rewriting note rows.

Supercluster queries return up to 500 stable community nodes and weighted
inter-community edges. A focal community or project lens returns a ranked,
bounded window of up to 2,000 nodes. A neighborhood returns incoming and outgoing
edges around one note for one or two hops (capped at the same edge bound).
`GraphResult.hidden_count` counts active non-encrypted notes hidden by query
filters or node caps and excludes unauthorized (`HiddenByAuth`) notes so
cross-project or cross-class cardinality is never disclosed. Cluster identities
are preserved by matching successive community memberships. During rotation the
candidate adopts the serving partition at the shared cut, matching members by
note ID across the two dense indexes. If adjacency is already on disk when
clustering finishes, durable memberships advance independently of the immutable
checkpoint. `LinkReadPort` exposes note link
pages (authored targets and resolved backlinks) and chat backlink pages after
checking visibility at the projected cut and at delivery.
Graph settlement events go to subscribers with whole-Space access to all
document classes. Restricted subscribers still receive authorized entity changes.

Listings can return authorized encrypted note identities as metadata. Encrypted
carriers, fields and edges are excluded from views and graph reads. An active
Space owner checks lifecycle and authorization when returning data, including
after a concurrent purge or owner handoff. If a folder move invalidates the
visibility change journal, readers verify the old cut in short batches and
release the Space read lock between them. A change to the canonical head
invalidates that scan. For chat backlinks across owners,
applications can register a `BacklinkOwnerResolver` with in-process owner
endpoints. The read holds the source and target owner permits through
verification and response assembly. Redaction removes source references and
invalidated context entries from eligible results. Both SQLite and PostgreSQL
erasure hooks remain active on the canonical writer after the local projector
stops so offline purges and redactions still clean derived databases and local
checkpoint files. After a full process restart, start the projector with its
existing cache. The canonical writer remembers that this installation uses
projections and requires the cleanup handler before acknowledging a purge or
chat redaction, including retries with the original command key. A SQLite
installation binds the cache identity even when the projection cache and
canonical database use different directories. PostgreSQL binds the identity
of the shared generation control schema, so each serving node can keep its own
local cache. Portable backups carry canonical data and exclude these
installation bindings.

A purge verifies the current canonical history while holding
the same cache lock used for checkpoint publication. For that Space it removes
checkpoints below the purge sequence in the current history and checkpoints
from previous histories at any sequence. When an active or reserved generation
has no SQL floor, its matching files keep the purge pending. A retired SQLite
generation containing only checkpoints can release matching files while readers
of other Spaces keep their shared leases. If `derived.sqlite` is missing or empty
and its WAL or rollback journal remains, purges and chat redactions stay pending.
Startup also preserves these files. Stop all users of that derived cache, then
restore the matching SQLite database and journal set or discard the affected
disposable projection generation offline. Restart and retry the original command.
Canonical databases and blob storage are outside this recovery operation.
SQLite checkpoint writers verify the
generation descriptor and the floor in the current database before publication.
Worker recovery uses only the exact history being built.

## Verification

`make test` uses the offline SQLite and socket-only PostgreSQL 16 fixtures and
runs the mmap loader quarantine gate. After setup, the release benchmark can be
run from the checkout root.

```sh
sh docker/storage-fixtures/with-storage-fixtures.sh projection-benchmark
```

The launcher attributes measurements to the exact source tree, checks the work
mount, and writes `.artifacts/5-projections-graph/metrics.json`. The launcher
validates the report against the same tree. The report records the source of
each CPU and memory limit, using the launcher's cgroup when the nested
container cannot see the controller. The fixture runs both SQL drivers end-to-end with
100,000 Markdown cards and 500,000 authored links per driver. Its board uses a
folder subtree, tag, enum and indexed date range. The cold cases evict each
checkpoint from the resident pool and advise the Linux kernel to discard its
cached pages before opening or querying; for SQLite cold board queries the
benchmark also advises `POSIX_FADV_DONTNEED` on the derived SQLite database and
WAL files. SQL hydration uses an established pool. The PostgreSQL profile uses a
local Unix socket and local CAS. Its results describe the storage and projection
workload under that setup. Both drivers also measure the warm and cold 50-row
read after a canonical drag materializes the destination column. Every sample
checks column counts, note order and the presence of physical ranks.

The report records p50, p95 and p99 for the read workloads, plus durable tail
replay, board receipt and import observations, and cold rebuild. The replay
timer starts after 1,000 body edits are durably projected over an older
checkpoint and after the benchmark evicts the resident mapping. The same
recovery routine used at startup must return that checkpoint and the exact
newer cut. The benchmark then checks all 1,000 edits through their new tag and
reads forward and reverse adjacency from the recovered index. The million-note
microprofile is explicitly scoped as a synthetic scale exercise separate from
the end-to-end 100k runtime profiles: it builds the production checkpoint from
synthetic note and graph metadata, measures cold 1M checkpoint open after
`POSIX_FADV_DONTNEED`, runs the production board planner directly against the
mapped index, and hydrates the planned top 50 cards from a synthetic 50-row
SQLite table. Its isolated visibility backing uses the same layout as a live
owner. The report separates private allocation capacity, shared index bytes
and shared delta bytes through hydration, lag, compaction and eviction.

| Workload | Acceptance threshold |
| --- | --- |
| Cold trusted checkpoint open | p95 below 5 ms |
| Warm board with 50 hydrated cards | p95 below 5 ms |
| Cold checkpoint board with 50 hydrated cards | p95 at most 15 ms |
| Two-hop neighborhood | p95 below 1 ms |
| Recovery of 1,000 durably projected edits over an older checkpoint | Below 65 ms |
| Exact board reads during a 10,000-note import | Zero stale frames |
| Rebuild from watermark zero | Equivalent logical rows, links and ranks, total rebuild at most 120 s, canonical reads below 250 ms and zero SQLite busy errors |
| Folder move | Zero candidate rewrites and zero rewrites of unqualified title links |
| Million-note microprofile (synthetic checkpoint + 50-row hydration table) | 150–180 MiB checkpoint, cold checkpoint open p95 at most 500 ms, warm board planner p95 below 5 ms and at most 8 MiB of steady private fence allocation |
