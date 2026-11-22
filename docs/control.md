# Control storage and account authority

The control crate provides the SQL schema, bounded stores, target record
import/export and `ControlService`. The service implements `AuthPort` and Space
membership/lifecycle operations. `OAuthService` implements `OAuthPort`, and
`OidcService` implements `OidcPort`. `ProviderService` implements provider
administration, completion and embeddings. `ControlPlane` implements the complete
`ControlPort`, deriving its authority owner from that provider instance.
`ControlService` also implements context administration and content-free agent
telemetry. `ControlBackup` implements `BackupParticipantPort`; its protocol and
artifact contracts are described in [control backups](control-backup.md). HTTP routes, consent
UI, cookies, CSRF and the desktop authentication perimeter
belong to the transport composition.

## Persistence

SQLite uses `<DataRoot>/v1/control.sqlite`, WAL mode, `synchronous=FULL`, `fullfsync=ON`,
foreign keys, strict tables, a 4 MiB `journal_size_limit`, a 256-page
`wal_autocheckpoint`, a 2500 ms write busy timeout and a 250 ms read busy timeout.
The composition owner must classify the data root before opening it and create the
approved parent directory. PostgreSQL uses the `v1_control` schema, qualified
queries and `COLLATE "C"` on text keys so keyset pagination and export order match
SQLite byte order. Before creating or migrating the control schema, the server
must report `fsync=on`. Every pooled control writer sets `synchronous_commit=on`,
including the migration connection.
SQLite separates a 1-connection write pool from a 20-connection
read-only pool; PostgreSQL separates a 6-connection write/export pool from a
20-connection read pool, with 16 active reader slots, a bounded 512-waiter read
queue, and per-operation `SET LOCAL statement_timeout` and
`idle_in_transaction_session_timeout`. SQL migrations
reject unknown migration versions; both dialects have explicit baseline DDL.

Read-only queries and fast-path credential resolution (`ControlStore::read()`)
use read-only transactions (`BEGIN DEFERRED` on SQLite read pool, `BEGIN READ ONLY`
on PostgreSQL) without acquiring the backup writer fence or row locks, and
`ControlCatalogPort` calls run outside all `controlDb` read and write transactions. All admitted
mutations (`ControlStore::write()`) wait in a bounded 64-entry queue for an active
writer slot (one serialized local writer on SQLite, up to four concurrent writers on
PostgreSQL) within the caller's `OperationBudget` and retain the backup writer fence
through actual commit or rollback completion. SQLite uses separate shared handles on the stable
`control.sqlite.write.lock`; PostgreSQL uses a shared transaction advisory lock.
SQLite bootstrap initializes WAL under an exclusive file fence before opening its
request pool. PostgreSQL bootstrap holds a separate shared session fence through
migration connection close. Caller cancellation does not release an owned writer
or bootstrap task early. Arbitrary external SQL does not participate in these fences.

All text is NUL-free. Each declared primary, unique or secondary index key has a
shared 2 KiB data budget: UTF-8 bytes for text, bytes for blobs, and eight bytes
per numeric column. The importer and both SQL schemas enforce the same bound,
so values accepted by SQLite remain representable in PostgreSQL B-tree indexes.
Optional retrieval scores accept only finite floating-point values or null;
NaN and infinities are rejected before binding, preserving JSON export semantics.

Target records name every persisted column and table. Import accepts at most 200
records and 8 MiB of encoded JSON records per page, requires restore authority and
refuses a ready epoch or an existing epoch with an unsupported version. A target
without an epoch requires an epoch-one migrating witness on the first page;
resuming an existing target requires the same version and migrating state.
`begin_target_import` / `append` / `finish` keep one transaction across bounded
pages. Episode-parent and refresh-rotation references are checked at commit, so
primary-key export order can be restored without loading the corpus into memory.
`import_target_batch` is a convenience for a complete cut fitting in one page.
Constraint failures, cancellation and expiry roll back the whole cut. Dropping
an active append future also invalidates the cut; a retained handle cannot commit
a partially appended page. Import does not publish a ready
epoch or parse an earlier product's database schema. Account-state payloads must
decode to their runtime types, including telemetry request IDs, episode roles and
ability trails. Trail payloads use `AbilityTrailPayload` and must agree with their
source and destination columns. JSON strings used as SQL keys must exactly match
`serde_json::to_string` of the corresponding core type: ability placements,
project `FolderRef` scope keys and `NoteRef` ordering keys. Import rejects alternate
formatting before commit; it does not silently merge or normalize conflicting
keys. Current canonical existence, ownership and lifecycle are still checked by
the owning services when those references are used.
Payload decoding also checks that no JSON members disappear during typed
conversion, including nested note/folder references. Non-key payloads may use
different whitespace or object ordering; unknown members are rejected rather than
retained or silently removed. Schedule and run slots use the same decoder at
import and receipt projection: whole UTC seconds within the core Timestamp range
(years 0000 through 9999). Out-of-range or fractional slots abort the import.

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
limited to 32 bytes. Email is optional, trimmed, lowercased, required to contain
`@` with non-empty local and domain parts, and limited to 254 bytes, preventing
collisions with `@`-free usernames.
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

