# Note history: revision journal (#12) <a id="model"></a>

Versioning lives at the application level: an append-only revision journal in the
meta-DB, not a git layer over the catalog. Markdown files remain source of truth
(P1). The journal accumulates states that passed through Notarium or were observed
by delta-sync; external edits between polls collapse into one observed state.

## State boundary

A current revision is a byte-safe `DocumentState`: the exact authored source bytes,
document role and path-fallback context, a parsed projection when one exists, and
receipt-backed provenance for storage-owned fields. This is the single boundary for
`v3:` CAS, journal dedup, Changes, live restore and trash restore. Class changes the
mount and visibility, not whether source bytes are versioned.

`note_revisions.snapshot_format` is versioned per row:

- `markdown-v2` — exact generic Markdown source;
- `skill-markdown-v1` — an exact, valid directly-authored `SKILL.md` root;
- `opaque-v1` — arbitrary or unreadable bytes retained without inventing a Markdown
  interpretation;
- `markdown-v1` — the former complete logical Markdown compatibility snapshot;
- `NULL` — either a legacy body-only snapshot (`content_hash` present) or an honest
  gap (`content_hash` absent).

`revision_blobs` stores the encoded state content-addressed by SHA-256. The separate
semantic fingerprint includes authored bytes, role, safety and provenance shape, but
excludes proven runtime owner values and receipt lineage; changing an engine-owned id
does not pretend the author changed the note. Fixed columns remain query projections,
not a second source of state.

