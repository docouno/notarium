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
- **Cloud profile:** `PostgreSQL 16` (`synchronous_commit = on`, `fsync = on`,
  `LC_COLLATE = C` / UTF-8 bytewise collation parity, `fillfactor = 70` on
  `spaces` and `fillfactor = 80` on `note_heads` to preserve PostgreSQL HOT
  updates without indexing `last_seq` or `updated_seq`) paired with
  `S3ChunkedV1` over `rustls` (`ring`) and pure-Rust `AWS4-HMAC-SHA256`.
  PostgreSQL TCP connections verify the server certificate against WebPKI trust
  roots and match its identity to the configured host, including loopback.
  Set the TCP transport's `root_cert` field to a PEM CA file to trust a private
  issuer. Local PostgreSQL fixtures connect through a Unix socket.

`CanonicalRuntime::open` acquires lifetime `DataRootOwnerLock` guards where
local storage is used, verifies or bootstraps the schema transactionally,
reconciles interrupted collaboration room fences and resumes any interrupted
purge closure before returning `(CanonicalStore, CanonicalRuntime)`.
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
provisioning runtime. Opening an existing database permits reads. To take over
writes after a restart or failover, the trusted lease owner calls
`advance_space_lease` with `ServicePurpose::Revocation` and an epoch greater
than the persisted one. The successful transition grants that epoch to the
calling runtime and resumes pending storage erasure for the Space. A restore
grants the epoch of the new history to its restoring runtime. A process that
lost its grant must obtain a new one before writing again. Local SQLite
recovers writes under its exclusive DataRoot owner lock.

## Dual-dialect schema and history model

Both SQL dialects materialize the same ordinary B-tree tables in schema
version `3` and verify live database catalogs (`sqlite_master` / `pg_catalog`)
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

Schema version 3 adds a backup hold generation and a collaboration checkpoint
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
  `change_payloads` indexed by `payload_owners (space_id, payload_kind, payload_id, note_id)`.
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
   with `advance_space_lease`; that call resumes pending work before returning.

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
  A batch note edit uses its requested base digest and the head visible at its
  savepoint. Link appends derive their base from the current source. `link_many`
  submits distinct sources together and starts a new transaction when a source
  repeats. If a batch encounters an operational error after any successful
  item, or an item's commit outcome is unknown, retry with the same command keys.
  The returned commit effect is `Unknown` in both cases.
- **`SqliteWalCoordinator`:** Ordinary reads enter through a bounded reader gate
  with a monotonic `< 250 ms` progress-handler deadline (`248 ms` default) and
  guaranteed worker-snapshot rollback/close if a caller drops its future. A
  background loop runs `PASSIVE` checkpoints during idle ticks (`15 ms` cadence)
  and uses a 250 ms budget to drain readers and acquire the writer for a
  `RESTART`/`TRUNCATE` checkpoint (512 MiB soft / 896 MiB high watermarks).
  Once the filesystem flush starts, SQLite holds the gate until I/O completes.
  `WalTelemetrySnapshot.max_reset_reader_gate_ns` records the longest actual
  closure and `reset_gate_overruns` counts closures over budget.
- **Hierarchy, boards and semantic rollback:** `MoveFolder` updates only the
  moved folder row (`0` descendant row writes) under cycle checks and per-Space
  serialization. `move_board_card` maintains `<= 16`-byte `sort_rank_lexo` keys
  via windowed Packed Memory Array (PMA) rebalancing that updates physical
  `rank_rev_id` without overwriting semantic `placement_revision` provenance.
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
- **Job pagination.** `list_jobs` binds each cursor to the original Space cut.
  Continuation returns `CursorStale` if the cut advances or a heartbeat changes
  progress visible to the query. Consumers can open a new read at the current cut.
- **Chat DAG and pending queue:** `chat_entries` stores `<= 512`-byte UTF-8
  messages inline and `> 512`-byte payloads in verified CAS. Each
  `stage_chat_blob` call records a per-author lease with its provenance, including
  when several calls stage the same digest. Append consumes the specific lease.
  Legacy leases with unknown provenance count as externally tainted. The DAG
  maintains deterministic skip pointers at `depth - 16` and `depth - 256` so
  50-entry branch context reads execute in `O(window + log depth)` with `0`
  writes. `chat_pending_inputs` enforces a 16-item per-thread queue (`Full`
  without a mutation receipt on the 17th item). Queue admission checks the
  thread, write authority and available space before staging a large body and
  again at commit. Local publication follows admission. For S3, each new upload
  records its own cleanup intent before the first conditional PUT. The winning
  bind removes that intent atomically. A losing request or a replacement writer
  fences its registered keys while preserving other publications of the same digest.
  `redact_chat_entry` applies the same thread and taint checks on first execution
  and replay. It erases target entry content, preserves DAG ancestry and
  invalidates only descendant `Compaction` entries. Taint is monotonic.