An interactive transport must explicitly attest `human_management` on session
evidence or a checked trusted-none perimeter attestation to authorize account,
credential, Space, provider, OAuth, OIDC, context, schedule and telemetry-settings
mutations. `Cap::AbilityWrite` is attested separately on interactive evidence and
additionally requires `human_management`. Trusted-none uses the configured durable owner; invalid supplied
credentials never fall back to that owner. OIDC ID tokens are not bearer evidence;
the verified RP flow issues a native session for an explicitly bound identity.

Each control effect rechecks durable credential and account state. Derived
contexts retain the original session/PAT/OAuth grant/family or scheduled-run lineage. Refreshing
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

Archive and reactivation apply only to shared Spaces (`Personal` Spaces cannot
be archived); they commit a closing fence and revoke event first, wait for
revocation ACK, perform the idempotent canonical lifecycle change, then publish the
final admission state. Failures retain the fence. Explicit owner management
admission can inspect the history of an archived Space and request reactivation;
its context has no content read/write classes while the Space is inactive.

Authority mutations acquire SQL locks, then an exclusive provider registration
fence before committing their revocation events. The fence cancels matching calls
and waits for their network shutdown. Its SQL owner retains it until COMMIT or
ROLLBACK acknowledgement, including after caller cancellation. Dispatch takes
the same SQL-then-registry order and releases registrations before settling its
audit in SQL. The registry must coordinate every serving instance and fail closed
when a lease is lost; a process-local map cannot implement this Cloud contract.
The public
mutation returns success only after the injected `SessionRevocationPort` confirms
that admitted registrations and run callbacks have been invalidated. Delivery
uses a stable event request ID across retries. Failed delivery returns an unknown
commit outcome while fresh admissions already see the durable denial. Logout
evidence may resume only its own exact committed logout. Network-wide registration
ownership and websocket/SSE disconnect delivery belong to the transport adapter.

Writers have one active slot on SQLite (four on PostgreSQL) and a bounded
64-waiter queue per store owner; read transactions use an isolated read pool with
16 active reader slots and a bounded 512-waiter queue. Owned workers retain
the writer fence through BEGIN, COMMIT and ROLLBACK acknowledgement, releasing the
file fence before dropping in-process admission guards even when the
request future is dropped. This bounds cancelled-but-still-running database work
and keeps it visible to the backup owner's write pause.

## OAuth authorization server

`OAuthService::new` takes operator-configured issuer and endpoint URLs. The resource
URI comes from `ControlConfig`, never an incoming Host header. Only public clients
with token authentication method `none`, authorization code and optional refresh
grants are supported. Requested scopes are `read`, `write` and `offline_access`;
`write` includes read permission. Unknown scopes fail validation. Refresh accepts
the existing normalized scope only; a different scope requires new authorization.

DCR accepts at most ten redirect URIs and 8 KiB of registration metadata. HTTPS
redirects compare byte for byte. Native HTTP redirects allow only literal
`127.0.0.1` or `[::1]`, with the port allowed to vary; all other bytes must match.
Fragments, userinfo, wildcards and prefix matching are rejected. Inactive DCR
clients expire after 24 hours and are capped at 1,000 in a rolling 24-hour window,
isolated from CIMD quotas.

CIMD fetches an HTTPS client ID through the public-only guarded transport and
requires the metadata's exact matching client ID. JSON responses are limited to
64 KiB. Unactivated CIMD records are capped at 1,000 (evicting inactive expired
entries that hold no grants, authorization codes or refresh tokens before new
admission), defaults to five minutes and
caps freshness at one hour, respecting shorter max-age and Age. No-cache/no-store
responses are fetched for each operation; their registration record cannot serve
as reusable cache authority. New registration has a 60/minute per-instance limit;
activated metadata refresh has a separate 120/minute lane. Each fetch lane admits
four calls. Changed metadata invalidates previously prepared consent.

