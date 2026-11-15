# Core contracts

`notarium-core` implements pure domain values, authorization checks and the port
interfaces below. Storage, collaboration, transports and backup adapters belong
to later deliveries. The [crate dependency matrix](architecture.md) stays in force.

## Values and admission

ID brands preserve their exact spelling. Minted v1 IDs contain a type prefix and
32 lowercase hexadecimal digits; checked legacy IDs retain their existing
12-character URL-safe or 16-character hexadecimal spelling. Constructors take
caller-supplied entropy. Sequence newtypes reject values above signed 64-bit
storage limits and checked increments never wrap. Dates validate the calendar;
timestamps normalize RFC 3339 offsets without dropping nanosecond precision.
The domain accepts UTC years 0000–9999 and at most nine fractional digits.
Out-of-range UTC conversions and leap seconds return `InvalidTimestamp`; they
are never clamped to a different instant.

Credential key IDs have a separate native grammar: `ck_` followed by 24 lowercase
hexadecimal digits derived from twelve HKDF output bytes. They do not use the
generic ID minting or legacy-ID parser.

`StorageEpochFacts` describes observations made by the runtime. The pure
classifier distinguishes an evidenced empty root, ready v1, migration in progress,
incompatible and damaged states. Missing, invalid and unreadable observations
remain different; an I/O error cannot authorize initialization. `DataRoot` only
constructs the shared layout from a supplied path.

Verified authority enters through trusted owners, not deserialization of an auth
context. Delegation intersects role, class and project grants. Agent, Keeper and
OAuth and PAT contexts cannot obtain human `AbilityWrite`. Both old and new resource facts
are checked on direct writes, including auxiliary ability files. A run pins its
write Space; an external read taints already-existing clones before content returns.
Shared chat limits reads to its Space and excludes the sender's profile.
Nested Keeper runs can retain or drop approved package read exceptions; they
cannot add exceptions outside their parent's project authority.

Canonical owners create classified documents. `ClassEgressFence` creates private
projection/search/provider wrappers only after read, lifecycle and class checks.
Encrypted documents have no secondary egress. Provider wrappers also bind the
selected provider and consent audience. Completion messages distinguish document
content from committed chat entries; chat has its own provenance and taint check.
These constructors are trusted in-process boundaries, not isolation from malicious
Rust code that controls the canonical/admission owner. Adapters must recheck live
visibility and revocation at use time.

Explicit snapshots expose lifecycle. Listings select active, trashed or both
through `LifecycleMask` and return `NoteListCard` metadata, including encrypted
identities, without a content capability. Purged documents cannot be read/listed.
Search, graph and view cards use active-only `SearchMetadata`, admitted through
the same class, lifecycle and read fences. `ClassifiedMetadata` carries canonical
identity, revision, digest and resource facts without carrier bytes. Narrow card
hydration and explicit listings therefore need no whole-document load or dummy
content under a real revision. Full reads, indexing and provider parts retain
their distinct content capabilities.

Structural snapshots own their immutable generation and history cut. Neighbor
and subtree traversal returns `DenseNodeIter`, binding compact `u32` indices to
that generation lazily. CSR slices require no allocation or expanded edge array;
compressed sets may supply a boxed lazy iterator without materializing members.
Each yielded `DenseNodeId` still rejects use in another generation. The iterator
borrows its snapshot; current visibility remains a separate canonical fence, and
async card hydration preserves requested ordering and absent entries.

Protected package reads select an exact AbilityId, package revision and entrypoint
or auxiliary manifest key through `NoteReadPort::read_ability_resource`. Auxiliary
files need no synthetic NoteId. The canonical owner checks current visibility and
history before returning a `ClassifiedAbilityResource`; absent revisions never
fall back to latest. Explicit reads require authority, and provider use additionally
requires an active package and consent through `ClassEgressFence::ability`.

`ContentPart` binds an extracted chunk to the original shared canonical document,
source digest, body ranges and source heading context. It verifies that the exact
selected text can be reconstructed from those ranges with fixed separators;
foreign text and stale source identities are rejected. `SearchPart` and
`ProviderPart` retain the same lifecycle/class/authority/consent fences. Embedding
and recall use these parts without relabelling a fragment as a whole document.
The tokenizer owner attests the model, token count and cache key; provider owners
validate model/provider bindings, declared totals and the actual serving budget.

