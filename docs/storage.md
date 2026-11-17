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

`CanonicalRuntime::open` acquires lifetime `DataRootOwnerLock` guards where
local storage is used, verifies or bootstraps the schema transactionally,
reconciles interrupted collaboration room fences and resumes any interrupted
purge closure before returning `(CanonicalStore, CanonicalRuntime)`.
`CanonicalStore` is a cloneable handle that never exposes raw SQL pools or
connections. It implements `NoteWritePort`, `ChatPort`, `ContentJobPort`,
`ChangeBroadcast` and `BackupParticipantPort`, alongside canonical point reads
(`get_note`, `hydrate_cards`, `read_ability_resource`, `read_changes`,
`recent_activity`), `move_board_card`, `rollback_agent_run`,
`accept_external_observation`, and peer session/job persistence. Full query
planning (`NoteReadPort::list_notes`), `ViewGraphPort` and `SearchPort` remain
owned by downstream projection and search crates.

## Dual-dialect schema and history model

Both SQL dialects materialize the same 34 ordinary B-tree tables under schema
version `1` and verify live database catalogs (`sqlite_master` / `pg_catalog`)
against a shared typed manifest checksum (`schema_meta`) on every startup.
Unknown newer schema versions, mismatched manifest checksums or unfinished
migration states fail closed.

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
quarantined under `blobs/.quarantine/`.

### `S3ChunkedV1`

Cloud blobs decouple logical `ContentDigest` from physical object keys so
retirements and re-uploads never collide:

- Raw payloads are split into independently Zstd-3-compressed chunks of at most
  `4 MiB` raw bytes (an empty payload produces one valid 0-byte Zstd frame).
- Each publication receives a unique `publication_id` and registers immutable
  part keys (`<prefix>/spaces/<space_id>/pubs/<pub_id>/part-<idx>.zst`) in
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
   enforced ahead of historical reads, cold seeds and card hydration). Startup
   automatically finishes phase 2/3 if a process crashed mid-purge.

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
- **`SqliteWalCoordinator`:** Ordinary reads enter through a bounded reader gate
  with a monotonic `< 250 ms` progress-handler deadline (`248 ms` default) and
  guaranteed worker-snapshot rollback/close if a caller drops its future. A
  background loop runs `PASSIVE` checkpoints during idle ticks (`15 ms` cadence)
  and executes a `< 250 ms` reader-gated `RESTART`/`TRUNCATE` reset when WAL
  growth crosses operational watermarks (`512 MiB` soft / `896 MiB` high,
  retaining `64 MiB` `journal_size_limit` at idle).
- **Hierarchy, boards and semantic rollback:** `MoveFolder` updates only the
  moved folder row (`0` descendant row writes) under cycle checks and per-Space
  serialization. `move_board_card` maintains `<= 16`-byte `sort_rank_lexo` keys
  via windowed Packed Memory Array (PMA) rebalancing that updates physical
  `rank_rev_id` without overwriting semantic `placement_revision` provenance.
  `rollback_agent_run` freezes eligible targets and closed-room reservations
  before planning, simulates inverse board moves in reverse command order over
  recorded semantic before-anchors, and applies `Trash`-first slug deconfliction
  atomically.
- **Chat DAG and pending queue:** `chat_entries` stores `<= 512`-byte UTF-8
  messages inline and `> 512`-byte payloads in verified CAS (`stage_chat_blob`),
  maintaining deterministic skip pointers at `depth - 16` and `depth - 256` so
  50-entry branch context reads execute in `O(window + log depth)` with `0`
  writes. `chat_pending_inputs` enforces a 16-item per-thread queue (`Full`
  without a mutation receipt on the 17th item). `redact_chat_entry` erases
  target entry content while preserving DAG ancestry and invalidating only
  descendant `Compaction` entries; `tainted` is monotonic and irreversible.
- **Paired backup (`BackupParticipantPort`):** `prepare` opens backup resources
  outside the writer pause (spawning a dedicated `rusqlite` backup owner thread
  for `SQLiteSnapshotV1` or pre-warming `PREPARE __notarium_pin_witness_v1` on a
  dedicated PostgreSQL connection for `PostgresSpoolV1`). `pause_writes` +
  `open_cut` pins consistent database snapshots across paired participants in
  `< 1 ms` before resuming writers. `SQLiteSnapshotV1` copies `16` pages per
  step while monitoring pinned-WAL (`256 MiB` default), deadline (`30 s`) and
  spool (`8 GiB`) budgets; `PostgresSpoolV1` streams `NO SCROLL CURSOR` rows via
  `FETCH 1` and `substr` slices `<= 64 KiB` within `<= 8 MiB` working buffers.

