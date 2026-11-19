# Live collaboration

`notarium-collab` provides transport-independent rooms for `UserDoc` notes.
A room serializes commands for one note in one Space. It uses two UTF-16 Yrs
documents so validation and pending writes can stay isolated from the state
visible to peers. Editors can modify notes. Viewers can read the current state
and share presence. The shared types are `Y.Text("body")` for plain Markdown
and `Y.Map("fm_overrides")` for frontmatter changes.

## Session integration

Create a `CollabHub` for a canonical runtime inside Tokio and call `register`
to install the live command interceptor. Keep the hub for the runtime's lifetime
and stop transport ingress before dropping it. After restart or lease takeover,
room admission or maintenance can replay an acknowledged tail left to checkpoint.
At composition time, wrap the shared
session registry with `hub.revocations(registry)` for post-commit revocation
and room settlement. An authenticated transport calls `hub.connect` with its
`SpaceContext`, the note ID and a `CollabSessionAuth`. The latter carries the
same registration lease, cancellation signal and optional absolute expiry
issued by the authentication owner. Autonomous agent and keeper edits enter
through canonical commands.

Send binary payloads with `CollabPeerSession::send`. Call `recv` when the
transport is ready to send the next event, since this call checks the
recipient's current access before releasing data. Flow control stays at this
boundary. `SessionEvent::Close` carries the transport close code and reason.
The HTTP layer supplies the WebSocket upgrade and admission credentials.

## Binary protocol

The inbound payload limit is 2 MiB. The first payload contains exactly one
`LineageHello`. After `LineageReady`, payloads can concatenate standard
y-sync v1 sync and awareness messages. The server sends its initial
`SyncStep1` after `LineageReady`. The protocol decoder discards Viewer
`SyncStep2` and `Update` messages while preserving other messages in
the same payload. The server can concatenate updates or acknowledgements from
a committed batch in one payload. Presence lives in memory and belongs to the
connection that published it. Each peer can own up to eight awareness client IDs
in a room.

Each custom message uses a lib0 unsigned tag followed by a length-prefixed byte
buffer. All custom buffers start with the version byte `1`. The following
table lists the remaining fields in wire order. Integers are lib0 unsigned
varints unless marked `u8`. Strings are length-prefixed UTF-8. An optional
revision uses a `u8` presence flag followed by the string when the flag is 1.

| Tag | Message | Direction | Remaining fields |
| --- | --- | --- | --- |
| 100 | `LineageHello` | Client to server | Mode `u8`. Fresh is 0. Reconnect is 1 followed by history incarnation, lineage epoch, optional base revision. |
| 101 | `LineageReady` | Server to client | History incarnation, lineage epoch, current revision, lease epoch, role `u8` (Viewer 0, Editor 1), frontmatter writable flag `u8` (0 or 1). |
| 102 | `LineageMismatch` | Server to client | Current history incarnation, current revision, current lineage epoch, optional verified base revision. |
| 103 | `ServerAckWatermark` | Server to Editor | Lease epoch, peer write sequence, room update sequence. |
| 104 | `PolicyRejected` | Server to Editor | Policy reason `u8`, safe message string. |

An incarnation occupies 16 raw bytes. A Fresh peer starts with an empty
Y.Doc. Reconnect ties the persisted Y.Doc to the Space, note, history
incarnation and lineage epoch received with `LineageReady`. On a mismatch
the server sends tag 102 and closes with 4409 before state-vector sync. The
client can use the current Markdown and a verified base revision, when
available, for a three-way merge. The server verifies the base against the
same note and Space in the same history. Restore can change the incarnation
even when a note retains the same numerical lineage.

