# Trash for deleted notes (#79) <a id="model"></a>

Trash is a view over the revision journal: a note is in trash when its newest
revision is a delete tombstone. Restore appends a newer live state and the row leaves
the view; permanent purge conditionally erases its history. Whole spaces share the
same user-facing Trash but retain their separate registry-level archive mechanism;
see [spaces.md](spaces.md#deleting-a-space--soft-archive-110).

## Delete state

`remove()` exact-reads before deletion and stores a byte-safe `DocumentState` in the
tombstone even when the note was never saved through Notarium. If that read fails, it
may reuse an already-known exact state; otherwise `contentHash: null` is an honest gap.
The tombstone append is awaited before `changed` because it is the durable trash row.
External remove/add observations share the same per-note fence, so a move cannot leave
a stale delete on top.

The last path lives in the identity registry. `markDeleted` retains the id→path/class
binding with `deletedAt`, allowing undelete and deleted-note routing without treating
the removed file as live.

## Querying the trash

`listTrashed(space, {offset, limit, q?, availability?}, excludeClasses)` collapses the journal to the
newest revision per note, keeps deletes, applies the same class-visibility checkpoint
as ordinary listing, filters title by escaped case-insensitive substring and returns
newest-deleted first. `availability=restorable|unavailable` is evaluated before the
window, so search, pagination, Select-all-N, Restore and permanent deletion address the
same population. `total`, `restorableTotal` and `partialTotal` describe the complete
filtered population, not the page. `restoreAvailable` reports the host capability
separately from intrinsic item state.

Every row exposes both compatibility `restorable` (a blob exists) and the authoritative
`restoreAvailability`:

- `full` — exact Markdown/skill source proved safe;
- `partial` — former `markdown-v1` or legacy body-only compatibility state;
- `opaque`, `gap`, `blocked`, `unknown` — visible history but no safe restore;
- `capability-unavailable` — state could be restored, but this host has no strict
  restore coordinator.

Only `full` and `partial` enter `restorableTotal`; `partialTotal` is the subset that
requires a lossy-copy warning. If strict durable bulk restore is unavailable, both
aggregates are zero and an otherwise recoverable row becomes `capability-unavailable`.
No row is silently called restorable merely because bytes exist.

## Restore

`POST /api/s/:space/trash/restore` accepts `{id, revisionId, idempotencyKey}`. The
selected revision must still be the current tombstone. The persisted coordinator
stages/publishes through the resource authority and completes metadata through the
same terminal transaction as history restore, preserving note-id, class and complete
last path. A collision never overwrites another note. Exact states rebind only
receipt-proven storage owners; legacy rows restore their known body/fixed fields;
unsafe and opaque states fail before publication.

The operation returns `succeeded` (200), `pending` (202), `conflict` (409),
`not-restorable` (422), or pre-accept `busy` (503). Repeating the same principal,
idempotency key and request resumes/replays it. Reusing a key for a changed request is
a conflict. Accepted operations carry an id and can recover after process exit.

Restore and purge meet at the journal/head fence: restore-first makes a stale purge
skip; purge-first makes restore terminally fail. A published file whose terminal
transaction cannot yet commit remains owned by recovery, not exposed as success.

## Durable bulk restore

`POST /api/s/:space/trash/restore-many` accepts one of:

- `{ids, idempotencyKey}` — normalize/deduplicate while preserving explicit order;
- `{all:true, q?, onlyRestorable?, idempotencyKey}` — select the server-side filtered
  population without enumerating a page.

Acceptance freezes one ordered evidence roster `(noteId, tombstoneRevisionId)` in a
durable parent restore operation. Pagination, new deletes and later query drift cannot
change it. Every item executes the strict single-note protocol under a deterministic
child idempotency key and names its parent. Admission is bounded (25 active children
per resume) and the identical POST advances the remaining queue; startup recovery does
the same. A space in `closing` rejects fresh restore parents but admits already-accepted
children, and cannot finish archive while the parent is nonterminal.

The response is the complete frozen roster, one item each, in stable order:
`queued | pending | succeeded | conflict | not-restorable`, plus exact counts. Parent
status is `running` (202) until every child is terminal, then `completed` (200). A
changed payload under the same parent key is `idempotency-conflict` (409); `busy` (503)
is only a pre-accept capability/admission failure. Item failures do not roll back
successful strict children, but they are durable terminal evidence rather than a lost
best-effort response.

The web client retains the parent key across transport ambiguity and repeats the same
POST until `completed`. It never treats `running` as a partial success. The fake/none
tier deliberately has no durable coordinator: rows say `capability-unavailable`, the
aggregate is zero and restore endpoints answer 503 instead of simulating weaker safety.

## Permanent deletion

`purgeTrash({ids})` or `purgeTrash({all:true,q?,availability?})` irreversibly deletes every revision
for each selected note and garbage-collects blobs with no remaining references. Each
candidate carries the selected tombstone id; SQLite/PostgreSQL compare it with the
latest row under the append/purge lock. Notes changed or restored meanwhile are
skipped. The empty identity tombstone may remain for routing/audit shape, but contains
no note content. Automatic retention belongs to durable scheduled jobs (#105).
`purgeTrash({ids})` (an explicit set — multi-select / a single note) or `purgeTrash({all:true, q?})` (`Select all N` — all trashed within the scope under the `q` filter, paginated) irreversibly erase via `purgeNotes(space, noteIds)`: they delete ALL of the note's journal rows and GC the blobs that no remaining revision references (the CAS is shared by hash — a blob is dropped only when its last referent leaves), in one transaction in both drivers. For `{ids}`, each id is checked `latestFor=delete` before deletion — this is a load-bearing guard: `purgeNotes` wipes the note's entire journal, and a stale/foreign id must not take down the history of a LIVE note. The identity tombstone (an empty id→path row, `deletedAt`) remains — it carries no content, while all the real history and blobs are erased; this is "permanent deletion" in essence. The permanent fence the purge leaves behind is scoped to THIS space (#327): a colliding id in another space keeps its own journal and can still be appended to, while a re-appearing file here is refused rather than quietly starting a second history under a purged id. Auto-retention (auto-purge after N days) is deliberately NOT here: durable scheduled GC is a consumer of the durable job layer (#105); #79 has only an explicit user action.

## Opening a deleted note

A deleted note opens at `/n/<id>` read-only via `ReadOptions.deletedView`; normal
listing and wiki resolution still treat it as absent. Markdown states project their
historical content, opaque state is literal source, and gaps have no preview.

The UI at `/s/:space/trash` is a unified virtualized Notes/Spaces list with
action-neutral selection: a checkbox selects an item for either Restore or Delete
forever, never an implicit restore-only subset. The footer names the split (`N selected ·
R can restore · U unavailable`) and `Restore R available` sends only the recoverable
subset; the user never has to find and exclude unavailable rows. When the command
finishes, deliberately skipped rows are cleared from selection instead of leaving a
dead `Restore 0` footer, and the result states how many remain in Trash.

Rows translate integrity states into recovery outcomes: full rows carry the ordinary
Restore action, partial rows expose `Partial restore`, opaque/blocked/unknown rows expose
`Source only`, and gaps expose `No copy`. The latter statuses are clickable
explanations, not disabled icon tooltips. Host-level strict-restore absence is one page
banner rather than a repeated row error. `All items | Can restore | Can’t restore` is a
server-backed filter independent from the `All | Notes | Spaces` kind filter. A partial
single or bulk restore requires an explicit warning. Bulk note restore uses the durable
parent protocol above, while whole-space restore remains its registry-level best-effort
batch. Purge remains separately confirmed and irreversible. Updates arrive through SSE
`changed`.

## Wire and UI

- `GET /api/s/:space/trash?offset&limit&q&availability` →
  `{items,total,restorableTotal,partialTotal,restoreAvailable}`.
- `POST /api/s/:space/trash/restore` → strict single restore response.
- `POST /api/s/:space/trash/restore-many` → durable parent progress/terminal response.
- `POST /api/s/:space/trash/purge` → `{ok:true,purged}`.
- `GET /api/note?id=<deleted-id>` → deleted `NoteDetail` when explicitly resolved.
  It carries content-preview `restorable` separately from authoritative
  `restoreAvailability`, so opaque/blocked source stays inspectable without exposing
  an action the restore coordinator will refuse.

## Deliberate boundaries

- History/trash require the journal; strict restore additionally requires causal
  metadata, installation replay keys and a resource authority.
- Restore uses the complete tombstone path. Missing destination folders may be
  recreated by the authority; a different live note at that path is always a conflict.
- Current exact rows preserve authored aliases, slug, comments, ordering, whitespace
  and arbitrary plugin frontmatter. Only compatibility rows are partial.
- Notes are server-paginated; archived spaces remain a separate complete host-level
  list under the current product assumption that a principal has few of them.