## History and causal reads

`HistoryIncarnation` is an opaque 128-bit identity owned by each canonical Space.
It survives normal restarts and changes before serving a restored history.
It is distinct from the storage schema version, installation ID and lease epoch.
Core validates supplied bytes and facts without clocks, entropy or I/O.

Receipts carry `(SpaceId, HistoryIncarnation, committed SpaceSeq)` with `seq > 0`.
Change cursors allow `seq = 0`. External change/SSE cursors, acknowledgements,
keysets, RYOW requests and mutations carry the expected history. Authorization
and history checks precede sequence comparisons, snapshot lookup and idempotency
lookup. A mismatch returns a typed `history_incarnation_mismatch` validation
reason requiring resynchronization. It never silently restarts pagination.

Restoring sequence 100 after a client received 101 must reject that client's old
token, even when a different new mutation reaches 101. Restore invalidates old
snapshot handles, streams and idempotency namespaces. Internal saved ack cursors
are clamped to restored ceilings and rebound during the same cutover; this does
not make external old tokens valid. Mutations retried with stale history must
not become new writes. Idempotency is scoped by history, Space, actor and command
key; a reused key with a different command hash is rejected.

`ReceiptSet` retains up to eight exact unique receipts, including different
sequences from the same Space. Only exact duplicates are removed. A receipt can
be discarded after confirmed projector catch-up in its history. A separate
`AwaitWatermarks` type takes the maximum sequence per history scope solely for
waiting for full catch-up; it cannot select individual mutations for an overlay.

Example: move card X at 101, import 50,000 unrelated changes, then move Y at
50,102. An overlay over snapshot 100 needs both receipts to show both moves and
correct group counts. Keeping only 50,102 loses X. More than eight receipts is
an explicit request error or a wait-only catch-up path, never silent truncation.
A committed mutation always returns its receipt even if a client buffer is full.

The trusted projection planner also checks the effect budget: at most eight
distinct affected notes and a bounded payload with exact versions applicable to
the chosen cut. Several receipts for one note must not double-count its groups.
Bulk rollback, structural folder moves and unknown or unrepresentable effects
use wait-only catch-up for the entire causal read. One receipt changing 100 notes
cannot use a `LIMIT + 8` candidate window. The result is a caught-up snapshot or
an explicit deadline/stale error, never a partial result labelled causal success.

Pagination binds an `EffectiveReadId` to the immutable base cut and exact overlay
row/rank versions. `OpenRead` accepts the causal basis; `ContinueRead` uses that
same effective read regardless of SDK receipt eviction or projector catch-up.
New receipts start a new read. Retention expiry or missing versions returns
`cursor_stale`; continuation never silently refreshes its overlay. Rows, counts
and sort tuples use the same versions, with the current lifecycle fence applied.

For example, base A=1, B=2, C=3 plus an overlay C=0 returns C on page one.
Dropping the overlay on continuation would return A, B, C and duplicate C.
The effective-read identity prevents that change of basis.

Keysets carry the paginated entity's branded identity: note reads use NoteId,
job reads use JobId. Cold change seeds enumerate notes before chat threads with
a typed `SeedPosition`. `ContinueSeed` retains the original history, cutoff and
page limit, including when the snapshot contains only threads. Completion returns
the cutoff from which durable change-log consumption resumes.

## Field ordering and errors

Fields retain `Ok(value)`, `Bad` and `Absent`; null, empty string and empty list
are distinct. Field sorting has this total order:

1. Non-null sortable scalar values.
2. Valid null values in a nullable schema.
3. Bad values.
4. Absent values.