The peer write sequence starts at 1 and counts accepted write messages on one
connection. The room update sequence is scoped to the lease. An Editor that
violates document policy receives tag 104 followed by 1008. Reason values
from 1 through 8 respectively mean malformed update, missing causal
dependencies, forbidden shared type, invalid body content, frontmatter not
writable, deleted map key, protected key and invalid frontmatter value.
The room settles any accepted prefix and delivers the authorized Update and
ACK before the terminal event. The session stops accepting input as soon as
the room rejects a message. The registration remains available for revocation
through the last frame. Each frame requires current session and note permissions,
and room updates also require the current lease. Idle unload can invalidate a
lease while a stalled transport waits to receive the next frame.
Revocation, expiry and loss of required access also close a session with
1008. The initial Hello timeout is 10 seconds by default.

## Carrier and durability

Frontmatter overrides take strings, finite numbers that round-trip through a
JavaScript number, booleans, lists of strings, or the exact object
`{"$unset": true}`. Use that marker to remove a field from the YAML and
retain deletion intent in the shared map. Deleting a map key violates the
protocol. The room protects `id`, `class`, `space_id`, `folder_id`,
`revision_id`, `ability_id`, `__proto__`, `notarium-id`, `notarium-created`,
`notarium-source`, `slug`, `title` and `view`.
The server advertises body-only editing for headers with anchors, aliases,
duplicate keys or other YAML constructs the byte-preserving editor cannot
edit. A prose-only checkpoint reuses the original header bytes. A field
checkpoint applies only the changed intents and preserves comments and
untouched entries. The carrier preserves the exact body even when it begins
with a byte-order-mark character or a literal Markdown fence.

A new lineage installs its initial CRDT snapshot before the first Ready.
Each peer update is validated in staging, committed to `collab_update_log`
under the active lease and published to live state before the durable ACK.
The writer checks each author's current session registration after waiting
for queue capacity. It checks cancellation and expiry for the whole batch
before the mailbox send while those registrations are held.
The write transaction checks the room lease and canonical write authority again.
Closing a valid `nota` block can assign its ID as part of that same staged
update. A checkpoint projects the committed CRDT state into Markdown,
persists the snapshot and compacts the covered log prefix in one transaction.
The defaults checkpoint after 3 seconds idle, 60 seconds periodic, or 128
updates. An empty room unloads after 30 seconds.
The actor budgets 2 milliseconds by default to group pending peer updates.
A queued canonical command ends that window and settles the accepted batch
before the command runs. Durable acknowledgements also include writer queue
time and storage commit time.

Recovery reads the carrier and snapshot first to identify the field intents
already applied to YAML, then replays the durable tail. Admission can recover
a fenced room on demand. Maintenance can call
`recover_fenced_rooms` with `CollabRecovery` authority for a Space history.
The hub resolves a lost open reply against durable state under its room slot.
Direct commands can also recover an orphaned lease. Space closure settles
active rooms and durable fenced tails before archiving.
A tail without an initial snapshot remains available for diagnosis and
cannot admit sync.

The live command interceptor routes note edits, verified external observations
and board moves through the room and commits their canonical outcome before
publication. It pins the current filename during the room lease and keeps
peer work separate from autonomous revisions so rollback can preserve the
peer checkpoint. If live edits have changed a board card's persisted carrier,
the room checkpoints it and returns the current revision so the caller can
replan the move against the updated view. Rollback skips active rooms.
For SQLite and PostgreSQL details, see
[canonical storage](storage.md#batch-writer-wal-coordinator-domain-invariants-and-backup).

Run `make test app=api` for the API suite and its disposable dual-dialect
storage fixtures. Follow the [development setup](development.md) to provision
the pinned container toolchain.

Run the opt-in release measurements from the repository root after `make setup`.
The first command reports CRDT guard cost and verifies the optimized path
against a full parse. The second reports durable ACK latency and room RSS on
Linux with SQLite `FULL` and mimalloc.

```sh
sh .devkit/runtime/devkit.sh cli exec --component apps/api --network none -- \
  cargo test --locked --offline --release -p notarium-collab --lib guard_campaign -- --ignored --nocapture
sh .devkit/runtime/devkit.sh cli exec --component apps/api --network none -- \
  cargo test --locked --offline --release -p notarium-collab --test collab_cost -- --ignored --nocapture
```
