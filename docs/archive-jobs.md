# Archive jobs and recovery

`notarium-jobs` exposes Rust library entry points for background ZIP import and
export and for installation maintenance. The composition owner supplies the
canonical store, control service and revocation registry. Transport adapters can
use job IDs and artifact IDs without exposing storage paths or object keys.

## Content jobs

Use `ArchiveJobs::stage_import` to seal an upload, then `ArchiveJobs::enqueue`
to submit the returned artifact. Upload and enqueue each use one caller deadline
across authority checks, storage and canonical admission. The same enqueue method
accepts explicit note selection or a whole-Space export. A job's encoded input,
including its delegation, must fit within 4 MiB. Enqueue returns `BudgetExceeded`
before creating a job when the input exceeds this limit. A worker marks an
oversized export left by an earlier writer as failed and continues processing
the queue. The worker revalidates the submitting credential and Space grant at
claim and during execution. The default runner admits one import and one export
on its own runtime with a bounded blocking pool.
Each worker polls its class for Spaces with queued jobs or reclaimable leases.
The canonical writer fences job progress and terminal results by lease owner,
both the job and Space epochs, and lease expiry. It retains the authority
registration until an admitted write commits or rolls back. In Cloud, the
control and canonical schemas must share the same primary PostgreSQL database.
Their transaction lock keeps revocation delivery ordered with archive writes
even when a worker loses its commit response. Shut down the
runner by cancelling its token and awaiting it.

Import validates ZIP layout, portable paths, size and compression limits, and
carrier syntax before writing notes or folders. It seals the path and link plan
and pins that plan to the job before its first content mutation. Successive
leases use the plan's original IDs and committed ordinal. A concurrent write
that claims a planned path can cause a conflict after a valid prefix has been
committed. A rejected preflight commits zero content items. The submitting
credential can read the validation reason and normalized relative entry path
through `get_job`. Invalid names and archive-wide failures omit the path. Job
lists and change notifications carry only the shared job summary.
Accepted inputs expire after seven days. Admitting another import with the
same input extends its retention. A queued or running job retains its input
until it reaches a terminal state.

Export cuts record one history, Space sequence and privacy generation. The
compact cut has a 50 ms SQL transaction budget. It captures paths, the active
field schema's immutable carrier revision, ability package resources and chat
metadata before reading CAS. Explicit selections resolve paths from the
selected heads and their authorized ancestors. A selection that exceeds the
compact cut budget finishes with a budget error.
Larger whole-Space exports register a cut and read keyset pages. The writer
preserves a row's first pre-image while the cut is active. Large chat threads
can be read a page at a time while the archive is written. Trashing the current
schema carrier preserves the installed schema. Purging the carrier clears its
descriptor and invalidates exports that captured it.
An encrypted note requires explicit ciphertext opt-in. Exports use an owned CAS
hold and bounded buffers. A privacy mutation invalidates the export generation
while paired installation backups protect their captured cut. The final ZIP
becomes visible after its immutable
storage generation is sealed and its canonical pointer commits. The artifact ID
names that committed pointer. ETag is the BLAKE3 digest of the ZIP bytes.
Local and Cloud exports also record a digest per 4 MiB segment. A range read
checks its segment and can reuse it for subsequent chunks from the same reader.
For earlier Local exports with only a whole-file digest, the first open rebuilds
the segment index against that digest. The process caches the eight most
recently used legacy indexes.
The writer journals plan and export generations before storage writes. It
retains the winning import plan across lease changes and retires abandoned
generations in their own namespace.

`ArchiveJobs::open_export` returns an authorized reader with a bounded
`read_chunk` method. Its metadata includes content length and expiry. The reader
loads the immutable segment descriptors and the job policy once at open. Each
chunk checks the publication and job state. For selected exports the reader
reuses document classes and active ancestry while the history, privacy generation
and Space sequence match. SQLite resolves changed selections through covering
indexes. The caller and original exporter both need current access. Their
revocation and expiry checks run at handoff inside the canonical privacy fence.
A successful enqueue into a reserved transport slot is the receipt for that
chunk. Archive bytes already handed off belong to the caller. An artifact
expires seven days after publication. The maintenance loop retires its sealed
storage generation and then removes the pointer.

