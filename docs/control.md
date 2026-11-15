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

## Native credential keyring

The separate `Keyring` service validates existing state without creating files,
probing writability, changing permissions or repairing missing material. Local
storage defaults to `<DataRoot>/secret-keyring`; cloud storage requires an explicit
external location. The composition owner maps operator configuration to
`KeyringLocation`. No environment-variable lookup or implicit initialization
occurs inside the service.

`active.json` identifies format `notarium-credential-key-pointer`, format version
one, generation, key ID and `sha256:<64 lowercase hex digits>` of the exact key
file bytes, including any final newline. `keys/<key-id>.json` contains format
`notarium-credential-key`, version one, key ID and a canonical unpadded base64url
32-byte master secret. Both JSON formats reject unknown or duplicate fields.
Fresh serialization is compact JSON followed by one newline.

HKDF-SHA256 with an empty salt derives the 12-byte key ID suffix with info
`notarium:key-id:v1`, the 32-byte encryption key with
`notarium:secret:credential:v1`, and the canary with `notarium:canary:v1`.
Envelopes are `v1.<key-id>.<base64url(nonce || ciphertext || tag)>`, using
AES-256-GCM with a fresh 12-byte random nonce and 16-byte tag. Authenticated data
joins version, key ID, facet, record ID and field with NUL separators and no final
separator. Credential secrets, resource headers and key canaries have distinct
identities; header names are validated and lowercased.

The reader uses directory capabilities to confine relative projected-volume
symlinks. Files must be regular and at most 16 KiB; nonblocking open rejects FIFOs
without waiting for a writer. Unix roots and files must not be world writable.
Existing readable mounts do not need mode `0600`. Pointer generation, key ID,
exact file hash and encrypted canary must match the durable `secret_keyring`
witness. Startup validates all nonretired keys. Every later operation reloads
the active and requested key, then rechecks the SQL witnesses before returning.
A pointer transition permits only one bounded reread. No raw key cache survives
an operation. Secret buffers and supported crypto state use zeroization; this
does not promise removal of every compiler or library temporary copy.

Four process-wide filesystem slots are acquired without queueing. A blocking
worker retains its slot after caller timeout or drop until the actual work ends.
Plaintext is limited to 32 KiB and envelopes to 44 KiB. Errors and debug output
exclude raw keys, plaintext and envelope values. Target export contains only
key ID, generation, hash and encrypted canary records, never key files.

`FreshLocalInitializer` accepts only the SQLite store's local default path and a
typed `EmptyRootAuthorization`. It checks all target tables are empty, creates
directories with mode `0700` and files with mode `0600`, synchronizes files and
directories, then commits generation one and a migrating installation witness.
The paired storage coordinator must publish readiness separately. A successful
repeat validates existing state without rewriting it. Files and SQL are not one
atomic transaction: interruption between them leaves a partial root requiring
explicit recovery. Missing or corrupt state never triggers key regeneration.

Linux tests exercise the real read-only source mount, confined projected
symlinks, FIFO refusal, native independent crypto vectors, both SQL dialects,
fresh initialization and cancellation ownership. Windows ACLs and filesystem
durability have not been qualified by these Linux checks.

## Outbound transport

`OutboundTransport` supplies a shared network boundary for provider, CIMD and
OIDC calls. Provider dispatch still needs current account authority, disclosure
consent, configuration witnesses and a durable call intent from the provider
gateway. A cached client is never proof of those permissions.

URLs use the `url` parser with IDNA normalization. User information, fragments,
control characters, backslashes, zone IDs and alternative integer/octal/hex/short
IPv4 forms are rejected. Public destinations require HTTPS. The address policy
excludes IANA special-purpose allocations, multicast and reserved addresses,
including mapped IPv4 forms. Cloud metadata and platform addresses are denied
before evaluating private exceptions.

Only an operator's exact Ollama resource/origin rule can permit HTTP or private
destinations. Its CIDRs must lie within loopback, RFC1918 or ULA ranges; every DNS
candidate must belong to that rule. Rules never apply to CIMD, OIDC or another
provider resource. Configuration allows at most 128 rules with 32 CIDRs each.

The guarded resolver runs on the actual connector path, validates the complete
answer of at most 32 candidates, and passes those same socket addresses to the
connector. It performs no independent preflight lookup. Literal addresses use
the same policy before sending. Four process-wide blocking DNS jobs retain their
slots after caller cancellation until the system lookup really finishes.

Clients explicitly disable environment proxies, redirects, automatic retries,
referer generation and TLS key logging. HTTP/1 prevents connection coalescing.
Pools are separated by scope, resource runtime/credential epochs, canonical
origin and operator policy epoch. They retain at most two idle connections per
client, with an LRU limit of 128 clients and eviction restricted to idle clients.
A newer resource epoch cancels its older pools. Provider mutations must use
`invalidate_provider` inside their dispatch admission fence; operator policy
replacement cancels all old pools. Fresh DB checks remain mandatory after idle
pool eviction, because the bounded cache is not an authority ledger.

There are 32 active call slots across transport instances. An owned worker reads
each response through a one-chunk channel of at most 64 KiB. Caller drop, explicit
cancellation, epoch changes and deadlines close the response and release its
slot even if the consumer never polls again. Client construction may load system
certificates, so it also runs as an owned blocking job. Connect timeout is five
seconds; first-byte, idle-read and consumer-backpressure limits are 30 seconds.
Provider total duration is at most 120 seconds and metadata duration ten seconds;
the caller's smaller absolute budget takes precedence.

Requests are limited to 8 MiB. Provider wire responses have a 32 MiB ceiling plus
the caller's smaller limit; CIMD allows 64 KiB and OIDC 256 KiB. Accepted request
and response headers are limited to 16 KiB. Response parsing also limits header
count to 100, but the HTTP parser can temporarily buffer more than 16 KiB before
rejection; the acceptance limit is not an exact allocation cap. Header values
are marked sensitive, and transport diagnostics exclude URL queries and bodies.
Connector failures before HTTP application bytes report an unsent outcome;
disconnects or timeouts after possible dispatch report an unknown outcome.

Offline tests use actual loopback HTTP sockets with checked DNS injection and
invalid proxy environment settings. They verify exact destinations, redirect
refusal, DNS rebinding, pool separation, epoch cancellation, no replay of a POST
received before disconnect, and bounded unpolled/cancelled calls. These tests do
not certify a live external identity provider or public TLS endpoint.

## Verification

Run `make setup`, `make check`, `make test` and `make build`. The database suite
requires the disposable PostgreSQL fixture created by the Make wrapper; it never
silently skips PostgreSQL. It compares the full table manifest and representative
constraints, verifies transactional rollback and tests export snapshot retention
on SQLite and PostgreSQL. Authentication tests exercise secret issuance, callback
failure/replay, pending canonical creation, owner races and lifecycle recovery.
They do not certify the unimplemented services or a production transport's live
registry.
