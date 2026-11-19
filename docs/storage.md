# Canonical storage and CAS

`notarium-canonical` (`#![forbid(unsafe_code)]`) owns durable canonical SQL state,
content-addressed blobs, atomic batch mutations, crash-safe erasure, change
streaming and database backup participation. It depends only on `notarium-core`
and `notarium-syntax` within the workspace.

## Runtime profiles and ownership boundary

Two runtime storage profiles execute the same typed domain logic and pass the
same behavioral parity suites:

- **Local profile:** `SQLite` (`journal_mode = WAL`, `synchronous = FULL`,
  `secure_delete = ON`, `wal_autocheckpoint = 0`, `foreign_keys = ON`,
  `journal_size_limit = 64 MiB` at idle, zero `ATTACH DATABASE` statements and
  zero FTS/virtual shadow tables) paired with `LocalZstdV1` content-addressed
  files inside `DataRoot`.
  SQLite writers and checkpoint connections set `synchronous=FULL` and
  `fullfsync=ON`. On macOS this requests `F_FULLFSYNC` from the filesystem
  for both WAL commits and checkpoints. SQLite falls back to `fsync` if the
  filesystem does not support that request.
- **Cloud profile:** `PostgreSQL 16` (`synchronous_commit = on`, `fsync = on`,
  `LC_COLLATE = C` / UTF-8 bytewise collation parity, `fillfactor = 70` on
  `spaces` and `fillfactor = 80` on `note_heads` to preserve PostgreSQL HOT
  updates without indexing `last_seq` or `updated_seq`) paired with
  `S3ChunkedV1` over `rustls` (`ring`) and pure-Rust `AWS4-HMAC-SHA256`.
  Startup requires server-wide `fsync=on` before creating or migrating the canonical
  schema. Keep it enabled while the store is running. Every pooled session sets
  `synchronous_commit=on`. The D3 report records both observed settings.
  PostgreSQL TCP connections verify the server certificate against WebPKI trust
  roots and match its identity to the configured host, including loopback.
  Set the TCP transport's `root_cert` field to a PEM CA file to trust a private
  issuer. Local PostgreSQL fixtures connect through a Unix socket.

`CanonicalRuntime::open` acquires lifetime `DataRootOwnerLock` guards where
local storage is used, verifies or bootstraps the schema transactionally,
reconciles interrupted collaboration room fences and resumes any interrupted
purge closure before returning `(CanonicalStore, CanonicalRuntime)`.
If recovery fails, opening cancels its workers and releases local ownership
before returning the error. Dropping an opening future schedules the same
shutdown on its Tokio runtime. The DataRoot stays locked until the workers and
connections close. Once shutdown starts, the store completes this cleanup even
if the caller stops waiting. The next opener resumes pending durable recovery.
A retained canonical backup handle can outlive shutdown. The store closes its
SQLite files or dedicated PostgreSQL sessions and releases its temporary spool
files and publication lock before handing over the DataRoot. The backup's
witness remains available through the snapshot handle.
The Tokio runtime that opens the store owns PostgreSQL pool returns, native
SQLite blocking reads and interrupted SQLite snapshot cleanup. Shutdown closes
native reader admission and waits for outstanding connections before releasing
the DataRoot lock. A cancelled SQLite reader holds its WAL registration and
pool permit through connection close. Keep the runtime
running through shutdown. Callers on other runtimes can release their
handles or stop their runtimes while the store continues serving requests.
`CanonicalStore` is a cloneable handle that never exposes raw SQL pools or
connections. Integration tests use a development dependency on their own package
to enable the `test-support` Cargo feature for raw diagnostics and fault injection.
The store implements
`NoteWritePort`, `ChatPort`, `ContentJobPort`,
`ChangeBroadcast` and `BackupParticipantPort`, alongside canonical point reads
(`get_note`, `hydrate_cards`, `read_ability_resource`, `read_changes`,
`recent_activity`), `move_board_card`, `rollback_agent_run`,
`accept_external_observation`, and peer session/job persistence. Full query
planning (`NoteReadPort::list_notes`), `ViewGraphPort` and `SearchPort` remain
owned by downstream projection and search crates.

In PostgreSQL, creating a Space grants its initial writer epoch to the
provisioning runtime when storage receives the commit acknowledgement, even if
the caller has already left. If the database acknowledgement itself is lost,
direct creation reports an unknown outcome with no automatic retry. The
catalog command can replay its durable receipt. Replaying the receipt does
not issue a writer grant. Opening an existing database permits reads. To take over
writes after a restart or failover, the trusted lease owner calls
`advance_space_lease` with `ServicePurpose::Revocation` and an epoch greater
than the persisted one. The successful transition grants that epoch to the
calling runtime and resumes pending storage erasure for the Space. Cancellation
or deadline expiry before commit leaves the epoch unchanged. During commit the
outcome can be unknown. The initiating runtime publishes the grant only after
acknowledgement. Retrying the same epoch is safe on that runtime. A runtime
without a confirmed grant must request a higher epoch if the database already
contains the requested value. After acknowledgement, expiry or cancellation
returns the granted epoch while the store continues recovery. Concurrent retries
on the owning runtime share one recovery. A permanent recovery failure ends the
worker and is logged; callers still waiting receive a non-retryable failure for
the combined operation. The confirmed epoch stays in force. A failed physical retirement keeps
its durable ID. If a filesystem entry blocks deletion, its worker retries with
backoff while other restored Spaces continue. Invalid stored retirement metadata
stops the worker. After repairing the metadata, the owning runtime can retry
recovery by submitting the same epoch. A restore
grants the epoch of the new history to its restoring runtime. A process that
lost its grant must obtain a new one before writing again. Local SQLite
recovers writes under its exclusive DataRoot owner lock.