Local content job inputs, plans and outputs use the installation's private
`staging/archives/` area. On Unix, opening an existing archive directory
requires owner-only permissions. Cloud uses private, create-only object generations
and saves exact S3 version IDs when versioning is enabled. Configure an archive
bucket or prefix disjoint from content CAS. Each Cloud worker uses its own
local scratch directory. No client supplies bucket names or object keys.

## CAS maintenance

The runner scans zero-reference catalog entries in indexed pages, including
outstanding work in archived Spaces. The first
pass stamps the current publication's quarantine age. The second can schedule
retirement after 24 hours and 5 minutes. The canonical transaction checks the
publication identity, active writer epoch, staged tickets, references and holds
again. Reacquisition of a reference resets its quarantine. Canonical retirement
workers own the physical operation and recover durable work after interruption.
Each store admits up to four physical sweep attempts at once. When all four
slots are in use, mature entries stay eligible for the next sweep. A failed
attempt releases its slot and records the next retry time in SQL. One dispatcher
visits the pending retirements in bounded pages across Spaces. Startup and
lease recovery resume sealed work and preserve immediate cleanup obligations
from pre-quarantine catalogs.

## Backup, verification and restore

- `run_backup` takes the paired canonical and control cut while both writers are
  paused. The Canonical preparation task coordinates both pins and resumes with
  the Control worker. Both writers acknowledge resume before materialization
  of the database spools and CAS bytes. Each owner confirms resource cleanup on
  close, including during shutdown. A missing PostgreSQL rollback acknowledgement
  ends the operation with an error. The ZIP64 archive contains `manifest.json`,
  `db/control`, `db/canonical`,
  `cas/index` and `cas/data`. Keep the external keyring separately. The archive
  contains encrypted canary witnesses and credential envelopes. Before publishing,
  backup checks that retained CAS counts match actual owners and that the decoded
  CAS fits the verifier's total size budget. Control snapshots preserve the
  Control schema's index-key budget. Canonical snapshots verify logical
  constraints, and PostgreSQL enforces physical index limits on the hidden
  restore target before publication.
- `run_fsck` accepts a live installation or an owned, immutable `Read + Seek +
  Send` archive source. A remote adapter must pin the object version before
  opening the source. Use `ArchiveInput::with_length` when the pinned version
  already supplies the exact byte count. Archive verification checks ZIP metadata and digests,
  database structure and references, decoded CAS bytes, and external keyring
  readability. SQLite verification reads the stored database slices through a
  read-only range VFS in a separate process. The default worker caps SQLite's
  native heap at 80 MiB and reports the measured native high-water mark.
  The verifier operates under a caller deadline. Both Notarium binaries
  dispatch the internal verifier argument before opening storage. An embedding
  application can supply its own launcher using `SqliteVerifier::with_command`
  and dispatch to `run_sqlite_verifier` in that process.
- `run_restore` verifies the complete archive before it creates a target
  generation. Supply a fresh target of the same backend type and the separately
  saved keyring. Local restore can keep an external keyring or provision the
  default keyring directory from the separately saved files. Cloud restore
  requires a dedicated, empty PostgreSQL database and a fresh S3 prefix. A
  durable marker ties readiness to the database installation and S3 namespace.
  Before loading either store, restore reserves the prefix with a create-only
  `.notarium-restore-owner` object containing the target database's restore
  generation ID. Keep this object with the restored CAS. A retry checks the
  same ID before resuming. Concurrent restores into different databases that
  select the same empty prefix can publish at most one installation. A ready
  installation from an earlier experimental restore journal can still serve
  its existing data. If the journal lacks a namespace owner, `run_restore`
  returns `InvalidState`. Use a fresh database and prefix for another restore.

