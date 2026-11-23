# MCP tools, chat runs and Keepers

`notarium-agents` implements the tool registry, chat supervisor and Keeper
scheduler as Rust library services. They consume core ports for control,
canonical storage, projections and search. Product MCP, HTTP and SSE routing,
browser permission checks and application startup belong to the transport and
composition layers.

## Tool registry

`ToolRegistry` uses one set of input schemas for discovery, validation and
provider tools. An external read PAT or OAuth token discovers 12 of the 28
names, including full inspection of visible abilities. A write token
discovers all 28. Invocation by name uses the same scope check. Publishing,
editing and trashing ability packages also require live `Cap::AbilityWrite`.
That capability requires a separate interactive attestation or a durable
write-token opt-in, and is unavailable to chat runs and Keepers. See the
[tool name and port mapping](core-contracts.md#port-operation-coverage).

Use the same command key when retrying a logical request within the seven-day
tool journal window. The registry binds it to the credential and normalized
arguments. Compound actions reserve a content-free plan and use canonical
receipts for individual effects. Each external corpus mutation registers its
credential and target Space with Control, including intermediate folder creation.
The canonical writer acquires the registration under its storage locks,
checks the earlier of the call deadline and credential expiry before commit,
and holds the registration through transaction settlement. Tool
telemetry records typed operations, references and counters. Each result
includes self-contained Markdown in `content[0].text` and machine-readable
fields in `structuredContent`. The text contains the revision and continuation
values needed for the next call and escapes untrusted control tags. Explicit
role and skill activation preserves the selected instruction bodies.
Ability binding and promotion retries preserve the package and binding
preconditions when an unrelated account change advances the account revision.

`create_note` requires an unused destination and accepts the legacy optional
`versionToken`. `create_notes` commits each item independently and returns
outcomes in input order. A `toTitle` link becomes a stable ID when exactly one
committed item matches the title. Otherwise, the link remains authored by
title. The tool journals each item's link decision before the edit, so retries
recover the same receipt even when another item later succeeds. A `linkError`
on a successful item reports an unconfirmed link upgrade.
Confirmed creation proposals persist the title links shown during review.

`start_session` opens an episode by starting, resuming or forking it. Pass the
returned `session.id` on subsequent calls to keep the episode active.
Folder listing, moves and renames resolve relative paths using the explicit
project, then the project bound to the episode. Follow `delta.nextAction` to
drain the bootstrap delta. Continuations bind the caller, episode and original
Space cuts.
When acknowledgement is enabled, the next continuation or final
`deliveryReceipt` advances only to the last delivered complete command.
Pass `acknowledge: false` to inspect without advancing the saved cursor.
After a continuation expires, resume the episode from its last acknowledged
boundary.

`SystemAbilityCatalog` exposes the shipped `research` and `grooming` roles and
their supporting skills. Supply the same decorated catalog to control inventory
and provider disclosure. Owned packages resolve through the canonical catalog
and runtime activation pins their exact revisions. Directory browsing uses
canonical folder paths and cover notes. Search, recall and detailed note views
delegate to the injected ports. Recall budgets apply to approved chunks, with
a per-source token cap that defaults to half the requested budget.
External results use the current class and read fences. Provider results also
require consent for the actual source and its project placement. Encrypted
notes are excluded from both surfaces.

Search and recall use the configured embedding provider for clean query text
within a run's pinned Space under the same provider, project and class consent
as external MCP calls. Opening a projection in another Space taints the branch
before vector search runs. An unavailable remote embedding leaves full-text
matches available and reports `provider_unavailable`. A scheduled Keeper's
approved role and skills must still be current at dispatch. The embedding
request carries only the query text.

## Chat runs and confirmation

`AgentRunSupervisor` drives completion and tool calls for a canonical branch.
A Personal run pins writes to its personal Space. External content reads taint
that branch and its descendants. A reversible note or memory action with a
tainted branch or an out-of-Space target can produce a proposal when the
interactive owner has permission on the target. The tool entry records the
action and observed revision or expected absence. The supervisor emits an
approval event without applying the action.

The owner inspects and applies the proposal with current interactive authority.
Confirmation identifies its thread, entry and digest. Control revalidates
the credential independently for read and write, so reading the tainted
branch cannot taint the write context. Canonical storage checks the exact
proposal and its model turn before applying each step. The observed revision
or absence guards the effect and a repeated confirmation returns its receipt.
Applying a proposal requires no provider call. Revocation covers the
credential and both the proposal source and destination Spaces. A queued
operation can be cancelled before it acquires the canonical writer. Once its
effect enters the transaction, it holds the authority lease through settlement.

A SpaceGroup run is confined to its shared Space. The queue admits up to 16
pending inputs per thread. Enqueue and run completion serialize on the current
run, so an accepted input remains reachable during handoff. The supervisor
revalidates the queued sender and preserves their selected run options. If the
first append to an idle thread loses its acknowledgement, a retry with the same
identity can start the reply once while the original sender registration is
live. Completed submissions return their original receipt. A
queued input after an intervening peer message is materialized as an ordinary
Human entry from its sender. Starting a new run requires a separate activation.
Redaction erases the peer body and retains the minimum author and turn
classification needed for this rule. Repeating a committed redaction preserves
streams opened against the updated history. Peer messages reach the model with their
canonical author and an untrusted-content marker. The initiating principal
can stop its run. Stopping another participant's run requires current Owner
or Editor access to the Space. The supervisor holds the authority lease through
cancellation of that specific run.

Provider dispatch rechecks every canonical source used by the prompt, including
the dependencies of prior Tool, Model and Compaction entries. Admission uses
current membership, document classes, source projects and the selected
provider's consent. A note disclosure binds the note class and nearest project
at disclosure. Moving a note can invalidate its prior disclosures even when its
revision and bytes stay the same. If admission fails, choose an authorized
provider or an earlier clean branch. Canonical storage folds verified entries
from the same thread into a derived entry's source proof. External dependencies
keep their individual digests and current disclosure checks. Redaction invalidates
later folded proofs in the thread and dependent summaries. The original source
edges remain available to recompute the proof on surviving branches. Legacy
proofs are traversed in bounded read snapshots, each tied to the original
thread revision and Space incarnation within the caller's deadline.
Automatic compaction records the covered prefix and keeps newer turns in the
next prompt. When a group accumulates more than 200 entries between AI
activations, the supervisor summarizes the oldest remaining prefix in bounded
windows before answering the latest message. Each window uses the selected
branch and retains its source proofs. Tombstones contribute no content to a summary. Surviving entries
retain their source proofs and may block a request when a source was redacted.
If a run stops between tool results, the next prompt replays only calls with
recorded responses. It includes unpaired tool output as labelled historical
data. Each retained part keeps its canonical source through compaction.
The full parent chain remains available through `read_chat`.
Run rollback uses canonical mutation provenance to undo eligible note effects
while preserving later manual edits. Retrying the same run and command key
returns the original rollback receipt under current authorization. The writer checks every
note and board view named in the stored response against current access, including
notes skipped because of manual edits or an active room. Purging a referenced
note erases new receipt details. The remaining envelope contains the receipt
token and empty result lists.

## Stream replay and runtime ownership

Each run retains a 64 KiB ring of complete JSON frames with monotonic byte
offsets. Each frame is at most 16 KiB before SSE framing. Resume only at a frame
boundary for the same run. Use the frame end offset as the event ID. If the
cursor has fallen behind or cannot be resumed, `CatchUpRequired` supplies the
committed leaf and a matching stream cursor. Read that canonical snapshot,
discard partial step output identified in the checkpoint and then consume live
frames. Use canonical entry sequence numbers to reconcile committed events.
Disconnecting a viewer releases its subscription while the admitted run
continues. A viewer's own credential expiry closes both replay and live
delivery, including while the viewer is waiting for the next frame. A provider
token limit or content filter preserves the partial model text and the
interruption reason in the model entry and ends the run with a failure event.

Local composition supplies an exclusive open data-root writer and shares a
`RevocationHub` across the supervisor and control/provider services.
Revocation fences close matching admissions and cancel active calls and
viewers.

Clustered composition supplies `ClusterRunAuthority` tied to the active
Space writer. Enroll each serving instance's local hub in the shared
revocation authority, and use that authority for control's provider fences.
`RunOwnershipRequest.transition` distinguishes `Vacant` admission from
`Handoff` to a successor under the current writer and `Recover` after the
predecessor is fenced. Losing the writer lease cancels the run and closes the
writer's viewer subscriptions. `ClusterRunAuthority::admit_chat_write` checks
the active run owner or the idle Space writer before looking up an existing
input receipt or committing a durable chat write. Losing the route cancels the
command.

## Scheduled Keepers

`KeeperScheduler` polls durable due slots and runs with an admitted
`ScheduledRun` credential. Applications drive `poll` with their clock and
cancellation token. Polling admits newly due schedules while earlier runs are
active, up to the shared worker limit. `tick(now)` waits for the runs from one
due scan. Each slot has one winner. When the provider truncates or filters a
reply, the log retains the partial model text and its interruption reason, and
the receipt records failure.
Reconciliation records expired unfinished runs as `Unknown` after ownership
checks. Clustered composition supplies `ClusterKeeperAuthority` for slot
leases and positive evidence that an expired run has no live owner.

A missed series of slots results in one catch-up run. The cron calendar uses
IANA timezones and chooses the earlier UTC instant of a repeated local time.
A skipped local time has no slot. A finite calendar issues its final run and
records exhaustion.

The schedule pins an approved role and its nested skill revisions. A mismatch
pauses the schedule with `RoleChanged` before a provider request. The owner
reviews the new references before re-approval. The run has no browser session
or episode. It uses the owner's provider budget, can write AgentMemory in its
admitted scope and appends only to the Keeper log bound to its schedule and
exact Space/project. Changing that scope chooses a separate log.

See [control schedule authority](control.md#schedule-persistence-and-run-authority)
for the durable claim and credential contracts.

## Verification

`make test` runs unit tests for tool schemas, cursor boundaries, stream framing,
permission fences and calendar behavior. The
`fitness-gates` integration suite in `tests/agents_runtime.rs` composes the
registry and runtimes with SQLite and PostgreSQL 16 storage and offline
loopback providers. The project-scoped MCP test runs the projection and
search engines against SQLite, then checks listing, inline views, search
and recall after canonical writes. Fault-injection fixtures exercise retries
and lost acknowledgements. Canonical and control tests cover database receipts,
schema upgrades and recovery. HTTP transport and production cluster authority have separate
integration requirements.

### First Keeper rollback

The release integration test times the first public supervisor rollback of nine
changed memory notes. It includes live authorization, the registered collaboration
hub and the durable commit. Each test also verifies all nine restored digests
and the receipt returned by a retry after the timer stops.

Choose the [High or Medium reference](storage-performance.md#reference-configurations-and-results)
before running the benchmark. The table gives the time limit for **each** measured
call and the observed distribution used to select it. All values are milliseconds.

| Reference | Database | Median | p95 | Slowest call | Per-call limit |
| --- | --- | ---: | ---: | ---: | ---: |
| High | SQLite | 2.571 | 6.352 | 61.359 | <74 |
| High | PostgreSQL | 4.547 | 10.652 | 90.519 | <109 |
| Medium | SQLite | 6.180 | 9.006 | 15.333 | <19 |
| Medium | PostgreSQL | 11.523 | 17.250 | 122.331 | <147 |

Calibration used four series of 20 fresh calls per database on each reference
(runtime `1dc5daf1`). Each limit is the observed maximum plus 20% headroom,
rounded up to a whole millisecond. One High series had several long calls on
both databases during elevated host I/O pressure. One Medium PostgreSQL call
took 122.331 ms. Compare median and p95 across
runs to detect shifts in ordinary latency. The per-call limit covers observed
tail variation on these reference systems. The component benchmark measures
the p95 of 1,000 canonical storage commands separately.

Run the following command from the checkout root on a quiet reference system.
Use a disk-backed Cargo target for SQLite WAL with `synchronous=FULL` and a
disk-backed Docker data volume for PostgreSQL 16 with `fsync`, `full_page_writes`
and `synchronous_commit` enabled. Each invocation starts a new PostgreSQL volume
and runs both backends sequentially. Sample 0 warms the fixture. Samples 1–20
use fresh state and must each finish strictly below the selected limit for their
database. Qualify a reference with three complete invocations, retaining all
individual timings and test outcomes.

```sh
sh scripts/control-db-fixture.sh run-durable sh .devkit/runtime/devkit.sh cli exec \
  --component apps/api --network none -- sh -ec '
    for sample in $(seq 0 20); do
      echo "ROLLBACK_SAMPLE $sample"
      cargo test --release --locked --offline -p fitness-gates --test agents_runtime \
        keeper_turn_cases:: -- --nocapture --test-threads=1
    done'
```

Each sample must report two passing tests and a `Product rollback sample` in
microseconds for each database with nine restored memories. Cargo checks the
restored state and replay. Compare the reported times with the selected row.
