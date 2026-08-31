# Views and boards

> Canon for a view document, the notes source and the board reader. File semantics and
> raw/semantic body split — [note model](note-model.md#view-document-carrier); wire operations —
> [contract](contract.md#routing); React placement — [web UI](web-ui.md).

## Source × reader <a id="source-reader"></a>

A view is one registered reader over one registered tagged source. Generic REST, MCP, summary and
mutation consumers dispatch through those registries; adding a source implementation does not add
another source-kind branch to every consumer. The ordinary Markdown note is the portable carrier:
prose surrounds versioned `nota` fences; one fence contains one source and an ordered non-empty
list of named views. Source membership and reader presentation are independent. The carrier
root/common view shape does not contain board columns, ranks or other reader options. An unknown
source or reader remains a readable unsupported state.

The first source is `kind: notes`, with `scope: project|space`, an optional persisted
`FieldFilterAstV1`, and an additional optional filter on each view. Project scope binds to the
nearest marked project containing the saved note or the server-validated draft directory. It never
stores an internal project/space id and cannot cross a space.

## Execution and windows <a id="execution"></a>

One server source service evaluates the same precompiled field AST used by Feed and MCP. Visibility
applies before filtering. One saved-document or Feed-summary request captures one source snapshot
and generation, and all its views share one budget of 256 physical exact reads. The base generation
hashes the complete relevant `NoteMeta` tuple; every exact fallback adds its sorted
`(noteId, versionToken)` witness, so a hidden field cannot change under the same token. Exact
projections are cached only inside that captured context, with bounded entries/bytes; a reused
prepared plan skips both corpus work and exact I/O. Equivalent views in one saved document also
share their filter/source plan. An unresolved tail returns
`exactFallbackTruncated`/counts and disables mutation; it is never a silent miss.

Saved callers first obtain `/api/note/views` with version-bound opaque `viewRef` values, group
skeletons and source/schema generations on each executable item. Every independent window (≤100
rows) sends that ref and those generations to `/api/note/view-window`: the server reuses the exact
bounded prepared plan, or recomputes after eviction and conflicts rather than mixing a new corpus
with the old manifest. Draft Preview uses `/api/s/:space/view-query` with
`{kind:'draft', directory}` and is read-only; its first skeleton response supplies the same tokens
for later column windows. Prepared plans live in a 64-entry/100k-row LRU partitioned by store,
space and principal, not an unbounded or cross-owner process cache. Concurrent cold callers join
one abort-aware calculation; cancelled or transient work never poisons the LRU, while a legitimate
incomplete plan stays consistent across its windows. A client disconnect is an expected local
cancellation, not a source/server failure or error-log event. Group keys are opaque server results. A stale
ref conflicts instead of falling back to a name. Current views coalesce corpus changes at one
second, abort abandoned work and fence out-of-order responses across view, manifest and request
epochs. A repeated conflict for the same manifest requests one refresh, then retains stale rows
with an explicit error instead of looping.

## Board reader <a id="board"></a>

Board v1 requires `options.groupBy: note.<key>` and scalar values. Card metadata is the stable union
of the common `fields` list and every schema declaration marked `card:true`; the grouping field is
removed from that union on each card because its column already presents the value. Schema is
otherwise presentation only:

- a declared enum contributes every option in schema order, including zero-count columns, with its
  label and semantic color;
- observed out-of-catalog values follow the catalog in fixed binary order and stay neutral;
- a declared non-enum or undeclared scalar uses the same fixed binary authored-value order; it does
  not gain numeric/date/locale sorting;
- absent, explicit empty string, explicit empty list and unreadable remain distinct identities;
  the two empty forms share the visible label **Empty**;
- a non-empty list value is unsupported in v1 instead of being coerced or duplicated.

The manifest carries exact column counts before cards. Each visible column loads its own bounded
window and can page independently; initial render never ships the whole corpus. More than 512
groups is an explicit `Showing 512 of N columns` state: declared catalog and structural columns are
retained, observed values take the remaining binary-ordered slots. A high-cardinality field is
therefore visibly unsuitable rather than silently incomplete.

Board is a workspace reader rather than prose squeezed into the reading measure. On current-note
pages it takes the full PageFrame content width, replaces the document hero with a compact title and
suppresses the unused right-inspector toggle/column. Desktop uses a horizontally scrolling column strip with sticky
headers. Columns use `minmax(16rem, 1fr)`: a small set divides all available width, while larger sets
stop at the readable minimum and produce one visible horizontal scrollbar at the bottom of the
viewport. The board fills the real remaining viewport height; a short column has no vertical scroll,
and only its card list scrolls once cards overflow. Columns do not add a second panel fill or frame
around the bordered cards; schema color appears as the header's top border. Empty columns are blank
drop zones with label and count, not nested empty-state cards. Narrow screens use one snap column plus
the shared jump Select. Multiple readers use the shared accessible `core/Tabs`; cards compose
`CardLink` and `Chip` and show explicit plus schema-card fields. The title link occupies only its text,
uses a text-tone underline on hover and opts out of native link dragging; the whole card remains the
single drag surface, without a grip icon. Initial and column loading skeletons reuse the exact column,
card, title-line and chip geometry. Readers and drafts have no mutation controls. A writer gets the
move surface only while the saved source is complete, grouping is not truncated and the target column
denotes a writable scalar value or absence. Mutation capability is the intersection of reader intent
and a source implementation that actually owns that mutation; a future read-only source cannot
advertise a move the board endpoint cannot execute. The generic move service asks that source's
callable adapter to read and write membership; it does not reach through the registry and apply a
notes-field mutation itself. Registered source failures remain local, sanitized diagnostics and
never turn a healthy sibling reader or the whole Feed request into a 500.

Writer cards are focusable without adding resting controls. `Space` enters keyboard move mode,
arrow keys move the same neutral placement across columns and loaded gaps, `Space` commits the
shown `BoardMoveRequest`, and `Escape` cancels. Moving to an offscreen column scrolls it into view
and loads its first window before commit. Focus and live announcements expose the mode; there is no
grip icon, permanent Move action/select or hijacked title-link navigation. Reader and draft cards
do not expose the mode.

## Board move and manual order <a id="board-move"></a>

Pointer drop on the card surface compiles to one `BoardMoveRequest`. The client supplies only
`viewRef`, card id, destination value/absence and
optional before/after card ids. It never supplies the group field, source scope or a rank. The
server resolves both notes independently with write permission, proves that they are live in the
same space/store, then rereads the exact block/view occurrence bound by the opaque ref. A stale ref,
incomplete source, truncated groups, missing card/neighbor or unwritable field schema refuses before
either note changes.

Membership and position deliberately live in two documents. The card's group field is authored
truth; the view note carries presentation-only rank JSONL under `options.order.ranks`. The operation
therefore writes in this order:

1. validate the fresh view/source/membership and target neighbors;
2. write the one card field through its normal CAS, retrying a conflict at most three total times
   with a full intent revalidation;
3. reread the view/source/card and, only while the same semantics and membership still hold, write
   the rank overlay through its own bounded CAS loop.

There is no cross-file atomic claim and no compensating field rollback. `moved` proves both effects;
`moved-unranked` proves the field and current target membership but reports that rank persistence
failed, so deterministic fallback order is visible; `moved-partial` reports the exact committed
field effect and only that, because the view changed/disappeared or membership drifted. Both degraded
results trigger a warning and manifest/column refetch. The client applies the shown move
optimistically, then reconciles only the affected loaded columns while retaining their rows. A
manifest refresh or an unrelated changed event is stale-while-revalidate: it never clears the whole
board or replaces it with skeletons. Reconciliation preserves every held page and uses one
board-global four-request semaphore. A pre-effect failure restores the local snapshot unless a newer
successful server window already superseded it; merely starting or failing a load does not suppress
rollback. An operation or window from a previous reader/viewRef is inert. A lost response converges
through the normal changed event/refetch path and is not blindly replayed.

Ranks are a YAML literal scalar containing JSON Lines `[noteId, rank]` tuples. Semantic order uses
the rank's binary JavaScript string comparison with note id as an equal-rank tie-break; ranked cards
precede the stable title/id-ordered rankless tail. The server wraps `fractional-indexing@4.0.0`: it
first computes the canonical key between current ranked bounds, then applies exactly 32
cryptographically chosen binary half-splits. Keys longer than 64 UTF-8 bytes, invalid/duplicate
rank pressure or a gap involving rankless neighbors selects one non-jittered rebalance over exact
current source membership. An ordinary move splices one physical JSONL line; only the named
rebalance replaces the scalar. Rank-only writes preserve semantic body/hash; SQLite's FTS trigger
compares old/new materialized values and skips an identical delete/reinsert, so the write causes
neither embed nor FTS churn.

Board DnD reuses the tree's one-or-many `DragNoteItem` payload, but v1 accepts exactly one note.
A multi-item payload is an explicit no-drop rather than a partial move. Active payload and the last
shown before/after target are synchronous; the whole card list including gaps is the drop zone and
commits that stored target. Gap calculation first removes the dragged card from the candidate rows;
its original gap is an explicit no-op, so a self-drop and a one-card column show no placeholder and
send no mutation. Cosmetic feedback is one neutral Explorer-tone, card-sized insertion placeholder
occupying the destination gap—never two competing borders on its neighbours or a whole-column wash.
Live announcements describe busy, final and degraded outcomes. See the shared
[responsive-drop recipe](drag-and-drop.md#responsive-drop).

## Discovery and summaries <a id="discovery"></a>

`view:` is a cheap discovery hint projected as dedicated `NoteMeta.viewType`; it never comes from
the capped custom-field blob and never decides execution. List/tree/search wire rows carry it only
when present. The tree maps a registered reader marker to its reader glyph (`board` today); an
unknown marker gets the generic view glyph. Favorites, current-note merges and the local recent
ring preserve the marker. Opening a note still parses the body authority regardless of the marker.

The current reader compares exact frontmatter marker and a valid body primary reader without healing:

- a missing marker beside a valid block warns that discovery may be incomplete;
- a different marker names both values and executes the body;
- a marker without an executable block is quiet metadata and leaves ordinary content untouched;
- an invalid block reports only its local parse/execution diagnostic, not a second marker warning.

History/deleted raw mode performs no current-marker diagnosis. Marker text is bounded/sanitized for
display. A full or structural write applies the typed marker rule at the normal CAS boundary.
Current/draft view blocks never add a `Show source` control, including unknown, malformed, future,
unsafe and otherwise non-executable readers. Source/Edit and history already own raw configuration;
inline runtime owns only the concise local diagnostic.

Feed remains a list of ordinary user documents. It explicitly asks for `viewSummary=1`; an ordinary
notes/tree request pays only for the marker. For at most 100 marker-bearing rows, one summary service
captures one source snapshot/generation and evaluates only each document's primary view. The
reader owns both a count-only summary data plan and its wording; equivalent primary plans share one
corpus pass even when presentation-only options such as board ranks or card fields differ. Summary
execution does not sort or retain card rows/buckets, and transient unavailable/incomplete outcomes
are retried rather than cached as permanent absence. One view
renders `4 columns · 12 cards`; multiple views render
`3 views · primary: 4 columns · 12 cards`. Unsupported, invalid, marker-only or incomplete primary
execution omits the summary entirely; Feed falls back to the ordinary semantic-prose preview and
never renders a `View unavailable` label or YAML snippet.

The cache key includes document token/path, relevant schema token, normalized source+primary view,
project placement and source snapshot generation. It is therefore neither a generic PreviewCache nor
an id-only cache. Corpus/schema/config changes miss naturally; the Feed's normal coalesced changed
refresh converges. A 50-view × 10k-note gate proves one supplied snapshot, primary-only execution,
cache reuse and generation invalidation without a wall-clock threshold.

Free-text search, preview, recall and NoteFacts consume semantic prose only, so config values and
ranks never become search terms. Marker filtering remains deliberate through `note.view`. MCP
search/list discovery carries `viewType`; detailed `get_note` additionally returns the bounded
semantic projection while retaining the raw carrier in structured `content`. Generic MCP text edits
may change surrounding prose but refuse any operation whose before/after carrier blocks differ;
source/common/options changes use `edit_note.view`, and ranks remain unavailable to agents.

## Failure and history boundaries <a id="failures"></a>

Malformed/future/unsafe carrier, unavailable source, invalid reader options, one failed reader and
one failed column stay local. A refresh error retains last-ready data with an explicit warning.
History and deleted-note views show frozen raw source and never execute today's corpus. The current
reader and draft Preview execute; draft and reader grants remain read-only.