## Dual-dialect schema and history model

Both SQL dialects materialize the same ordinary B-tree tables in schema
version `7` and verify live database catalogs (`sqlite_master` / `pg_catalog`)
against a shared typed manifest checksum (`schema_meta`) on every startup.
Unknown newer schema versions, mismatched manifest checksums or unfinished
migration states fail closed.

The canonical store implements `ControlCatalogPort`. Account provisioning and
lifecycle changes store a compact receipt keyed by owner, actor and command key
in the transaction that changes the Space. Receipts retain the request digest
and resulting Space identity, history and cutoff, including after restart.
The caller can replay a pending control operation after losing the canonical
response. Reusing the key with a different payload is rejected. Rebinding a
Space's history invalidates receipts issued for its earlier incarnation.

Schema version 7 adds the CAS quarantine stamp and its partial index. It also
adds the archive artifact registry and the Space privacy generation. Previously
unowned entries retain their pending cleanup obligations across the upgrade.
New ordinary orphans go through quarantine, with a grace period of 24 hours
and 5 minutes. Explicit redaction and purge use the durable retirement protocol.

Schema version 6 orders the existing retirement index by status and then Space.
Both the installation-wide and per-Space pending checks can seek directly to
pending work as completed retirements accumulate. Startup rebuilds this index
in the same transaction that updates the schema witness.

Schema version 5 preserves the explicit payload-owner relation and places the Note after
the Space in its primary key. SQLite stores this table without a separate rowid tree. A
partial job index serves lookups from a job to its Notes. Purge clears ordinary receipt
pointers by the full receipt key. For imported Spaces retaining multiple incarnations,
it enumerates each distinct incarnation once by seeking through the receipt primary
index. A partial index holds exceptional historical pointers whose ID does not encode
their stored key. Expired receipts leave owners addressable without scanning unrelated
history.

Schema version 4 rebuilds the SQLite `blob_catalog` as a `WITHOUT ROWID` table
keyed by Space and digest. Both backends index blob references by Space and
digest for recounts, and by Space, owner kind and owner ID for purge. Upgrading
from versions 1 through 3 preserves active ownership and scrubs previously
invalidated chat summaries. A digest becomes eligible for retirement when the
last reference is removed.

Schema version 3 added a backup hold generation and a collaboration checkpoint
row keyed by Space and note. Upgrading from schema 1 or 2 keeps every stored
collaboration delta. A legacy snapshot has unknown coverage through its last
lease, so recovery establishes a new lease before advancing the checkpoint.
Rooms with legacy deltas or snapshots require carrier settlement. Both upgrades
run within the startup transaction and preserve the trailing snapshot BLOB.

Catalog reads use current grants and canonical folder ancestry. Keyset cursors
bind the catalog revision and filters. Account and project memory categories
identify stable AgentMemory notes in the personal root or project folder.
Published ability manifests expose up to 256 auxiliary names of at most 1024
UTF-8 bytes each. Access to an exact package revision requires visibility at
publication and at its current location. Resource reads check both locations
again after fetching the content. Catalog lookups return metadata and keep
branch taint unchanged.

Upgrading the recognized version 1 manifest adds the receipt ledger and queued
chat-input provenance in one transaction. Existing pending private inputs are
conservatively marked as externally tainted and consumed input bodies are cleared.
The upgrade preserves existing command hashes and responses. Both note-write
entry points can return the original receipt for a version 1 create or edit.
For an old batch create, the immutable creation revision supplies the parent
and document class omitted from its hash. For an edit, the store validates
the patch against its recorded base and checks the resulting content digest.
The old batch format identifies the edit by its note and before/after digests.
A supplied revision must match the recorded parent revision. Old edits have
no witness for lease or lineage preconditions, so a retry that supplies either
is rejected. Replaying a retained receipt requires current authorization and
the historical evidence above. The note head keeps its current revision.
Mutation conflicts carry a current revision or room details only after the
store checks the caller's access to that resource. Batch items use the same
rule under their writer savepoints.

- **Scoped history:** Every Space owns `(SpaceId, HistoryIncarnation)` and a
  stable root `FolderId` (`parent = None` normalizes to `root_folder_id`).
  `SpaceSeq` is checked against signed 64-bit bounds without wrapping.
- **Immutable revisions and command-end cuts:** `revisions` stores complete
  immutable MessagePack metadata snapshots (`RevisionMetadataEnvelope`) for
  notes, folders, schemas, ability packages, view rank overlays and chat
  threads. Every row written by an atomic command shares `visibility_seq` equal
  to that command's `CommandSeqRange::end()`. Historical reads select
  `visibility_seq <= cutoff` via `(space_id, entity_type, entity_key, visibility_seq DESC)`
  after verifying that `cutoff` is `0`, `spaces.last_seq` or a committed
  `change_commands.last_seq`; mid-command cutoffs return `InvalidCutoff`.
