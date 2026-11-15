# Control storage and account authority

The control crate provides the SQL schema, bounded stores, target record
import/export and `ControlService`. The service implements `AuthPort` and Space
membership/lifecycle operations. OAuth issuance/OIDC, the provider gateway,
account episodes/abilities/schedules and backup participant services remain under
construction. HTTP routes, cookies, CSRF and the desktop authentication perimeter
belong to the transport composition.

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
cancelled. Successful scrypt verification returns an Argon2id replacement. Login
locks the account and compares the observed hash and auth version before persisting
the replacement and admitting a session. A concurrent reset or disable wins over
a stale password verification. KDF work never holds an SQL write transaction.

The 256 MiB budget covers primary memory-hard buffers. It is not a total process
RSS guarantee. Test-only allocation instrumentation measures the synchronous
worker, including bounded profile/input allocations, against a separate 1 MiB
overhead allowance. Allocator and runtime RSS require separate measurement.

Session, one-time and authorization-code verifiers hash the full token. PAT,
access and refresh verifiers hash only the secret segment, with a separate token
ID for lookup. Helpers enforce exact lowercase hexadecimal grammar, use system
entropy through `getrandom` and compare SHA-256 verifiers in constant time. Raw
tokens use a redacted, zeroizing wrapper and are not persisted by these helpers.

## Authentication and account effects

`ControlService::open` requires an already published, consistent data-root epoch,
an explicit authentication mode, resource URI, canonical catalog and real
revocation adapter. Pending Space operations and revocations must finish before
the constructor returns a ready service. Creating an empty schema is never an
authorization to provision an administrator. `bootstrap` requires the composition
owner's typed `EmptyRootAuthorization` and checks a durable one-time account CAS.
Its final session issuance retains the original password/auth-version witness:
a password replacement or disable/enable cycle while personal-Space creation is
pending prevents that bootstrap request from admitting a session. The response
reports an unknown outcome because account creation already committed.

New usernames are lowercase ASCII alphanumeric with interior `.`, `_` or `-`,
limited to 32 bytes. Email is optional, trimmed and lowercased, up to 254 bytes.
Login preserves exact username spelling and gives it priority over normalized
email. Unknown, passwordless, disabled and incorrect-password outcomes share the
authentication failure. Unknown/passwordless/disabled accounts perform a bounded
dummy verification. Password setting accepts 8–1024 UTF-8 bytes; verification
accepts at most 4096 bytes without Unicode normalization.

Sessions slide for 30 days and touch at most once per hour. Invites expire after
seven days and resets after one day. Reissuing invalidates the previous token of
that purpose. Consuming a token, replacing the password and revoking old authority
are atomic. Expired or revoked credentials cannot be extended or revived.
PAT expiry is optional; `Some(empty)` selected Spaces grants no Spaces, while
`None` intersects all current memberships. PAT/OAuth contexts always remain
delegated and cannot manage account credentials or acquire `AbilityWrite`.

An interactive transport must explicitly admit human management on session
evidence or a checked trusted-none perimeter attestation before `AbilityWrite`
can be present. Trusted-none uses the configured durable owner; invalid supplied
credentials never fall back to that owner. OIDC ID tokens are not bearer evidence;
a future verified RP flow must issue a native session.

Each control effect rechecks durable credential and account state. Derived
contexts retain the original session/PAT/OAuth grant/family lineage. Refreshing
authority intersects current permissions with the original delegation, retaining
project limits, write-Space pins and taint. `max_auth_spaces` is an explicit
composition limit of 1–4096; exceeding it rejects admission rather than truncating
permissions. Instance administrators manage accounts without inheriting access to
another account's personal content.

Minted secrets are returned once. Lost mint responses require inspection and new
explicit issuance; replay receipts never contain raw secrets or password digests.
Password changes use account revision CAS and reconciliation through fresh login.
Other metadata commands bind the actual normalized payload, caller-supplied digest,
expected revision, owner, actor and command key. Changed payloads cannot reuse a
key. Account creation advances the administrator's command revision; the created
account starts at revision zero. PAT pages bind owner, revision and last token ID,
with at most 200 rows and 8 MiB of encoded target rows.

## Space coordination and revocation

Account/personal-Space and shared-Space creation first commit a pending operation
and membership, then call the idempotent canonical catalog outside SQL, and finally
activate admission. Pending Spaces cannot appear in authentication grants. A
failure after canonical creation leaves the same durable operation for replay or
startup recovery, with the same Space ID and catalog identity.
Creation returns the saved canonical receipt, including on exact replay, without
a second catalog read that could misreport an already committed effect.

Shared membership changes serialize on the Space admission row and check the
expected revision. The last owner cannot be removed or demoted. A personal Space
retains its sole account owner. Membership results explicitly carry an optional
role so removal has an unambiguous response. Membership/lifecycle commands have
stable keys and include the expected history in their fingerprints. An actor with
a still-valid human credential may call `resume_membership_change` through a fresh
account context after self-demotion or self-removal. This resumes only the saved
command and its pending revocation acknowledgement, without requiring current
membership or authorizing a new mutation. Changed payload, revision or history
cannot reuse that command key; another actor cannot retrieve its receipt.

Archive and reactivation commit a closing fence and revoke event first, wait for
revocation ACK, perform the idempotent canonical lifecycle change, then publish the
final admission state. Failures retain the fence. Explicit owner management
admission can inspect the history of an archived Space and request reactivation;
its context has no content read/write classes while the Space is inactive.

Authority mutations and their revocation events commit together. The public
mutation returns success only after the injected `SessionRevocationPort` confirms
that admitted registrations and run callbacks have been invalidated. Delivery
uses a stable event request ID across retries. Failed delivery returns an unknown
commit outcome while fresh admissions already see the durable denial. Logout
evidence may resume only its own exact committed logout. Network-wide registration
ownership and websocket/SSE disconnect delivery belong to the transport adapter.

Writers have four immediate-admission slots per store owner. Owned workers retain
the writer fence through BEGIN, COMMIT and ROLLBACK acknowledgement, even when the
request future is dropped. This bounds cancelled-but-still-running database work
and keeps it visible to the backup owner's write pause.

## Verification

Run `make setup`, `make check`, `make test` and `make build`. The database suite
requires the disposable PostgreSQL fixture created by the Make wrapper; it never
silently skips PostgreSQL. It compares the full table manifest and representative
constraints, verifies transactional rollback and tests export snapshot retention
on SQLite and PostgreSQL. Authentication tests exercise secret issuance, callback
failure/replay, pending canonical creation, owner races and lifecycle recovery.
They do not certify the unimplemented services or a production transport's live
registry.