Paired backup and live verification use private temporary database spools. The
coordinator releases them when their last reader finishes, including cancelled
and failed operations. An abandoned pending marker lets each participant
recover its own spool after a process exits.
Packing uses a private, installation-specific work directory beside the destination.
A subsequent backup to the same parent reclaims marked packing attempts whose
owner has exited. On Unix the published ZIP is created with mode `0600`.
The paired archive format supports up to 65,536 Spaces within the configured
time and storage budgets. Each SQLite image is limited to 10 GiB. Backup
and verification stream inline collaboration snapshots through incremental
SQLite BLOB reads in 64 KiB chunks. This supports values above the verifier’s
32 MiB limit on materialized SQL values. The PostgreSQL
canonical spool bounds the history witness separately from its row budget.
SQLite verifier reports and Local and Cloud restore journals allow up to
32 MiB of JSON metadata.
Paired backup reserves capacity before preparing the databases. The spool
digest check, CAS scanning and packing, and live verification use owned native
workers. The scanner and writer can run together even when the caller's
blocking pool is occupied. On cancellation the coordinator drops its channels
before releasing the holds. Each worker retains its capacity and temporary
files until its work returns.
Before requesting either writer pause, the coordinator can wait up to 20 ms
within the backup deadline for active canonical writes. Both writers remain
available during this wait. Sustained write traffic falls through to ordinary
safe-point acquisition after the wait budget expires.

Restore assigns a new incarnation to every Space and clamps control cursors to
its recorded cutoff. Both stores must agree before the target is published.
A restart with the same archive and target can recover the pending generation.
Previously queued and running archive attempts require fresh admission against
restored storage. Derived indexes rebuild from the new history.

Run the Local and Cloud integration tests through `make test app=api` with the
pinned PostgreSQL 16 and MinIO fixtures. The tests exercise backup, archive
verification and restore on both storage profiles. The large linked-note
workload is available as an opt-in test in `notarium-jobs`.

The maintenance integration test can run the full paired backup under
foreground note and chat writes with `NOTARIUM_PAIRED_ARCHIVE_CAPTURES=1000`.
Each capture runs alongside four note/chat write pairs, spaced at 10 ms and
rotated across the participating Spaces.
It reports the wait before pausing, confirmed pause, pause including drain, and
complete backup latency for 1 and 64 Spaces. The confirmed timer starts when
Control acknowledges its safe point. The inclusive pause timer starts with the
first pause request. Both stop after the two resume acknowledgements. Select
`NOTARIUM_ARCHIVE_BENCH_TIER=high` or `medium` on the
matching hardware from [Storage performance](storage-performance.md) to apply
the corresponding p95 threshold.

```sh
sh docker/storage-fixtures/with-storage-fixtures.sh exec-custom \
  sh .devkit/runtime/devkit.sh cli exec --component apps/api --network none -- \
  env TMPDIR=/workspace/apps/api/target \
  NOTARIUM_PAIRED_ARCHIVE_CAPTURES=1000 NOTARIUM_ARCHIVE_BENCH_TIER=high \
  cargo test --release --locked --offline -p notarium-jobs --test maintenance \
  archive_verification -- --test-threads=1 --nocapture
```

Keep the release build identity, volume calibration and the printed mount
information with each series. Rated runs require ext4 for the SQLite, spool and
PostgreSQL data directories. The work directory in this command uses the
bind-mounted Cargo target volume.

Set `NOTARIUM_CLOUD_ARCHIVE_TAKEOVER=10000`
to kill the first Cloud worker after 201 durable units, remove its local
staging directory, and finish the import in a separate process. Pass these
variables to the pinned container with `env` under the storage fixture wrapper.
Run the maintenance test with `-- --test-threads=1 --nocapture` for isolated
samples. `NOTARIUM_SQLITE_FSCK_LARGE=1` verifies SQLite images larger than
160 MiB at both 512-byte and 64 KiB page sizes and prints the native peak.
The ignored `fifty_thousand_imports_with_foreground_saves` test compares
foreground save and verified read latency before and during Local import. It
also records memory and checkpoint observations.