- **Gapless change log and erasable payloads:** `change_log` records gapless
  ID-only envelopes across `[1, last_seq]`. Bounded semantic overlays
  (`EffectEnvelopeV1`, at most 8 notes and `<= 64 KiB`) live in erasable
  `change_payloads` indexed by `payload_owners (space_id, note_id, payload_kind, payload_id)`.
- A scoped change feed checks current authority and the command-end location
  and class of each resource. A Board rank also requires access to its View.
  Scoped subscribers receive `AwaitProjection` for a multi-note overlay. Their
  cursors and safe acknowledgments still advance across all scanned events.
- Historical carriers and hydrated cards retain both the recorded and current
  access facts. Search, projection and provider egress require an active
  document at both boundaries. An authorized explicit read can still open a
  retained revision after the note moves to Trash.
- PostgreSQL subscribers check their Space's durable head once per second while
  waiting for a notice. Local commits still wake subscribers immediately. A
  changed incarnation or erased payload directs the subscriber to resynchronize.
- **Trailing large BLOBs:** `collab_sessions` places `yrs_snapshot_blob` as the
  final column so room-state and lease precondition checks read inline tuple
  headers without traversing overflow pages.

## Content-addressed storage and crash-safe purge

Logical blob identities are 32-byte `BLAKE3` digests over raw uncompressed
bytes, compressed with Zstd level `3` and tracked per Space in `blob_catalog`,
`blob_publications`, `blob_parts` and `blob_references`.
Each retained owner that refers to a publication contributes a reference row.
Multiple revisions can therefore share one stored blob. The writer updates the
catalog count and its references in one transaction. Purge can release the
erased owner's references by key, and recovery can check the count against
the surviving references. The reference index grows with retained ownership.

In a physical sizing fixture with 50,000 notes in 64 Spaces, 20 retained
revisions per note produced one million owner rows. The table and its three
indexes occupied 537.7 MiB on SQLite 3.51.3 and 585.5 MiB on PostgreSQL
16.16. The indexes accounted for 331.6 and 348.5 MiB, respectively.
Both engines used the owner index to release one note's 20 references and
the digest index to count the surviving references. Blob data, other
relations, WAL and backups require additional disk space.

### `LocalZstdV1`

Local blobs live under `blobs/<space_id>/<aa>/<blake3_hex>.zst` via
capability-confined `cap-std` directory handles (`O_NOFOLLOW` / symlink
rejection on every component):

1. Stage compressed frame into same-filesystem `blobs/.staging/*.tmp` and flush
   file data (`fdatasync` / `F_FULLFSYNC`).
2. Atomically `rename` into `blobs/<space_id>/<aa>/<hex>.zst`.
3. Coalesce and `fsync` modified shard/staging directories before SQL `COMMIT`.

Reads verify regular-file metadata, compressed frame integrity, uncompressed
byte length and full `BLAKE3` digest; unreferenced corrupt staging remnants are
quarantined under `blobs/.quarantine/<space_id>.<digest>.corrupt`. Retirement
erases the live file and its quarantined copy. A directory enters the shard cache
only after its parent directory has been synced.

### `S3ChunkedV1`

Cloud blobs decouple logical `ContentDigest` from physical object keys so
retirements and re-uploads never collide:

- Raw payloads are split into independently Zstd-3-compressed chunks of at most
  `4 MiB` raw bytes (an empty payload produces one valid 0-byte Zstd frame).
- Each publication receives a unique `publication_id` and registers immutable
  part keys (`<prefix>spaces/<space_id>/cas-v1/<publication_id>/<part_index>`) in
  PostgreSQL *before* issuing external `PUT` requests.
- Every data `PUT` requires `If-None-Match: *` with signed `Content-Length` and
  `x-amz-content-sha256`. Multipart upload APIs and `CopyObject` are never used.
  On `412 Precondition Failed` or ambiguous transport EOF, the adapter performs
  an origin `GET` and cryptographically verifies the stored frame before sealing.
- Two bucket modes are supported (`NeverVersioned` and `Enabled`); `Suspended`
  bucket versioning is rejected fail-closed, and startup runs a conditional
  write conformance probe (`If-None-Match: *` duplicate `PUT` must reject).
  Startup sends each conditional write once. A transport interruption during
  the origin read of that probe key allows one repeat within the original GET
  timeout. An unexpected HTTP status or payload fails the probe immediately.
- During retirement, the publication transitions to `Retiring`, blocking new
  part registrations or reference binds, writes a permanent nonsecret normal
  object (`NOTARIUM_RETIRED_BLOB_V1`) over every registered part key (including
  registered-but-unsent keys) instead of relying on S3 `DeleteMarker`s, and—on
  `Enabled` buckets—enumerates `ListObjectVersions` to issue exact `versionId`
  `DELETE` calls for prior data versions while preserving the terminal marker.

If versioning changes during retirement, the operation stays pending. After a
restart with the detected `Enabled` mode, the writer resumes from the durable
retirement record and verifies removal of every data version. Objects written
before versioning was enabled can have the explicit S3 version ID `null`; their
removal uses `DELETE ?versionId=null` and preserves the terminal marker.
An explicit never-versioned policy requires reconfiguration before takeover of
a bucket that has since enabled versioning.

### `Purge` and `MintAndPurge`

Irreversible erasure executes as a crash-recoverable 3-phase protocol:

