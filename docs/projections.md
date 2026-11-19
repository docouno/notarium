# Structural projections

`notarium-projections` serves structural snapshots, note listings, declarative
Markdown views and Space graphs over data built from the canonical change stream.
The engine exposes `StructuralReadPort` and `ViewGraphPort`. Applications compose
`ProjectedNoteReadPort` for note listings and canonical point reads. The projector
provides board facts to the canonical writer, which commits card fields and rank
changes together. The service crates can compose these ports directly.

## Storage and lifecycle

Each generation has a dedicated SQLite database at
`v1/derived_gen_<N>/derived.sqlite`. A PostgreSQL deployment uses a derived schema
and keeps the mmap cache on the serving node. Both use a narrow card and link
lookup store. The local database uses WAL and secure deletion. Field filters use
bitmaps and bit-sliced numeric, date and timestamp indexes.

Each Space's immutable `v1/derived_gen_<N>/spaces/<space_id>/fast_index_<seq>.mmap`
contains the dense-ID lookup, ordering headers, filter indexes, forward and reverse
graph edges and community assignments. The writer synchronizes the file before
publishing its trusted digest. Opening checks the format, Space and history,
section bounds and alignment, and digest before using aligned bitmap views.
Resident mappings have a bounded least-recently-used pool with defaults of 64
Spaces on Desktop and 256 on Server and Cloud. Readers that hold a published
cut can finish within its retention window.

The projector consumes complete canonical commands and advances durable
watermarks at command boundaries. It stages bounded pages, splitting a large
individual mutation into verified fragments for atomic publication. An in-memory
delta carries changes since the last checkpoint. A durable slot journal reopens
that delta from derived rows. Missing or corrupt mmap files can be rebuilt from
valid derived rows. Recovery also clears a checkpoint file left by an
interrupted publication before the next compaction. Missing derived state is
seeded from bounded canonical keysets at a fixed cut, then caught up from the
durable change stream. Recovery applies canonical purge and chat redaction
markers before publishing a cut. When erasure requires a reseed or a checkpoint
requires repair, existing subscriptions receive a resync after the replacement
cut can serve reads.
The resync repeats the subscriber's last delivered cursor.
A retained cursor identifies its original history and generation. A restored
history gets a new identity and requires clients to reopen their reads.
Canonical storage and CAS are the authoritative recovery inputs. See
[canonical storage](storage.md).

The active generation serves reads while its successor catches up. SQLite
publishes a durable local descriptor. PostgreSQL uses a control schema where
serving owners attest matching canonical command cuts and their local files
before a switch. Each Space binds its visibility lookup independently before
admitting new reads in the new generation. The prior lookup keeps its local
file available until that Space rebinds. Previously opened cursors retain their
original generation and check the owner's current visibility state.
PostgreSQL records owner and generation leases as operational state outside the
portable backup. Ownership transitions require a completed drain or explicit
evidence that the previous owner process has terminated.

Startup can rebuild a recognized older layout into a new generation. In
PostgreSQL, owners can rebuild their own Spaces and confirm the cutover together
after the old generation has released its reader and worker leases. Cache files
are reclaimed on the node that owns them. Give each PostgreSQL serving process
its own cache root. A runtime restart within the same process can reuse the root
while a detached canonical writer or a retained snapshot holds it.

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
Canonical rank overlays order cards within a column. An exact read can apply
the specific note and rank revisions selected by up to eight mutation receipts.
When a mutation cannot be represented in the bounded overlay, the read waits
for projection through its command boundary. A deadline or cancellation ends
that wait. A continuation retains the card, rank and group versions selected
when the page was opened and still checks current lifecycle and authority.
For a queued board event at an older cut, the stream checks the original and
current source before sending a resync signal. Group counts and ranks come
from events at the current cut. When a command exceeds the notification budget,
a restricted subscription receives a resync only after a paginated canonical
read confirms a visible change.
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
edges around one note for one or two hops. Cluster identities are preserved by
matching successive community memberships. If adjacency is already on disk
when clustering finishes, durable memberships advance independently of the
immutable checkpoint. Note link pages expose authored targets and resolved
backlinks after checking visibility at the projected cut and at delivery.
Graph settlement events go to subscribers with whole-Space access to all
document classes. Restricted subscribers still receive authorized entity changes.

Listings can return authorized encrypted note identities as metadata. Encrypted
carriers, fields and edges are excluded from views and graph reads. An active
Space owner checks lifecycle and authorization when returning data, including
after a concurrent purge or owner handoff. For chat backlinks across owners,
applications can register a `BacklinkOwnerResolver` with in-process owner
endpoints. The read holds the source and target owner permits through
verification and response assembly. Redaction removes source references and
invalidated context entries from eligible results. PostgreSQL erasure stays
active with the canonical writer when its local projector stops, so that
writer can clean a generation shared with other peers.

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
container cannot see the controller. The fixture runs both SQL drivers with
100,000 Markdown cards and 500,000 authored links per driver. Its board uses a
folder subtree, tag, enum and indexed date range. The cold cases evict each
checkpoint from the resident pool and advise the Linux kernel to discard its
cached pages before opening or querying. SQL hydration uses an established
pool. The PostgreSQL profile uses a local Unix socket and local CAS. Its results
describe the storage and projection workload under that setup.

The report records p50, p95 and p99 for the read workloads, plus durable tail
replay, board receipt and import observations, and cold rebuild. The replay
timer starts after 1,000 body edits are durably projected over an older
checkpoint and after the benchmark evicts the resident mapping. The same
recovery routine used at startup must return that checkpoint and the exact
newer cut. The benchmark then checks all 1,000 edits through their new tag and
reads forward and reverse adjacency from the recovered index. The million-note
microprofile builds the production checkpoint from synthetic note and graph
metadata. It runs the production board planner and hydrates the planned top 50
from SQLite. Its isolated visibility backing uses the same layout as a live
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
| Rebuild from watermark zero | Equivalent logical rows, links and ranks, canonical reads below 250 ms and zero SQLite busy errors |
| Folder move | Zero candidate rewrites and zero rewrites of unqualified title links |
| Million-note profile | 150–180 MiB checkpoint, warm board p95 below 5 ms and at most 8 MiB of steady private fence allocation |
