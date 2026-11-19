# Archive jobs and recovery

`notarium-jobs` exposes Rust library entry points for background ZIP import and
export and for installation maintenance. The composition owner supplies the
canonical store, control service and revocation registry. Transport adapters can
use job IDs and artifact IDs without exposing storage paths or object keys.

## Content jobs

Use `ArchiveJobs::stage_import` to seal an upload, then `ArchiveJobs::enqueue`
to submit the returned artifact. The same enqueue method accepts explicit note
selection or a whole-Space export. The worker revalidates the submitting
credential and Space grant at claim and during execution. The default runner
admits one import and one export on its own runtime with a bounded blocking pool.
The canonical writer fences job progress and terminal results by lease owner,
epoch and expiry. Shut down the runner by cancelling its token and awaiting it.

Import validates ZIP layout, portable paths, size and compression limits, and
carrier syntax before writing notes or folders. It seals the path and link plan
and pins that plan to the job before its first content mutation. Successive
leases use the plan's original IDs and committed ordinal. A concurrent write
that claims a planned path can cause a conflict after a valid prefix has been
committed. A rejected preflight commits zero content items.

Export cuts record one history, Space sequence and privacy generation. The
compact cut has a 50 ms SQL transaction budget. It captures paths, the current
field schema, ability package resources and chat metadata before reading CAS.
Larger whole-Space exports register a cut and read keyset pages. The writer
preserves a row's first pre-image while the cut is active. Large chat threads
can be read a page at a time while the archive is written.
An encrypted note requires explicit ciphertext opt-in. Exports use an owned CAS
hold and bounded buffers. The final ZIP becomes visible after its immutable
storage generation is sealed and its canonical pointer commits. The artifact ID
names that committed pointer. ETag is the BLAKE3 digest of the ZIP bytes.
The writer journals plan and export generations before storage writes. It
retains the winning import plan across lease changes and retires abandoned
generations in their own namespace.

`ArchiveJobs::open_export` returns an authorized reader with a bounded
`read_chunk` method. Check its metadata for content length and expiry. Each
chunk revalidates authority and crosses the canonical privacy fence before
handoff. Archive bytes already handed off belong to the caller. An artifact
expires seven days after publication. The maintenance loop retires its sealed
storage generation and then removes the pointer.

Local content job inputs, plans and outputs use the installation's private
`staging/archives/` area. Cloud uses private, create-only object generations
and saves exact S3 version IDs when versioning is enabled. Configure an archive
bucket or prefix disjoint from content CAS. Each Cloud worker uses its own
local scratch directory. No client supplies bucket names or object keys.

## CAS maintenance

The runner scans zero-reference catalog entries in indexed pages. The first
pass stamps the current publication's quarantine age. The second can schedule
retirement after 24 hours and 5 minutes. The canonical transaction checks the
publication identity, active writer epoch, staged tickets, references and holds
again. Reacquisition of a reference resets its quarantine. Canonical retirement
workers own the physical operation and recover durable work after interruption.

## Backup, verification and restore

- `run_backup` takes the paired canonical and control cut while both writers are
  paused. It resumes writes before materializing the database spools and CAS
  bytes. The ZIP64 archive contains `manifest.json`, `db/control`, `db/canonical`,
  `cas/index` and `cas/data`. Keep the external keyring separately. The archive
  contains encrypted canary witnesses and credential envelopes.
- `run_fsck` accepts a live installation or an owned, immutable `Read + Seek +
  Send` archive source. A remote adapter must pin the object version before
  opening the source. Archive verification checks ZIP metadata and digests,
  database structure and references, decoded CAS bytes, and external keyring
  readability. SQLite verification reads the stored database slices through a
  read-only range VFS. The verifier operates under a caller deadline.
- `run_restore` verifies the complete archive before it creates a target
  generation. Supply a fresh target of the same backend type and the separately
  saved keyring. Local restore can keep an external keyring or provision the
  default keyring directory from the separately saved files. Cloud restore
  requires a dedicated, empty PostgreSQL database and a fresh S3 prefix. A
  durable marker ties readiness to the database installation and S3 namespace.

Restore assigns a new incarnation to every Space and clamps control cursors to
its recorded cutoff. Both stores must agree before the target is published.
A restart with the same archive and target can recover the pending generation.
Previously queued and running archive attempts require fresh admission against
restored storage. Derived indexes rebuild from the new history.

Run the Local and Cloud integration tests through `make test app=api` with the
pinned PostgreSQL 16 and MinIO fixtures. The tests exercise backup, archive
verification and restore on both storage profiles. The large linked-note
workload is available as an opt-in test in `notarium-jobs`.