1. Commit durable `revision_purge_fences` and `pending_purges` (plus the atomic
   encrypted replacement note in `MintAndPurge`) while rejecting active backup
   holds in the same Space lock.
2. Physically erase owned rows and blobs across `revisions`, `note_aliases`,
   `collab_sessions`, `collab_update_log`, note-derived `content_jobs`,
   `materialized_observations`, `change_payloads` (`erased_by_purge = 1`, which
   surfaces `PurgeResync` to lagging consumers without breaking `change_log`
   continuity), sanitize `command_receipts`, and complete local unlink +
   `secure_delete = ON` overwrite or S3 retirement fencing.
3. Mark `pending_purges` completed (`revision_purge_fences` remain permanently
   enforced ahead of historical reads, cold seeds and card hydration). SQLite
   startup resumes pending purges and standalone blob retirements. For an
   existing PostgreSQL Space, the incoming writer must acquire a higher epoch
   with `advance_space_lease`. The caller waits for recovery within its budget.

Shared blobs that remain referenced by independent live notes or chat entries
retain their active references, and historical external backups created prior to
purge remain outside online storage erasure.

## S3 compatibility matrix and release acceptance

A single pure-Rust S3 adapter supports configurable endpoint, region, bucket,
path-style or virtual-hosted addressing, static or session-token credentials and
custom root CAs without per-provider forks.