Authorization requires a current interactive account and PKCE S256. Preparation
checks that the account and client identifiers together fit the portable 2 KiB
index budget; an oversized pair returns `InvalidClient` before consent. The sealed
ten-minute intent binds account, credential/auth version, browser, client metadata,
redirect, resource, scope, selected Spaces and PKCE challenge. The transport must
verify CSRF and explicit consent before constructing `OAuthConsent::attest_checked`.
Approval rechecks these bindings and atomically creates one grant and one code.
The intent's unique grant ID prevents repeated or concurrent approval. Empty Space
selection remains empty; an absent selection uses current memberships.

Codes expire after 60 seconds. Code proof, bindings and PKCE are checked before
atomic consumption and token issuance. Invalid proof does not consume the code.
Access tokens expire after one hour; refresh tokens expire 30 days after each
issuance. Stored native token digests and expiries survive target import unchanged.
Raw tokens are returned once and are never stored in command receipts.

Refresh rotates the current row and creates its successor and access token in one
transaction. A valid previously used refresh token revokes the entire family and
dispatches durable revocation; a wrong secret has no effect. Concurrent refreshes
have one rotation winner, and the loser's reuse can revoke that winner's family.
A lost response must not trigger a hidden refresh retry. Used rows and tombstones
are retained so reuse evidence is not lost.

Token revocation requires the correct secret and client; unknown tokens are an
idempotent no-op. Access revocation removes its family when present, otherwise
only that access token. Account-owner disconnect revokes the grant. Revocation
success waits for the same durable outbox acknowledgement used by account changes.

## OIDC identity

`OidcService::new` accepts at most 64 immutable operator configurations, each with
an exact public HTTPS issuer, client ID, redirect URI and public or confidential
client authentication. The issuer retains its exact spelling, including whether
an origin has a trailing slash; discovery and ID tokens must match it exactly.
Confidential configuration references an enabled encrypted
credential of kind `oidc-client-secret`; Basic and POST secret methods are supported.
The credential's runtime epoch, envelope and complete keyring witness are checked
under the callback claim transaction. Configuration changes invalidate old flows.

Discovery and JWKS use the guarded transport with 256 KiB JSON limits. Discovery
freshness is at most one hour and JWKS freshness at most 15 minutes, honoring
shorter upstream lifetimes. JWKS contains at most 256 keys, with bounded RSA and
P-256 material. An unknown key ID permits one concurrent forced refresh per issuer
with a 30-second cooldown, including failed refreshes. Expired metadata cannot be
used when its refresh fails.

Login uses random state, nonce and PKCE S256, with a ten-minute flow lifetime. SQL
stores their verifiers and the hash of the protected context. The verifier and
nonce themselves stay in the AEAD-sealed context, bound to transaction, browser,
provider and purpose. The adapter must keep this context in a Secure, HttpOnly,
SameSite cookie; it must never put it in a redirect URL or log. Cheap input
invariants and configured-issuer existence are verified before charging the
per-instance rate limit (60 begins/minute, 16 concurrent operations and 4,096 live
transactions).

Callback claims the transaction durably before the single IdP token exchange.
Concurrent callbacks cannot exchange twice. Cancellation or a lost exchange
response requires a new login flow. `openidconnect` verifies RS256/ES256 signatures,
issuer, audience, expiry and nonce; the service also checks exact issuer, bounded
issue time and authorized party with at most 60 seconds of clock skew. Multiple
audiences require the configured client as `azp`, and every additional audience
must be explicitly trusted by the operator. The JOSE header check rejects `none`,
HMAC, remote key URLs (`jku`, `jwk`, `x5u`) and critical extensions (`crit`) while
allowing benign standard/provider header fields and case-insensitive `JWT` `typ`. External access/refresh tokens
are discarded and never become native bearer credentials.

Identity ownership uses only `(issuer, subject)`. Matching email does not link or
create an account. Unknown identities return `IdentityUnbound` for explicit
provisioning. Linking requires a current native session created within five minutes
and rechecks it at claim and final commit. Administrator binding and owner/admin
unlink use revision CAS and durable command receipts. Each account has at most 64
external identities; a unique constraint prevents ownership reassignment races.
Unlink requires a usable password or another configured external identity to
remain. It prevents future external login; existing native sessions retain their
explicit logout/revoke lifecycle. Callback rechecks current identity ownership
before issuing a session, including when unlink or account disable races it.

