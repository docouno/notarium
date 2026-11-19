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
receipts for individual effects. Tool
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
returned `session.id` on subsequent calls. Follow `delta.nextAction` to
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
revalidates the queued sender and preserves their selected run options. A
queued input after an intervening peer message is materialized as an ordinary
Human entry from its sender. Starting a new run requires a separate activation.
Redaction erases the peer body and retains the minimum author and turn
classification needed for this rule. Peer messages reach the model with their
canonical author and an untrusted-content marker.

Provider dispatch rechecks every canonical source used by the prompt, including
the dependencies of prior Tool, Model and Compaction entries. Admission uses
current membership, document classes, source projects and the selected
provider's consent. A note disclosure binds the note class and nearest project
at disclosure. Moving a note can invalidate its prior disclosures even when its
revision and bytes stay the same. If admission fails, choose an authorized
provider or an earlier clean branch. Redaction invalidates dependent summaries.
Automatic compaction records the covered prefix and keeps newer turns in the
next prompt. Tombstones contribute no content to a summary. Surviving entries
retain their source proofs and may block a request when a source was redacted.
The full parent chain remains available through `read_chat`.
Run rollback uses canonical mutation provenance to undo eligible note effects
while preserving later manual edits. Retrying the same run and command key
returns the original rollback receipt under current authorization.

## Stream replay and runtime ownership

Each run retains a 64 KiB ring of complete JSON frames with monotonic byte
offsets. Each frame is at most 16 KiB before SSE framing. Resume only at a frame
boundary for the same run. Use the frame end offset as the event ID. If the
cursor has fallen behind or cannot be resumed, `CatchUpRequired` supplies the
committed leaf and a matching stream cursor. Read that canonical snapshot,
discard partial step output identified in the checkpoint and then consume live
frames. Use canonical entry sequence numbers to reconcile committed events.
Disconnecting a viewer releases its subscription while the admitted run
continues.

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
cancellation token. `tick(now)` runs one due scan. Each slot has one winner.
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
registry and runtimes with real SQLite and PostgreSQL 16 storage, typed
projection/search fixtures and offline loopback provider responses. Canonical
and control tests exercise database receipts, upgrades and recovery at their
own boundaries. HTTP transport and production cluster authority have separate
integration requirements.