## Offline fixture lifecycle and attributed benchmarks

`make setup` pulls the digest-pinned `postgres:16-bookworm` image, builds the
pinned MinIO Community image from source (`RELEASE.2025-10-15T17-29-55Z`, commit
`9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a`) and builds the `#![forbid(unsafe_code)]`
Unix-socket-to-loopback S3 bridge (`compose.storage-tests.yaml`). `make test`
starts an isolated per-run fixture stack (`--network none` / internal namespace)
mounted over `.artifacts/storage-tests/<run>/` Unix domain sockets and tears it
down automatically via signal/exit traps. Integration tests fail closed if
fixtures are absent.

To run the attributed `--release` storage benchmark suite and write
`.artifacts/3-storage-cas/d3-benchmarks.json`:

```sh
sh .devkit/runtime/devkit.sh cli exec --component apps/api --write --network none -- \
  cargo build --offline --locked --release -p notarium-canonical --example d3_benchmarks
sh docker/storage-fixtures/with-storage-fixtures.sh exec-custom \
  sh .devkit/runtime/devkit.sh cli exec --component apps/api --write --network none -- \
  ./target/release/examples/d3_benchmarks --output /workspace/.artifacts/3-storage-cas/d3-benchmarks.json
```

### Attributed `--release` reference results

Measured on Linux `6.8.0-147-generic` x86_64 (`8` CPU / `16 GiB` cgroup quota,
`ext4` virtual block volume, `SQLite` `synchronous = FULL` (`2`), `PostgreSQL 16`
`synchronous_commit = on` over local UDS, `MinIO CE` `9e49d5e7a648` over local
UDS bridge, `4 KiB` unique note carriers):

| Workload | Target | Measured result |
| --- | --- | --- |
| Writer `50w / 0r` (`10s` warmup + `30s` measured, 3 runs) | `> 2,000 mut/s`, `0` `SQLITE_BUSY` | `2,153.5`, `2,247.2`, `2,286.1 mut/s` (`p95 = 25.1–32.5 ms`, `Phase-2 p95 = 20.2–24.2 ms`, `0` `SQLITE_BUSY`) |
| Writer mixed `50w / 200r` (`10s` warmup + `30s` measured, 3 runs) | `> 2,000 mut/s`, `0` `SQLITE_BUSY` | `2,219.6`, `2,190.4`, `2,004.8 mut/s` (`133,958–151,799` concurrent verified reads/run, `0` `SQLITE_BUSY`) |
| Rollback 20-entity microfixture (`1,000` independent resets) | `p95 < 5,000 us` (local CAS) | `SQLite+Local`: `p50 = 3,190.9 us`, `p95 = 3,724.4 us`; `PG16+Local`: `p50 = 3,504.6 us`, `p95 = 4,167.6 us`; `PG16+S3 (UDS, 200 resets)`: `p50 = 3,687.9 us`, `p95 = 4,371.9 us` |
| Chat 50-entry branch window in `10,000`-turn linear & branched DAG (`10,000` reads) | `p95 < 1,000 us`, `0` writes | `SQLite`: `p95 = 226.3 us` (linear) / `227.0 us` (branched), `0` writes; `PG16`: `p95 = 509.6 us` (linear) / `503.2 us` (branched), `0` writes |
| Board `10,000` consecutive first-slot moves | `rank <= 16 B` | `max_rank = 12 B` (`324` windowed PMA rebalances, mean `1.62` overlays/move; `SQLite p95 = 9.42 ms`, `PG16 p95 = 16.20 ms`) |
| Folder `MoveFolder` over `100,000` descendants (`1,000` moves) | `0` descendant writes | `0` descendant rows modified (`SQLite` & `PG16`) |
| Paired backup writer pause (`1,000` captures across 2 participants) | `p95 < 1,000 us` | `SQLite paired`: `p50 = 162.0 us`, `p95 = 324.6 us`; `PG16 paired`: `p50 = 313.8 us`, `p95 = 434.7 us` |

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