Protocol tests exercise both databases through a real TLS IdP/CIMD fixture and
independent ES256 vectors. The fixture's exact-origin loopback route exists only
in test builds; public destination policy has separate transport tests. These
services do not implement HTTP routes, consent screens or browser cookie policy.

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

Four per-instance filesystem slots have a bounded 64-waiter queue (50 ms wait)
and batch-decrypt multiple secrets per provider dispatch over `ControlStore::read()`.
A blocking worker retains its slot after caller timeout or drop until the actual work ends.
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
the same policy before sending. Four per-instance blocking DNS jobs retain their
slots after caller cancellation until the system lookup really finishes.

Clients explicitly disable environment proxies, redirects, automatic retries,
referer generation and TLS key logging. HTTP/1 prevents connection coalescing.
Pools are separated by scope, resource runtime/credential epochs, canonical
origin and operator policy epoch. They retain at most two idle connections per
client, with an LRU limit of 128 clients and eviction restricted to idle clients.
A newer resource epoch or credential epoch replaces older pools. Credential
rotation can advance independently while resource identity remains unchanged;
older credential versions cannot reuse the new pool. The provider registration
fence drains active calls before the mutation commits. Resource update/delete
calls `invalidate_provider` to discard an owner's pools, and operator policy replacement
cancels all old pools. Fresh DB checks remain mandatory after idle
pool eviction, because the bounded cache is not an authority ledger.

Each transport instance defaults to 64 active call slots (configurable up to 1,024). An owned worker reads
each response through a one-chunk channel of at most 64 KiB. Caller drop, explicit
cancellation, epoch changes and deadlines close the response and release its
slot even if the consumer never polls again. Client construction may load system
certificates, so it also runs as an owned blocking job. Connect timeout is five
seconds; idle-chunk read and consumer-backpressure limits are 30 seconds.
Provider total duration (including first-byte wait) honors the configured resource
timeout up to 120 seconds, and metadata duration is ten seconds;
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

## Provider gateway

`ProviderService::new` composes the control service, native keyring, guarded HTTP
transport, canonical metadata lease owner and operator Space limits. It implements
`ProviderAdminPort` and `EmbeddingProviderPort`, and exposes `complete`,
`select_provider` and `recover_calls`. `ControlPlane::new(provider)` supplies
the matching account-state operations through `ControlPort`. No service installs models, manages provider daemons or retries an
uncertain paid request.

Only an interactive resource owner can manage credentials, resources and explicit
model profiles. Readbacks expose secret presence and header names, never secret
values or ciphertext. Key material is opened outside SQL; the final authority
transaction checks its complete keyring witness. Reserved framing headers cannot
be configured. Resource updates replace all custom headers, so callers must supply
their values again. Endpoint, header, credential binding or model changes require
renewed disclosure consent. A secret-only credential rotation preserves consent
while advancing the runtime epoch.

Attachment creation and reconsent carry the resource and credential consent
epochs displayed during confirmation. The transaction compares both with the
locked current configuration; a stale confirmation cannot create or update an
attachment. Inspecting an attachment returns these current epochs, and credential
inventory exposes its consent epoch. Account and attachment revisions are
additional checks, not substitutes for the reviewed configuration versions.

Before first personal consent, active Space members can use `list_offers` and
`list_offer_models` to read approved Space and selected-project offers. These
bounded pages expose the recipient, allowed disclosure, current consent epochs
and model metadata. They exclude personal attachments, secrets, expired or stale
offers and inaccessible projects. Current membership and history are revalidated
on each page; cursors bind the actor, scope and project filter. Inventory and
configuration management remain owner-only. Concurrent offer reads use shared
admission locks. Confirmation still validates the displayed configuration epochs
in its own transaction.

Provider transactions acquire user authority, then Space admission, then resource
and credential locks before registering calls or revocations. Current membership
checks do not upgrade a shared Space lock after acquiring a resource. Attachment
creation, approval and inspection acquire their Space share first. Replacing a
shared default takes an exclusive Space lock first to serialize edits across
resource owners. All locks remain subject to the existing transaction budgets.

