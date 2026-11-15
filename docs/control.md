# Control storage foundation

The control crate currently provides the baseline SQL schema, bounded connection
pools, target record import/export, password hashing and token grammar helpers.
It does not yet provide complete account/login, RBAC/revocation, OAuth/OIDC,
provider gateway, account-state or backup participant services. No HTTP routes or
desktop authentication perimeter are implemented by these primitives.

## Persistence

SQLite uses `<DataRoot>/v1/control.sqlite`, WAL mode, full synchronous writes,
foreign keys, strict tables and a 250 ms busy timeout. The composition owner must
classify the data root before opening it and create the approved parent directory.
PostgreSQL uses the `v1_control` schema and qualified queries. Pools have four
SQLite connections or eight PostgreSQL connections. SQL migrations reject unknown
migration versions; both dialects have explicit baseline DDL.

All text is NUL-free. Each declared primary, unique or secondary index key has a
shared 2 KiB data budget: UTF-8 bytes for text, bytes for blobs, and eight bytes
per numeric column. The importer and both SQL schemas enforce the same bound,
so values accepted by SQLite remain representable in PostgreSQL B-tree indexes.
Optional retrieval scores accept only finite floating-point values or null;
NaN and infinities are rejected before binding, preserving JSON export semantics.

Target records name every persisted column and table. Import accepts at most 200
records and 8 MiB of encoded JSON records per page, requires restore authority and
refuses a ready epoch. The first page supplies an epoch-one migrating witness.
`begin_target_import` / `append` / `finish` keep one transaction across bounded
pages. Episode-parent and refresh-rotation references are checked at commit, so
primary-key export order can be restored without loading the corpus into memory.
`import_target_batch` is a convenience for a complete cut fitting in one page.
Constraint failures, cancellation and expiry roll back the whole cut. Dropping
an active append future also invalidates the cut; a retained handle cannot commit
a partially appended page. Import does not publish a ready
epoch or parse an earlier product's database schema. Further semantic validation
belongs to the owning services and the offline migration delivery.

Target export pins a real read transaction and returns keyset pages of at most
200 records, bounded to 8 MiB including record envelopes. The source snapshot
survives intervening commits. Deadline, backend retention and cancellation checks
close an aborted snapshot. A watchdog releases idle imports and exports without
requiring another consumer call; one active export is admitted per store owner.
Dropping an active page future aborts its export even when the handle is retained.
The PostgreSQL idle timeout provides an additional finite process-failure fallback.
Export counts encoded record bytes toward its budget;
an archive writer must also account for its own framing and metadata. This is a
single-store snapshot, not a coordinated two-store disaster-recovery backup.
Only database records are exported: raw credential key files are never visited.

## Password and token primitives

New password hashes use Argon2id with 64 MiB, three iterations and one lane. The
verifier also accepts bounded native scrypt records. One process-wide semaphore
has four 64 MiB credits, acquired without waiting before work is submitted to a
blocking task. The task owns its credits until it finishes, even if its caller is
cancelled. Successful scrypt verification returns an Argon2id replacement; the
future account service must persist that replacement with an auth-version/hash
compare-and-swap before admitting a session.

The 256 MiB budget covers primary memory-hard buffers. It is not a total process
RSS guarantee. Full concurrent flood and overhead qualification is still pending.

Session, one-time and authorization-code verifiers hash the full token. PAT,
access and refresh verifiers hash only the secret segment, with a separate token
ID for lookup. Helpers enforce exact lowercase hexadecimal grammar, use system
entropy through `getrandom` and compare SHA-256 verifiers in constant time. Raw
tokens use a redacted, zeroizing wrapper and are not persisted by these helpers.

## Verification

Run `make setup`, `make check`, `make test` and `make build`. The database suite
requires the disposable PostgreSQL fixture created by the Make wrapper; it never
silently skips PostgreSQL. It compares the full table manifest and representative
constraints, verifies transactional rollback and tests export snapshot retention
on SQLite and PostgreSQL. These tests do not certify the unimplemented services.