Descending order reverses only scalar values. The final `NoteId` tie-breaker
always stays ascending. Strings compare original Unicode scalar values without
locale or case folding; booleans use false before true. Numbers compare exact
represented values without lossy integer-to-float casts. The pinned JSON
configuration preserves finite float values across cursor serialization and
deserialization, including adjacent values and subnormals. Dates and timestamps
are separate types. A sort key has one schema type; incompatible observations
are Bad. Lists and maps, including empty lists, produce `unsupported_sort_type`;
there is no implicit minimum, first-item or string conversion. Keysets bind the
history, query, schema, class/scope, generation/cut and complete last sort tuple.

Pure helpers return `DomainError`. Async ports and stream operations return
`PortError`: `Domain(DomainError)`, `Cancelled`, `DeadlineExceeded`, `Unavailable`
or `Internal`. Operational errors carry a safe diagnostic reference, commit
effect (`NotCommitted` or `Unknown`) and explicit retry advice. A timeout does
not promise rollback. Confirmed commit returns success with its receipt.

Retry advice permits a mutation retry only with the same idempotent command key,
hash and authority scope, including history for canonical Space operations.
Unknown outcomes for non-idempotent operations require
reconciliation. Provider errors and secrets never become arbitrary error text.
Transport-specific error mapping belongs to the HTTP/MCP owner.

## Call contexts match their authority scope

Only request identity, cancellation and deadline budgets are universal.
Context types distinguish these cases instead of optional auth or dummy IDs:

| Context | Operations | Required authority |
| --- | --- | --- |
| PreAuth | Resolve credentials | Evidence and budget; verified auth is the result |
| Account | Whoami, accessible Spaces, account episodes and preferences | Verified account principal/grants; each scoped reference or ack is checked separately |
| ExistingSpace | Engine mutations/reads and scoped control/content requests | Verified auth, Space and expected history |
| Maintenance | Internal change workers, event publication, revocation, paired backup | Trusted service authority admitted by the owning runtime; scoped payloads still retain their history |

CreateSpace uses Account authority. Account commands use owner/actor/key/hash and
control preconditions, without a fake Space receipt; their owner must explicitly
provide any idempotency guarantee before retry is allowed. Service authority is
not deserializable from external requests and grants no human content capability.
Public subscriptions and revocations first pass verified scope/admission checks.

## Complete mutation intent across live rooms

The live interceptor receives a typed mutation with the original authorization,
history, command identity and preconditions. `MoveBoardCard` preserves its view
identity, target group, neighbour rank references, field changes and expected
note/view/rank revisions. Equal field changes with different neighbours remain
different commands.

`Applied(receipt)` requires one canonical commit of the complete field/rank
change. A rank conflict must not publish a partial field or CRDT update. The
room owner performs the commit; the outer writer does not commit it again.
Closed-room writes consume a reservation under a commit fence, avoiding the
race between checking whether a room is open and writing directly.

Live text uses a body-relative plan and verifies the authoritative body identity
and hash; a canonical revision alone may lag the room. Raw header changes retain
their own checked plan, including comment-only changes that semantic field
overrides cannot express. See [syntax](syntax.md).

## Backup snapshot lifetime

Backup preparation and copying occur outside the paired writer pause. The pause
pins both control and canonical database snapshots before resuming writers.
In SQLite, `BEGIN DEFERRED; SELECT 1` does not pin a database snapshot; an actual
database read is required. Both snapshots must retain the same original cut.

The ordinary read-transaction budget remains below 250 ms. Backup source
snapshots have a bounded exception until a stable local database spool exists
or the backup aborts. Incremental backup steps do not shorten this lifetime or
eliminate its WAL checkpoint impact. Budgets specify a deadline, spool bytes and
backend-specific retention: pinned WAL bytes for SQLite or snapshot age for
PostgreSQL. A budget/progress backend mismatch fails closed. PostgreSQL does not
report a synthetic WAL metric. Exceeding a budget aborts the backup with cleanup;
interactive writes are not automatically throttled to preserve a backup.

Resume releases the writer pause, not snapshots or the CAS hold. Source snapshots
close after the stable database spool; the reference-counted CAS hold lasts
through blob copying. Uploading a spool does not retain source snapshots.
Cancellation or failure of either participant releases all pauses, snapshots
and holds; incomplete artifacts are never successful backups. Numeric budgets,
adapter compatibility, crash recovery and the target pause below 1 ms require
proof in the storage/backup deliveries, not core test doubles.