Every source Space needs the sender's personal attachment consent. Shared content
also requires a currently approved Space or project attachment. Project-only
approval checks each source's current canonical ancestry; a selected project is
not evidence that unrelated content belongs to it. Shared disclosure excludes
profiles, and encrypted notes never leave through a provider. Consent expiry
limits the active request deadline. Without explicit resource/model selection,
preference order is personal, project, then Space, keyed separately by
`PreferenceModelKind` (`Completion` versus `Embedding`). An invalid configured preference
fails instead of silently switching providers.

Search embeddings use either a typed query or source-bound parts. Query
admission checks the caller's taint, requested classes, and project scope.
For a folder-scoped query with project consent, the canonical egress lease
pins the requested folder's current membership in that project through dispatch.
Background search indexing supports a narrowly scoped `SearchIndexing`
credential for the revision actor under current disclosure consent. An
ineligible author in a shared Space receives no grant for that note. The model
token limit applies to the sum across a batch. See [search embeddings](search.md#embeddings).

Supported wire protocols are OpenAI-compatible chat completions/embeddings and
Ollama chat/embed (stored openly as bounded text in SQL so future wire adapters do
not require table rewrites). Base URL paths are preserved, OpenAI-compatible
requests omit vendor-proprietary `"store"` fields, and Ollama requests omit forced
full-window `"num_ctx"` overrides. Provider responses may return a non-empty
snapshot/deployment model identifier (`gpt-4o-2024-08-06`, `:latest`), null SSE
delta fields, empty tool outputs, `omitempty` zero Ollama eval counts and
`done_reason: "tool_calls"`. SSE/NDJSON parsers handle arbitrary byte boundaries and bound
frames and assembled tools; embedding responses require an exact index bijection,
expected dimension and finite values. Reasoning fields are not exposed as text.
Tools, usage and finish events are released only after valid completion and durable
settlement; text can arrive earlier. Typed stream errors carry no upstream bodies.

Completion input admission checks `request.budget.max_input_tokens <= model.max_input_tokens`
and bounds a conservative UTF-8 scalar token estimate (`1/3` token per 1-byte scalar, `1/2`
per 2-byte scalar, `1` per 3/4-byte scalar, plus framing and tool-schema overhead) against
`request.budget.max_input_tokens`, reserving `estimated_input_tokens + request.budget.max_output_tokens`;
embedding calls require `declared_tokens <= model.max_input_tokens` and check/reserve
`max(declared_tokens, estimated_chunk_tokens)`. Resource, credential and every
participating Space each pay the reserved call against atomic UTC-aligned 60-second
RPM/TPM buckets. The primary Space is charged even for orchestration-only input.

The intent ledger binds principal, history scope, command key and semantic input.
A repeated accepted intent reports its existing call state, even after configuration
changes; different input rejects the reused key. No stream is replayed or resent.
After reservation, the service rechecks current authority/configuration/consent,
changes intent to sending and acquires its live registration in one SQL transaction.
The transport handle exists before awaiting response headers. Shutdown acknowledgement
precedes release of canonical/registry leases and the independent five-second audit
finalizer. `ProviderConfig.max_active_calls` (default 64 per `ProviderService`
instance) bounds active worker lifetimes. Dropping
a stream or pending unary future cancels that operation without cancelling a shared
parent token. A protocol terminal marker closes the socket without waiting for TCP EOF.

Proven unsent calls refund RPM and TPM. Unknown/partial/cancelled calls retain
reservations until the original window expires. Exact usage reconciles that window
and records full input/output counters; if a provider returns slightly more tokens
than requested, the valid completion still succeeds and records `BudgetMismatch`
in audit diagnostics without locking out other users on the resource. An
unrepresentable bucket aggregate saturates to its maximum and closes admission;
individual call counters remain exact. Late usage enriches the audit without
crediting a later window. Ledger records contain no prompts, responses or headers.

Connection checks are bounded GET model-list requests with no inference, TPM zero
and a null model ID in the audit. They still require owner authority and RPM
admission. Composition must drain bounded `recover_calls` pages at startup and
periodically using `ProviderRecovery` authority. Age of at least 300 seconds only
selects candidates: the registry must atomically exclude live calls before recovery
settles unknown spending. Failed finalization remains recoverable; recovery never
resends or refunds an abandoned call on an assumption that it was unsent.

## Episodes, context references and abilities

Episodes belong to an account, independent of its browser sessions. New episodes
have explicit IDs and replayable commands. An active ID forks a fresh episode;
a sleeping episode or one idle for at least 30 minutes resumes. Forks copy separate
acknowledgement rows. Name lookup returns bounded ID/name choices when ambiguous.
Updates use both account and episode revision CAS. Closed episodes cannot resume.
Activity touches are throttled to once per minute; the stored touch counter is not
an exact transport-call total.

Acknowledgements are monotonic MAX values keyed by owner or episode, Space and
history incarnation. The catalog checks the current history and delivered sequence
ceiling. They never combine unrelated Spaces. Concurrent acknowledgements may use
the same observed account revision: this commutative operation fingerprints it but
does not impose an account CAS precondition. Reads project saved references through
current authority. Unavailable project/role selections produce diagnostics instead
of disclosing their metadata or silently choosing a replacement.

`ContextAdminPort` stores reference bundles, attachments, pins, order and typed
Note/Folder favorites. Bundles contain at most 200 references and have at most 64
attachments. Shared pins and ordering entries are unique across editors. A bundle
attachment grants no content access. Editing a shared bundle requires authority on
its home and new references; subscribers cannot prevent an authorized edit by
attaching it to a private Space. Ordered Space locks, a bounded attachment-set
comparison and revision invalidation keep concurrent edits coherent. Consumers'
content permissions remain independent. Deletion removes dangling order entries.

Bootstrap selection accepts an optional current Space. It must match an available
saved project; otherwise the caller must explicitly update the episode. Selection
orders project, Space, personal context and favorites, retaining each NoteRef's
first occurrence via bounded in-memory deduplication over indexed SQL reads before
keyset paging. Each page checks
at most 200 candidate notes; an empty filtered page can still have a continuation.
Folder favorites are never expanded into a corpus. Cursors bind authority, episode
selection and metadata revisions. `users.metadata_revision` changes with reference
preferences; the separate account CAS revision also changes for acknowledgements,
which do not invalidate an unchanged preference page.

The catalog owns current note/folder facts, current ability tips and immutable
package revisions. Control stores availability, selected-project bindings, personal
preferences and typed placement trails. Effective precedence is project, Space,
personal, then System. A disabled, unhealthy or wrong-kind candidate shadows lower
precedence; equal-precedence ambiguity fails rather than choosing arbitrarily.
Exact selections and `get_ability` accept an optional contextual `project` so
selected-project Space abilities resolve consistently, and reject stale revisions.
Both paths enforce canonical visibility at publication and at the current location
before returning the descriptor or its auxiliary file names.
Trails bind exact typed references, stop
at 16 hops and reject cycles. Discovery preserves continuation across filtered
pages and never emits a lower candidate as a duplicate of the selected winner.
`ControlPort` / `ControlPlane` also exposes episode touches, ability preferences
and trails, and `mcp_dedup` idempotency lookup/recording.
Authoring requires interactive human authority and `AbilityWrite`; package content
remains canonical-owned.

Memory targets are fixed account/project/category references. Categories are
bounded lowercase slugs, not filesystem paths. Control verifies current authority,
project ancestry and AgentMemory write permission, then asks the idempotent canonical
owner to resolve or create the target. It never writes a second copy of note bodies.

## Schedule persistence and run authority

Schedule creation and updates require an interactive owner with current Editor or
Owner membership and AgentMemory write permission. Account and schedule revisions
provide separate CAS checks. A schedule's Space is immutable; a project is an exact
FolderRef. Approved roles must be readable, healthy, enabled and at their exact
current revision. Pausing the exact existing definition remains possible after
its role or project disappears. Definitions contain a private title and initial prompt, redacted
in Debug; receipts persist the schedule ID, not that private payload. Titles allow
128 scalars/512 UTF-8 bytes and prompts 32 KiB. Cron expressions include seconds,
require a minimum interval of 60 seconds, and
are validated with `cron`; timezones use the IANA `chrono-tz` catalog. A supplied
slot must match the expression in that timezone, including second precision, while
`list_due_schedules(now)` floors sub-millisecond wall-clock timestamps to whole
milliseconds. Soft-deleting a schedule clears `init_prompt` on the tombstone row.

Run limits default to 25 steps, 100,000 tokens and 300 seconds. The composition sets
`ControlConfig.schedule_limits` within hard ceilings of 1,000 steps, 10,000,000 tokens
and one hour. These limits bound a whole run; per-call provider budgets remain
separate. Only AgentMemory writes are admitted. The ticker, slot computation, prompt
loading and tool loop are consumer responsibilities.

Trusted `Scheduler` authority lists due schedules, claims slots and records terminal
results. A claim checks the expected revision, saved slot, current owner/membership,
Space/project and exact role. Role drift pauses the schedule. The unique
`(schedule, slot)` run row and next-slot advancement commit together. Only the new
winner receives a non-deserializable ScheduledRun credential and Keeper context.
Exact retries return `AlreadyClaimed` inspection receipts, including after restart;
changed claim payloads conflict. A lost response never authorizes a second execution.
The next distinct due slot can still be claimed through its fresh revision.

Each scheduled effect checks the owner auth version, current membership, Space
admission/history, run lease/status/expiry and schedule configuration revision,
then intersects the original delegation. The context has one Space, an optional
project pin, no `AbilityWrite`, AgentMemory writes and a read-only approved role.
Provider deadlines also respect run expiry. Advancing the next slot changes the
ordinary schedule revision; interactive edits change `config_revision` as well.
Thus a later slot does not revoke an earlier active run. Configuration edits,
pause/delete and terminal results use the durable SQL-to-registry revocation fence
and wait for shutdown acknowledgement. Deletion retains audit rows and the ID.
Canonical role mutation is checked on a new claim; an already active run still
requires the canonical content lease at provider dispatch.

Terminal Succeeded/Failed/Unknown results require the exact run and lease. They can
finish audit after expiry or schedule deletion, but cannot mint authority or change
any next slot. An identical terminal result is idempotent; a different result
conflicts. Owner or trusted scheduler readers inspect bounded run pages without
recovering dispatch permission. Due and audit pages are keyset views, not retained
SQL snapshots; the ticker must revisit due work as the database changes.

## Content-free telemetry and retention

`AgentTelemetryPort` accepts fixed operation, transport, effect, outcome and failure
enums, typed resource references, counts and durations. Its DTOs have no raw prompt,
header, token, provider-error or tool-result fields. Detailed payloads reject unknown
fields, allow at most 200 entries per collection and fit in 64 KiB. Capture is off
by default. Only an interactive instance administrator can change settings through
account and settings revision CAS.

Begin records bind current owner authority and the actual request payload. Exact
repeats are idempotent; changed payloads conflict. Trusted `Telemetry` authority can
finish a pending audit after the initiating credential expires, without granting
any tool permission; backward NTP clock steps clamp `duration_ms` to zero rather
than rejecting completion. Detailed capture follows the current explicit setting. Call
lists contain compact metadata; individual detail reads filter references through
current authority. Retrieval records store typed references and finite scores, not
query text. Logging middleware remains outside this crate.

Compact retention defaults to 90 days and detail retention to 30 days. A batched
cleanup transaction deletes at most 200 rows across expired details, retrievals,
terminal calls (plus orphaned unfinished calls older than 24 hours), committed
command receipts (retained only while their own canonical operation or a
contemporaneous revocation event is still pending), and the 12 growing operational
tables: 24 hours after expiry for one-time tokens, OAuth auth codes/access tokens,
OIDC transactions, `mcp_dedup` entries and closed provider budget buckets; 7 days
after expiry/revocation/completion for sessions, OAuth refresh tokens and childless
expired or revoked refresh families, delivered revocation events and committed control
operations; and `compact_retention_days` for settled provider call logs, terminal
schedule runs and childless deleted schedule tombstones. Active calls, their
retrievals and pending commands survive. Cleanup never settles or
re-executes live schedule/provider runs.

## Verification

Run `make setup`, `make check`, `make test` and `make build`. The database suite
requires the disposable PostgreSQL fixture created by the Make wrapper; it never
silently skips PostgreSQL. It compares the full table manifest and representative
constraints, verifies transactional rollback and tests export snapshot retention
on SQLite and PostgreSQL. Authentication tests exercise secret issuance, callback
failure/replay, pending canonical creation, owner races and lifecycle recovery.
Provider tests use actual offline TLS/HTTP and independent SQL pools to exercise
single-send intent races, shared budgets, current egress denial, model usage,
credential rotation, consent expiry and cancellation before/after response headers.
They do not certify the unimplemented services or a production transport's live
registry.

Backup tests exercise both databases, cross-process SQLite writers, idle retention,
phase cancellation, native writer drain, caller runtime shutdown, artifact recovery,
framed stream corruption and cursor restoration. They also record control-only
pause distributions under concurrent writes. See [backup verification](control-backup.md#verification).