| Tier | Services | Status and protocol notes |
| --- | --- | --- |
| Mandatory release targets | Amazon S3 (general-purpose), MinIO Community (`RELEASE.2025-10-15T17-29-55Z`, commit `9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a`), Yandex Object Storage | Offline CI runs against the source-built MinIO Community fixture and deterministic delayed-I/O fault doubles. Upstream `minio/minio` was archived on 2026-04-25; commercial MinIO AIStor is a distinct edition and does not substitute for CE verification. Live cloud release claims for AWS S3 and Yandex Object Storage require running `live_s3_acceptance` against disposable buckets. |
| Primary self-hosted & cloud research candidates | Ceph RGW, SeaweedFS, Garage, RustFS, Cloudflare R2, Backblaze B2, Wasabi, DigitalOcean Spaces, Hetzner Object Storage, OVHcloud Object Storage, Scaleway Object Storage, Selectel S3, VK Cloud Object Storage, Timeweb Cloud S3, Akamai/Linode Object Storage, Tigris, Vultr Object Storage, IDrive e2 | Research coverage motivating `S3ChunkedV1` design (for example, Garage and R2 motivate first-class `NeverVersioned` support; Hetzner documents that conditional writes are unsupported on versioned buckets; Scaleway's non-conditional multipart parts motivate single-`PUT` chunking). Each candidate requires release-pinned runtime verification before claiming production support. |
| Extended enterprise & gateway inventory | IBM COS, Oracle OCI, Alibaba OSS, Tencent COS, Huawei OBS, Storj, IONOS, Cloudian HyperStore, Scality RING/ARTESCA, NetApp StorageGRID/ONTAP S3, Dell ECS/ObjectScale, Pure FlashBlade, OpenStack Swift+s3api, Apache Ozone S3 Gateway, Supabase Storage S3 API | Tracked in compatibility architecture; gateway layers (Ozone, Supabase, Swift+s3api) require independent verification from underlying object stores. Google Cloud Storage XML interoperability and Azure Blob are separate non-generic profiles. |

Without live credentials, `live_s3_acceptance` never reports `PASS`; it prints a
structured JSON report with `"status": "UNVERIFIED"` and exits with code `2`:

```sh
sh .devkit/runtime/devkit.sh cli exec --component apps/api --network none -- \
  cargo run --locked --offline -p notarium-canonical --example live_s3_acceptance
```

To execute live disposable-bucket certification (with `--network bridge` and
dedicated non-production `NOTARIUM_LIVE_S3_PROVIDER`, `NOTARIUM_LIVE_S3_ENDPOINT`,
`NOTARIUM_LIVE_S3_REGION`, `NOTARIUM_LIVE_S3_BUCKET`, `NOTARIUM_LIVE_S3_BUCKET_MODE`,
`NOTARIUM_LIVE_S3_ACCESS_KEY_ID`, `NOTARIUM_LIVE_S3_SECRET_ACCESS_KEY`, and
optional `NOTARIUM_LIVE_S3_PREFIX` / `NOTARIUM_LIVE_S3_SESSION_TOKEN`), run the
same example against an isolated prefix.

## Batch writer, WAL coordinator, domain invariants and backup

- **`WriteBatchActor`:** Bounded mailbox (`4,096` commands / `256 MiB` staged
  bytes) flushes every `2 ms` or `64` items without waiting for a minimum batch
  at low load. Phase 1 performs parallel syntax parsing, patch application,
  Zstd-3 compression and CAS staging. Phase 2 executes one SQLite writer
  transaction (or per-Space serialized PostgreSQL batch transactions under
  `SELECT ... FOR UPDATE` on `spaces` and `active_epoch` lease checks) with
  per-item `SAVEPOINT` isolation so domain conflicts roll back only the failing
  item without creating `SpaceSeq` gaps. Preceding items in the same batch
  advance a virtual per-Space `effective_cut` immediately, preventing intra-batch
  semantic phantoms.
  A filename pin reported by the registered room owner defers the same fresh
  note move through either entry point. A retained move receipt can still be
  replayed. Metadata-only moves preserve an unpinned room's carrier lineage.
  For accepted mutation shapes the writer binds applicable predicates and
  canonical input to the caller's command hash. Single and batch forms share
  that fingerprint. Reusing the key with different supported predicates returns
  `IdempotencyKeyReused`. An older receipt may supply an omitted revision from
  immutable command history. A supplied room lease or lineage needs a matching
  stored fingerprint. Old ambiguous rename titles require the recorded operation.
  An old rollback receipt also requires a unique typed interpretation of the
  entity and board IDs in each record. See the mutation preconditions in
  [Core contracts](core-contracts.md#mutation-preconditions).
  A batch note edit uses its requested base digest and the head visible at its
  savepoint. Link appends derive their base from the current source. `link_many`
  submits distinct sources together and starts a new transaction when a source
  repeats. An admitted item or group stays with the actor when cancellation or
  a deadline ends the caller's wait for its acknowledgement. An unavailable
  reply has an unknown commit outcome. A group can be retried by key when
  every item has an idempotent identity. Link, memory append, schema publication and
  room carrier settlement share a caller deadline across lookup, payload
  preparation and writer acknowledgement. A purge interrupted after its
  logical deletion retains its recovery record for retry.
  Auxiliary room transitions accept commit permission once, after their
  transactional checks and immediately before SQL commit. Expiry, cancellation
  or caller drop before that point rolls back the transition. After that point
  the runtime owns commit and fence synchronization. A caller that loses the
  reply reconciles the session or lease before issuing another command. If a batch encounters an operational
  error after any successful item, or an item's commit outcome is unknown,
  retry with the same command keys.
  The returned commit effect is `Unknown` in both cases.
- On Linux, canonical SQLite requests the no-access-time inode flag on the
  managed `v1/` database directory before opening the database. On ext4,
  newly created files inherit it, including WAL and shared-memory sidecars.
  Existing files keep their individual timestamp policy. Filesystems that
  decline the request use their normal timestamps. To inspect the deployed
  policy on ext4, run `lsattr -d` on the directory and its database files.
- **`SqliteWalCoordinator`:** Ordinary reads enter through a bounded reader gate
  with a monotonic `< 250 ms` progress-handler deadline (`248 ms` default) and
  guaranteed worker-snapshot rollback/close if a caller drops its future.
  Native reads use the caller budget while waiting for a worker and while verifying
  CAS bytes after commit. While a SQL snapshot is open, an eager local blob
  read tries both the registry shard and the digest guard. Contention defers
  the verified blob read until after the snapshot closes. The ordinary path
  waits asynchronously for the registry and digest. Returning the connection
  to the pool revokes that checkout's interrupt handle. A background loop runs `PASSIVE` checkpoints during idle ticks (`15 ms` cadence)
  and uses a 250 ms budget to drain readers and acquire the writer for a
  `RESTART`/`TRUNCATE` checkpoint (512 MiB soft / 896 MiB high watermarks).
  An explicit caller deadline includes admission, checkout, and the read itself.
  Without one, the default allows one configured reset interval plus one read
  interval (498 ms by default). Once admitted, the no-budget path allows at most
  one read interval for checkout and SQL. The active snapshot retains its own cap.
  Reader admission reopens when the checkpoint finishes or the reset budget
  expires. A slow checkpoint retains its writer connection and safe point until
  SQLite returns. The store finishes an admitted manual checkpoint even if the
  requesting task is cancelled. SQLite coordinates new readers with the
  active checkpoint.
  `WalTelemetrySnapshot.max_reset_reader_gate_ns` records the actual admission
  pause and `reset_gate_overruns` counts closures over budget.
- **Hierarchy, boards and semantic rollback:** `MoveFolder` updates only the
  moved folder row (`0` descendant row writes) under cycle checks and per-Space
  serialization. Same-depth and upward moves check the two ancestor paths.
  Moving deeper also probes indexed children until the first path that would
  exceed 256 levels. `move_board_card` maintains `<= 16`-byte `sort_rank_lexo` keys
  via windowed Packed Memory Array (PMA) rebalancing that updates physical
  `rank_rev_id` without overwriting semantic `placement_revision` provenance.
  Rollback spends one caller budget across room reservations, Board planning,
  retries and writer admission. The direct PostgreSQL path includes the writer
  safe point, connection checkout and SQL in that budget. Planning reads also
  respect the configured read timeout. Cancellation before writer admission
  leaves the command uncommitted. A queued command can finish after its caller
  stops waiting. An ambiguous acknowledgement returns `Unknown`. Retrying with
  the same command identity recovers the durable outcome. On the direct
  PostgreSQL path the writer gate and room fences cover the outstanding COMMIT.
  Pools with at least three connections can retain one idle rollback session
  across Spaces to reuse database plans. A successful rollback returns that
  session to the cache after COMMIT acknowledgement. Shutdown drains the cache.
  `rollback_agent_run` freezes eligible targets and closed-room reservations
  before planning, simulates inverse board moves in reverse command order over
  recorded semantic before-anchors, and applies `Trash`-first slug deconfliction
  atomically. Restoring a note to a different folder requires write access to
  both its current and restored placement and document class. For user
  documents directly under the root, PostgreSQL reads each current head
  alongside its pre-run revision and candidate blob publication. The commit
  locks the Space and rechecks the writer epoch, run revision, expected
  heads, root permissions and live publications.
- **Collaboration room ownership.** A PostgreSQL writer takeover fences active
  rooms in the same transaction that advances the Space writer epoch. The
  successor can reopen a fenced room with its new lease and replay its durable
  updates. Checkpoint and close compact the update log only when the caller
  supplies a snapshot and its inclusive `compacted_through_update_seq`. Omitting
  the watermark preserves the log, including updates accepted before a close.
  A watermark advances in lease and update sequence order. An equal watermark
  accepts only the same snapshot bytes. Reopening preserves the stored snapshot.
  After recovery, sequence zero in the new lease can cover all updates from
  earlier leases. The room owner must first replay those updates into its snapshot.
  Direct carrier changes, including schema-note changes, wait until an authorized
  settlement pairs the snapshot with the canonical carrier and covers the last
  pending update. A clean close permits direct changes to start a new lineage.
  The storage executor owns admitted work. If the database loses a COMMIT reply,
  it retains the affected room lock until a fresh transaction verifies the durable
  lease under the Space lock. Unrelated rooms keep their own fences.
- **Job pagination.** `list_jobs` binds each cursor to the original Space cut.
  Continuation returns `CursorStale` if the cut advances or a heartbeat changes
  progress visible to the query. Consumers can open a new read at the current cut.
- **Chat DAG and pending queue:** `chat_entries` stores `<= 512`-byte UTF-8
  messages inline and `> 512`-byte payloads in verified CAS. Each
  `stage_chat_blob` call records a per-author lease with its provenance, including
  when several calls stage the same digest. Append consumes the specific lease.
  When a caller leaves during COMMIT, storage releases its undelivered lease and
  retires the content if the last owner has gone. Shutdown or a process crash can interrupt
  this handoff. The original grant can call `next_staged_chat_blob` with its
  request ID, content digest and matching provenance to recover each outstanding
  lease, then append it or release it with `discard_staged_chat_blob`. A repeated
  release is safe. Existing leases remain consumable with their original tokens.
  Legacy leases with unknown provenance count as externally tainted. A leaf window follows at most one parent per returned entry and issues
  zero writes. For a distant `before` cursor, ancestry validation first walks
  fixed jumps of 256 levels, then 16 levels, then individual parents. For a
  depth difference `d`, this takes up to `d / 256` full jumps plus at most 30
  shorter hops before reading the requested window. `chat_pending_inputs`
  enforces a 16-item per-thread queue (`Full` without a mutation receipt on the 17th item). Queue admission checks the
  thread, write authority and available space before staging a large body and
  again at commit. Local publication follows admission. For S3, each new upload
  records its own cleanup intent before the first conditional PUT. The winning
  bind removes that intent atomically. The store's executor cleans up abandoned
  uploads even when a caller closes its executor. A lease takeover adopts
  older private uploads. Retrying the same lease leaves that generation's
  active uploads with their owners.
  `redact_chat_entry` applies the same thread and taint checks on first execution
  and replay. It erases target entry content, preserves DAG ancestry and
  clears the stored bodies and CAS references of dependent `Compaction` entries.
  Direct reads, history windows and command replay suppress stale summaries.
  An independent entry that owns the same digest keeps its content. Removing the
  last owner closes peer reads and records retirement in the redaction transaction.
  An active backup hold or local staging ticket can retain the physical bytes.
  The committed receipt remains available within the caller's remaining budget.
  Retries share the same retirement worker for a given history, lease epoch and
  retirement ID. The store recovers outstanding work after restart or takeover.
  Taint is monotonic.
- **Paired backup (`BackupParticipantPort`).** Prepare both participants and acquire
  their holds before pausing control, then canonical. PostgreSQL uses a dedicated
  connection to fence writers across runtimes sharing the canonical schema. Pin
  both snapshots before resuming either writer. A Space created between hold
  acquisition and pin requires a new backup attempt. Keep the canonical hold
  through the CAS copy and await successful hold release before committing the
  paired backup. Losing the PostgreSQL hold session invalidates the attempt,
  including an external CAS copy already in progress. Each acquisition uses
  a new generation, so a disconnected owner cannot release its successor.
  Each canonical Space holds its own history cursor. The artifact records the
  combined witness once. Source-local holds expire with their owner and are
  omitted from restored data. SQLite copies 16 pages per step and releases an
  idle cut when its deadline or logical WAL retention budget expires. Reusing
  already allocated WAL space still consumes that budget. PostgreSQL streams cursor
  rows in slices of up to 64 KiB. Both participants release their source after
  durable spool or abort. A canonical artifact ID resolves on its original spool
  volume, where lookup checks file size and BLAKE3 before returning the path.
  Startup reconciles abandoned holds and pending local artifacts. PostgreSQL
  maintenance also reaps holds whose ownership lock was lost. An unacknowledged
  hold commit is reconciled using its exact generation once the old session ends.
  The offline `notarium_canonical::backup::decode_postgres_spool_v1_bounded`
  API verifies the trailer and recognizes the exact manifests for schemas 1 through 7.
  It returns typed rows in the original table and column order within the
  caller's byte budget. To materialize a historical spool, create an empty
  target with `schema::POSTGRES_BASELINE_DDL`. For versions 1 and 2, drop
  `collab_checkpoints` and `backup_holds.owner_generation`. For version 1,
  also drop `account_catalog_receipts` and `chat_pending_inputs.ext_space_tainted`.
  For versions 1 through 4, drop `idx_receipt_exception_pointer` and
  `idx_payload_owners_job`, and restore the `payload_owners` primary key to
  `(space_id, payload_kind, payload_id, note_id)`.
  For versions 1 through 3, restore the predecessor index layout on
  `blob_references` using `tests/fixtures/schema-v3-reference-index.sql`
  in the canonical crate. Call `decoded.import_rows(&mut transaction)` and
  commit the transaction. The importer writes decoded rows into their target
  tables one row at a time. For folder heads and chat entries it first fills a
  temporary table, then inserts the full set in one statement so foreign keys
  can resolve parents that appear later in the archive.
  Opening the target with the original installation ID applies the remaining
  migrations through version 7. The canonical L4 backup suite exercises the
  historical row importer and the schema migration path. The streaming
  `notarium-jobs` restore handles installation cutover and repository-level
  verification. See [archive jobs and recovery](archive-jobs.md).
  Before serving the restored database, call `restore_cursors` with each
  original cutoff and a fresh history incarnation. The same transaction
  rotates the writer epoch and fences active rooms, retaining their snapshots,
  lineages and unapplied updates for explicit recovery. An interruption before
  COMMIT has effect `NotCommitted`. During COMMIT it has effect `Unknown`;
  inspect the persisted incarnation before deciding whether to retry. The
  runtime publishes its new writer grants and room fences after the database
  acknowledges the commit, including when the requesting future was dropped.

## Offline fixture lifecycle and attributed benchmarks

`make setup` pulls the digest-pinned `postgres:16-bookworm` image, builds the
pinned MinIO Community image from source (`RELEASE.2025-10-15T17-29-55Z`, commit
`9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a`) and builds the `#![forbid(unsafe_code)]`
Unix-socket-to-loopback S3 bridge (`compose.storage-tests.yaml`). `make test`
starts an isolated per-run fixture stack (`--network none` / internal namespace)
mounted over `.artifacts/storage-tests/<run>/` Unix domain sockets and tears it
down automatically via signal/exit traps. Integration tests fail closed if
fixtures are absent.

The test and benchmark commands hold one checkout-wide fixture lock from startup
through cleanup. Other checkouts can run independently.

### Reproduce the storage measurements

Run the full release suite with

```sh
sh docker/storage-fixtures/with-storage-fixtures.sh benchmark
```

For full-note storage interaction timings, run

```sh
sh docker/storage-fixtures/with-storage-fixtures.sh benchmark --interactions
```

Each series uses SQLite or local PostgreSQL 16 with a local blob store. One
unpaced worker or eight workers with independent 4 KiB Markdown notes and a
100 ms think time open the latest note, edit with its revision precondition,
and verify the complete carrier with the new receipt. The save includes patch
preparation, CAS staging and durable acknowledgment. Three fresh series per
combination have a 3 s warmup and 30 s measured window. Cycles admitted before
the window closes may finish afterwards. A failed worker stops, surviving
workers continue, and every later series starts independently. Each series also
closes and reopens storage to verify every confirmed head outside the timers.
The report in `.artifacts/storage-interactions/` links raw per-cycle timings
and faults, and reports nearest-rank p95/p99 for all attempted and successful
stages. Compare the same executable hash across stands. These measurements
cover the canonical storage ports on the local machine.

The command builds `fitness-gates` with the `storage-bench` feature and the
same `mimalloc` allocator as both runtime binaries. It checks the source tree
before and after measurement and writes
`.artifacts/3-storage-cas/d3-benchmarks-<tree>.json`. Use
`benchmark --smoke` for a shorter diagnostic run or `benchmark --paired-only`
to measure just the paired backup participants. A run with uncommitted source
records the exact Git tree and base commit. Its `git_commit` is null.
To qualify one reference system, choose its tier explicitly. Run three full
release series on that system with the same source tree and configuration.
Keep the launcher log and exit code for every attempt.

```sh
tier=medium
mkdir -p .artifacts/3-storage-cas
campaign=$(mktemp -d ".artifacts/3-storage-cas/${tier}-campaign.XXXXXXXX") || exit 1
printf 'Logs: %s\n' "$campaign"
failed=0
for series in 1 2 3; do
  rc=0
  sh docker/storage-fixtures/with-storage-fixtures.sh benchmark --tier "$tier" \
    >"$campaign/series-$series.log" 2>&1 || rc=$?
  printf '%s\n' "$rc" >"$campaign/series-$series.exit"
  if [ "$rc" -ne 0 ]; then failed=1; fi
done
test "$failed" -eq 0
```

Use `tier=high` for the High reference. Each completed tier run retains
`.artifacts/3-storage-cas/d3-benchmarks-<tier>-<tree>-<fixture_run_id>.json`.
Compare the same `environment.git_tree`, `rollback_tier` and three distinct
`environment.fixture_run_id` values. All three full reports must pass to
qualify the complete suite. For rollback acceptance inspect each of the three
reports individually, including its completed sample counts, room restorations,
cutoff read deadlines and the strict p95 limits for both local CAS profiles.
The full report records the selected rollback, writer, chat and confirmed-pause
thresholds in `applied_limits`. Every profile contributes to the full suite status.
A launcher failure before the final report leaves the attempt incomplete.
Keep its log and exit code and run another full series to obtain three
complete measurements. Retain every completed numerical failure.

The JSON records launcher and
benchmark-container cgroup limits separately, alongside observed PostgreSQL
socket round-trip latency, filesystem, database settings, cardinalities and
p50/p95/p99. An unavailable controller is recorded as `unknown`. A completed measurement that misses a target writes a report
with `FAIL` and returns a nonzero status. A board or folder storage error
ends that profile and later profiles still run. Its `failure` records the
stage, the one-based move number when applicable, and the storage diagnostic.
A board verification failure after commit also records the receipt sequence.
Board and folder latency includes verified successful moves. Empty writer,
board and folder latency distributions serialize as null.

For the SQLite writer, `measured_mutations` counts successful edits that both
start and return during the measurement window. Throughput divides that count
by `measured_secs`. The latency distributions follow every edit started
during the window until it returns, including edits that finish during drain.
`admission_to_receipt` includes successful edits. `all_measured_edit_attempts`
also includes failed edits. Warmup admissions belong to neither distribution,
even when they finish during measurement. The counts for a latency distribution
and for throughput can therefore differ. Any reader or writer error in any
phase fails the profile. The report counts every error by code and start/end
phase and retains up to eight detailed examples per operation type.

| Workload | Release profile and target |
| --- | --- |
| SQLite writer | 50 writers with either 0 or 200 readers, unique 4 KiB edits, 10 s warmup + 30 s measurement, 3 runs each. Every run must exceed 1,600 confirmed mutations/s on Medium or 2,000/s on High and default, with zero reader, writer or busy errors. Each mixed run also requires completed reads. The report samples the active batch writer's synchronous setting and journal size limit and records reader gate dwell. |
| Rollback | Fresh run, history and revisions for every sample. The Space also has an unrelated folder. Seed 18 edited notes, 2 creations, 1 deletion with a slug collision and 1 subsequent manual edit through the public ports before starting the timer. Open and cleanly close a room on each of the 17 edited notes eligible for restoration. After timing, verify that every room retains its lease, advances exactly one lineage and points at its returned restore revision. Require a new rollback receipt above the pre-call Space sequence. At that receipt, verify that each revision references its original revision and content digest, then read and hash the original carrier through the note API. The `verified_closed_room_restores` counter includes successful checks for measured samples and excludes the warmup. Across 1,000 samples the default requires p95 below 5 ms for SQLite and PostgreSQL with local CAS. High requires <4 ms for SQLite and <5 ms for PostgreSQL, Medium <10 ms and <15 ms respectively. Each profile records its exact `p95_limit_us`. The compatibility field `enforce_5ms_budget` is true for limits of 5 ms or tighter. The test-only lookup of the expected run revision uses the fixture's 30 s call budget while waiting for admission before the timer starts. Its active SQL snapshot keeps the ordinary deadline. The separate 200-sample PostgreSQL/S3 profile reports local UDS latency and has a null limit. |
| Chat window | 10,000 reads of 50 entries on each 10,000-turn thread, p95 below 0.5 ms on High or 1 ms on Medium and default. After 50 shared turns, the branched thread appends 16 turns at a time to each of nine branches in rotation. All nine measured windows cross at least two parent gaps containing 128 or more off-branch turns. A PostgreSQL read from a nonzero leaf with no pagination cursor follows parent keys and returns the authorized thread header and bounded window from one statement snapshot. Every timed read compares its full ordered sequence of 50 entries against append receipts. The smoke run uses the same topology with 512 turns and 200 reads per profile. Row triggers count writes across the canonical tables. |
| Board and folder | 10,000 first-slot board moves with ranks at most 16 bytes. After each move, compare its receipt result to the first ranked overlay and check every rank length. Each move over 100,000 seeded descendants alternates between two parents. After timing, verify the receipt sequence, durable parent and revision chain, every historical alias at its original parent and sequence, and zero descendant row writes. Only verified moves enter the latency distribution. A no-op update to one descendant verifies the write counter. |
| Paired backup | The control and canonical participants share an installation. Test 1 and 64 canonical Spaces separately on SQLite and PostgreSQL. For each profile, prepare both participants, acquire both holds, pause control then canonical, pin both snapshots, and resume both writers. Report prepare/holds, safe-point acquisition, confirmed pause after control acknowledges its safe point, and the inclusive interval from the first pause call through the last resume. The confirmed pause from the first safe point through both resume acknowledgements must reach p95 below 2.5 ms for PostgreSQL on Medium and below 1 ms for every other backend/tier combination, across 1,000 captures per profile. |

For reference machine results, candidate targets and the metrics that follow a
user action through the next component, see [Storage performance and integration targets](storage-performance.md).

### Proof boundaries

- **Process crash vs. power loss:** Automated `SIGKILL` tests prove process-crash
  recovery of `DataRootOwnerLock`, WAL replay, collaboration room fencing and
  interrupted `pending_purges`, alongside ordered `fdatasync` / directory `fsync`
  barriers. They do not substitute for physical power-cut hardware testing across
  filesystems or host operating systems.
- **Local UDS fixtures vs. remote cloud SLOs:** Offline UDS PostgreSQL 16 and
  MinIO Community fixtures certify protocol semantics, conditional-write fencing
  and local storage overhead without network flakiness; end-to-end cloud latency
  and provider certification require live runs against target cloud regions.