Each exact document also carries persisted restore safety: `safe`, `blocked` (a
target owner value is structurally coupled, for example through a YAML anchor), or
`unknown` (the parser cannot prove a safe byte-range mutation). Together with format
and blob presence this becomes the public availability algebra: `full`, `partial`,
`opaque`, `gap`, `blocked`, `unknown`; a host without the strict coordinator maps the
otherwise restorable states to `capability-unavailable`.
`entry_role`: `origin` | `baseline` | `change` (#327) — WHAT the entry is in the note's life, decided by the writer at append and never inferred on read. `origin` = the note appeared through us; `baseline` = a synthetic pre-edit state or the first sighting of a note that already existed outside (real history, but not activity — counting it would double a pre-existing note's first edit); `change` = every later state. Before it, four consumers derived the same thing from `kind = 'external' AND base_rev IS NULL`, and quarantine (below) broke that approximation outright: with a contaminated past, a note's next ordinary edit has no trusted parent either, so it read as a first sighting and vanished from every Activity surface. The writer asks `hasAnyFor` — trusted AND quarantined — exactly once in a note's life, when there is no trusted latest at all. Quarantine does not change the role: it is a structural position, like `kind` and `createdAt`, not payload, so a gap keeps it and a contaminated baseline is still suppressed from `created`/`edited` while emitting as `unavailable`. Migration `0005` backfills the axis; rows written by an older process during a rolling upgrade carry the SQL default `change` permanently, which is accepted — see [meta-db](meta-db.md).

`integrity`: `trusted` | `quarantined` (#327). A cross-space id collision does not only mis-address rows, it CONTAMINATES chains: a revision's `base_rev`/`their_rev`/`source_rev` could point across a space boundary, so everything downstream of such a link was diffed, chained and attributed against state that never belonged to this note. Those rows are `quarantined` and served as **gaps**: the revision id, note, space, `kind` and time survive — which is what keeps cursors, totals, pages and session linkage exact — and everything that could attribute or reconstruct the state is withheld, with an additive `unavailableReason` on the wire. Nothing is invented in its place: no neutral author, no reconstructed parent, no alias. The taint belongs to the DEPENDENT row, never to a clean ancestor, and it flows downstream through EVERY space: an Alpha → Beta → Alpha chain quarantines the Beta row and the late Alpha row while the early clean Alpha row stays the trusted operational latest. Note-addressed reads are space-scoped for the same reason — the journal is shared across spaces, and a contaminated chain must not be readable through a sibling.

A gap is never operational state: `latestFor`/`latestForMany`, the trash collapse, `latestTimestamps` and the alias backfill all read trusted rows only, so a gap is never a chain parent, a tombstone, a restore source or a historical name. It IS history all the same — `hasAnyFor` counts it, so the write path does not invent a fresh "baseline" over a note whose past it cannot read. Sanitizing the row mapper is not enough on its own: every query classifies and filters on EFFECTIVE values (`revisionProjection`), because reading a raw `class` or `principal` to decide whether to SHOW a gap would leak exactly the metadata the gap withholds.

## How it's written

A revision carries `charsAdded`/`charsRemoved` against its chain parent, computed once
from comparable Markdown projections (word-segmented including whitespace, capped at
1 MB total input; otherwise honest `null`). Lists never re-diff blobs. Opaque, gap and
incomparable compatibility boundaries have no fabricated diff.

The journal key is internal note-id (P7), not path, so history survives move/rename.
`space` partitions the audit; `principal` attributes a human/agent write and is null
for an external state. `kind` is `write | external | restore | delete | merge`;
`source_rev` identifies the restored revision, while `base_rev` is the causal parent.

## Capture and persistence

`RevisionJournal` is a core service; `CachedStore` owns hooks over production and
in-memory engines. A changed delta row is exact-read once in the background lane.
Unchanged inventory rows are not read. A failed read records a gap instead of treating
the delta's normalized body as authored bytes. External deletes wait for identity
reconciliation, so a remove+add move does not create a false tombstone.

A successful physical write is exact-read before its response token and journal state
are published. If read-back fails, the journal records a gap and the request fails
without returning a fabricated token. Ordinary appends remain queued per note; reads
drain the requested note and set operations use `latestForMany`, never N+1.

Persistence has in-memory, SQLite and PostgreSQL implementations. Purge compares the
selected tombstone under the same driver lock as append, so restore-first makes purge
skip and purge-first makes restore terminally fail. Schema evolution and the strict
terminal transaction are described in [meta-db.md](meta-db.md).

## Strict restore

Restore is a persisted idempotent operation, not a best-effort `write()` wrapper. It
stages exact bytes under the adapter-owned recovery namespace, validates the live
head/address/proof/lifecycle cut, publishes through the resource authority, then one
meta-DB transaction appends `kind: restore`, advances head/address/owner proof, records
the physical receipt and outbox event, and stores the terminal response. Recovery can
resume every accepted phase after process exit; replay returns the stored result and
never appends a second revision.

For a live history rollback, the supplied `versionToken` proves the state being
overwritten. For trash, the selected tombstone revision is the source/head proof.
`markdown-v2` and `skill-markdown-v1` restore exact authored bytes while rebinding only
receipt-proven storage owners. `markdown-v1`/legacy rows retain their explicit partial
compatibility restore. Opaque, gap, blocked, unknown, role-mismatched and path-fallback-
mismatched states are never coerced into Markdown.

Restore also preserves internal legacy-filename evidence without guessing from history. A fresh
restore may capture a candidate only from the exact current bytes observed before the physical
effect, while the stage still binds that observation to the final note id. A prepared operation
records that alias evidence explicitly before publication. Recovery may upgrade a pre-compatibility
prepared record only while its stage still carries the original expected claim and the prepared
source, current destination and staged bytes all prove the same physical claim and owner. Once the
old operation may already have started publication (`publishing` or a post-effect
`failed-recoverable` stage), its public pathname is no longer pre-effect evidence: without an
operation-owned original observation recovery keeps it recoverable and neither rejects its stage
nor acknowledges an alias. An already published operation completes without inferring a new alias.
Publication is the trust boundary, and historical title/path coincidence is not proof.

The write is fire-and-forget, but revision reads are read-after-write consistent (#238): before listing, `revisions(noteId)` drains the queue of EXACTLY this note (`journal.drain(noteId)`), so the provenance in `get_note`, the author of the memory category, and the timeline always see the latest record that has already returned — a human UI save is not surfaced as an agent edit even under cross-file parallel load. Set-oriented provenance surfaces use `latestForMany(space, noteIds)`: the journal drains exactly the requested note queues, then each persistence driver returns the newest row per note in one batch query (missing ids are omitted), never an N+1 loop. The hot write path is not touched by this (the save doesn't wait on the journal), and reads don't gate unrelated notes: draining an empty queue is O(1). Synchronicity is guaranteed by the fact that `journal.record` puts the append into the per-note chain SYNCHRONOUSLY, before returning from `write()` (that is, before the 200 response) — which means a read-time drain always catches this record.

Persistence is a meta-DB facet (`packages/server/src/services/metaDb`) over the shared checksummed SQLite/PostgreSQL schema specified in [meta-db.md](meta-db.md). Without meta-DB the journal runs over the in-memory driver — history for the lifetime of the process, the same honest degradation as identity (#51). In PostgreSQL the journal is the bottom of a wider lock hierarchy whose ONE normative statement is `packages/server/src/services/metaDb/drivers/pg/lockOrder.ts` — identity, then the reference facets, then the revision levels; this paragraph is a restatement of its tail, and the module wins on any disagreement (#327). Within that tail, append and purge take transaction-scoped advisory locks in a stable space-then-note-then-blob order (note purges start at the narrower note level): append shares the space lock with independent writes, while whole-space purge takes it exclusively before enumerating rows. High-cardinality note/blob keys map into a fixed set of sorted lock stripes, so a large purge has bounded lock cardinality. Replicas therefore cannot garbage-collect a shared CAS body while another replica is attaching a revision to it, without serializing all journal traffic in a space or exhausting the PostgreSQL lock table. A successful irreversible purge also leaves only a compact note/space fence behind; a delayed fire-and-forget append that lost the lock order is rejected instead of recreating history after deletion. **The note fence is scoped to the space that purged** (#327): note ids are globally unique now, but the journal is shared, and a fence keyed by id alone let one space's trash-emptying permanently silence a colliding id in another. Legacy fences written before that scoping carry an empty space and stay global — a purge already decided is not re-opened by a migration. During a rolling deployment the database insert trigger brings a writer without application-level revision locks into the same lock/fence gate, while a statement trigger rejects a purge writer that has not declared the fenced purge protocol. Existing replicas may keep serving ordinary appends; an unsafe irreversible purge is rejected and retried on a current replica.

## Wire and UI

- `GET /api/note/revisions?id&offset&limit` returns `stateFormat` and typed
  `restoreAvailability` for every row.
- `GET /api/note/revision?id&revisionId` is discriminated by `contentMode`:
  `markdown` carries the renderable projection plus exact/compatibility `snapshot`,
  `source` carries literal UTF-8 or base64, and `gap` carries no bytes.
- `POST /api/note/restore {id, revisionId, versionToken, idempotencyKey}` returns
  terminal `succeeded` (200), resumable `pending` (202), `conflict` (409),
  `not-restorable` (422), or pre-accept `busy` (503).

The UI renders only `contentMode: markdown` through the Markdown renderer. Opaque
source is plain `<pre>` text/base64 and has no diff or restore action; gaps are empty.
Changes compares exact snapshots only when both sides are Markdown. Legacy rows remain
labelled partial and compare bodies only. A restore keeps its idempotency key across an
ambiguous network result and repeats the same POST until terminal.

## Deliberate boundaries

- Retention keeps everything until explicit trash purge; scheduled retention belongs
  to durable jobs (#105).
- Quick saves remain separate rows; UI collapsing is a future product decision.
- Delete exact-reads before removal. Failure falls back only to already-known state;
  otherwise it appends an honest gap.
- The recovery namespace is backup state, not authored/user-export state; see
  [backup.md](backup.md) and [export.md](export.md).
- Trash, durable bulk undelete and permanent purge are canonical in
  [trash.md](trash.md).