- **Paired backup (`BackupParticipantPort`).** Prepare both participants and acquire
  their holds before pausing control, then canonical. PostgreSQL uses a dedicated
  connection to fence writers across runtimes sharing the canonical schema. Pin
  both snapshots before resuming either writer. A Space created between hold
  acquisition and pin requires a new backup attempt. Keep the canonical hold
  through the CAS copy and await successful hold release before committing the
  paired backup. Losing the PostgreSQL hold session invalidates the attempt,
  including an external CAS copy already in progress. Each acquisition uses
  a new generation, so a disconnected owner cannot release its successor.
  Source-local holds expire with their owner and are omitted
  from restored data. SQLite copies 16 pages per step and releases an idle cut
  when its deadline or WAL retention budget expires. PostgreSQL streams cursor
  rows in slices of up to 64 KiB. Both participants release their source after
  durable spool or abort. A canonical artifact ID resolves on its original spool
  volume, where lookup checks file size and BLAKE3 before returning the path.
  Startup reconciles abandoned holds and pending local artifacts.
  The offline `notarium_canonical::backup::decode_postgres_spool_v1_bounded`
  API verifies the trailer and recognizes the exact schema 1, 2 and 3 manifests.
  It returns typed rows in the original table and column order within the
  caller's byte budget. To materialize a historical spool, create an empty
  target with `schema::POSTGRES_BASELINE_DDL`. For versions 1 and 2, drop
  `collab_checkpoints` and `backup_holds.owner_generation`. For version 1,
  also drop `account_catalog_receipts` and `chat_pending_inputs.ext_space_tainted`.
  Import the verified rows in the same transaction. Opening the target with
  the original installation ID applies the version 3 migration. The canonical
  L4 backup suite exercises this procedure with archives from both exporters.

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

The command builds `fitness-gates` with the `storage-bench` feature and the
same `mimalloc` allocator as both runtime binaries. It checks the source tree
before and after measurement and writes
`.artifacts/3-storage-cas/d3-benchmarks-<tree>.json`. Use
`benchmark --smoke` for a shorter diagnostic run or `benchmark --paired-only`
to measure just the paired backup participants. A run with uncommitted source
records the exact Git tree and base commit. Its `git_commit` is null.
The JSON records launcher and
benchmark-container cgroup limits separately, alongside observed PostgreSQL
socket round-trip latency, filesystem, database settings, cardinalities and
p50/p95/p99. An unavailable controller is recorded as `unknown`. A completed measurement that misses a target writes a report
with `FAIL` and returns a nonzero status.

| Workload | Release profile and target |
| --- | --- |
| SQLite writer | 50 writers with either 0 or 200 readers, unique 4 KiB edits, 10 s warmup + 30 s measurement, 3 runs each. Every run must exceed 2,000 mutations/s and return zero busy errors. The report samples the active batch writer's synchronous setting and journal size limit and records reader gate dwell. |
| Rollback | Fresh run, history and revisions for every sample. The Space also has an unrelated folder. Seed 18 edited notes, 2 creations, 1 deletion with a slug collision and 1 subsequent manual edit through the public ports before starting the timer. SQLite and PostgreSQL with local CAS each require p95 below 5 ms across 1,000 samples. A separate 200-sample PostgreSQL/S3 profile reports local UDS latency. |
| Chat window | 10,000 reads of 50 entries on each 10,000-turn thread, p95 below 1 ms. The branched profile rotates across nine tips and checks that each result ends at the selected tip. Row triggers count writes across the canonical tables. |
| Board and folder | 10,000 first-slot board moves with ranks at most 16 bytes. Moving a folder over 100,000 seeded descendant heads must perform zero row writes to descendants. Triggers observe inserts, updates and deletes. A no-op update to one descendant verifies the counter. |
| Paired backup | The control and canonical participants share an installation. Test 1 and 64 canonical Spaces separately on SQLite and PostgreSQL. For each profile, prepare both participants, acquire both holds, pause control then canonical, pin both snapshots, and resume both writers. Report prepare/holds, safe-point acquisition, confirmed pause after control acknowledges its safe point, and the inclusive interval from the first pause call through the last resume. The confirmed pause from the first safe point through both resume acknowledgements must reach p95 below 1 ms across 1,000 captures per profile. |

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