## Port operation coverage

Control inventory uses explicit pages of 1–200 items. Continuations belong to
the producer and must remain bound to authorization scope, filters and relevant
revisions. `ControlCatalogPort` provides canonical metadata and idempotent
lifecycle coordination without exposing note bodies or database handles.

`AuthPort` owns bootstrap, password login, native bearer resolution, trusted-none
perimeter admission, account changes, one-time credentials and PATs. Raw secrets
use a non-serializable, redacted zeroizing wrapper. Verified contexts retain
credential lineage, and revalidation can only narrow existing delegation.
Interactive human management requires explicit admission. Membership and lifecycle
changes carry stable command keys; removing a member returns an optional role.
Owner management admission can target an archived Space without granting content
read/write access. Revocation callbacks receive the durable event request ID for
idempotent delivery; a committed mutation cannot return success before their ACK.

Schedule claims carry the next slot computed by the scheduler. A committed claim
advances that slot atomically; repeated claims return an inspection receipt,
without permission to dispatch again. Terminal run results are typed and do not
carry a next slot. These are interface requirements, not a scheduler implementation.

Owner boundaries use object-safe traits and `Send` futures. Streams expose
typed `next` calls. No runtime channel, database transaction, model session or
collaboration document occurs in a signature. `EnginePort` composes note read/write,
chat, view/graph, search and content-job subports. Control owns authentication,
account episodes, abilities, schedules and provider requests. The other boundaries
are structural snapshots, change broadcast, embedding, live interception, events,
revocation and backup participants.

The following 28 tool names are consumer coverage, not a tool registry in core:

| Consumer tools | Typed operations |
| --- | --- |
| `start_session` | Start/resume episode, bootstrap context, acknowledge delta, read changes |
| `list_abilities` | Discover abilities |
| `use_role`, `use_skill` | Resolve exact ability; only role selection updates the episode |
| `whoami`, `get_my_projects` | Principal read, accessible project listing |
| `list_notes`, `recent_activity` | Note listing, scoped activity/change page |
| `search`, `recall` | Search/recall and structural snapshots |
| `get_note`, `get_ability` | Note snapshot/view query, ability descriptor/package read |
| `create_ability`, `edit_ability`, `delete_ability` | Publish protected package, protected lifecycle, binding update |
| `create_note`, `create_notes`, `edit_note` | Create, ordered batch outcomes, edit |
| `remember_about_user`, `remember_about_project` | Resolve fixed memory target, append memory |
| `link`, `link_many` | Typed link and bounded batch |
| `delete_note`, `move_note`, `rename_note` | Note lifecycle and location commands |
| `move_folder`, `rename_folder`, `rename_project` | Stable folder/project mutations |

Chat create/fork/append/queue/consume/redact, board moves, graph tiers, content jobs,
rollback and external file observations have additional typed interfaces. A full
pending-input queue returns `Full` without a mutation receipt. Successful queueing
returns the accepted input and receipt. Limits and authority must also be enforced
by each runtime owner before performing effects; port declarations are not adapters.

Graph nodes and edge endpoints distinguish `GraphNodeId::Note(NoteId)` from
`GraphNodeId::Cluster(ClusterId)`. The projection owner assigns and matches stable
cluster identities across generations within a history scope; representative notes
and generation-local dense indices do not serve as cluster identities. Requests
carry that scope through `SpaceContext`, and results retain it in `SnapshotCut`.
Cluster supernodes have no fabricated note card. A `Lens` may select a cluster,
intersecting its members with the existing project, tag and field filters. An
unknown cluster returns `ResourceNotFound`, without widening the query to the
whole Space. Clustering, identity matching and membership lookup remain projection
owner responsibilities. The existing 500/2000 node caps and 1–2 hop bound remain.

## Verification boundary

Core tests exercise stale history, exact receipts versus
watermarks, nullable keysets, effect/retry errors, complete board intent and
backup cleanup transitions. Compilation of object-safe ports does not certify
runtime latency, durability, WAL limits or concurrency behavior of future adapters.
