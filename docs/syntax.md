# Document syntax

`notarium-syntax` implements the behavior below over supplied in-memory content.
It performs no filesystem, database or network I/O. Carrier bytes outside
explicitly authorized edits remain exact. Storage and live-room owners apply
these plans within their own atomic admission/commit protocols.

## Units, origins and live editing

Half-open byte spans and UTF-16 spans have checked bounds. Byte boundaries must
be UTF-8 scalar boundaries; a UTF-16 boundary inside a surrogate pair is invalid.
Conversion requires the exact source. Parser character offsets are not byte
offsets, and semantic event ranges are not automatically editable token ranges.

`CarrierPatchPlan` addresses the complete Markdown carrier, including BOM and
frontmatter. `BodyPatchPlan` addresses only the body represented by live `Y.Text`.
Origin is part of the type as well as the unit. Plans include source/body hashes
and identity; edits use one original source version, with no overlapping ranges.

For `---\nstatus: todo\n---\nA🚀B\n`, B begins at carrier byte 26 and UTF-16 unit 24,
but body byte 5 and UTF-16 unit 3. The live replacement uses body range `[3,4)`.
Converting units without changing origin would edit the wrong position.

Translation uses the exact carrier's checked body range, subtracts its byte
start and converts against the body. Semantic field commands use typed overrides;
raw header edits use `HeaderPatchPlan` with header identity/hash, carrier-header
splices and a semantic delta computed from the exact before/after content.
Comment, quote and key-order changes must not disappear when values are equal.
`HeaderMutation` explicitly selects Preserve, SemanticFields or RawHeader; the
same delta is not applied twice. Protected-key/class checks apply to every form.
An edit spanning header and body is rejected by this translation and needs an
explicit whole-document operation. Insertions at body start are explicitly
body edits; header insertions have their own origin. The room verifies the
current body hash/version before applying the plan, otherwise returning conflict
or replanning from its authoritative body. Checkpoints do not synthesize edits
that the live room has never accepted.

The room applies a raw plan to its checked current header base. Disjoint semantic
changes preserve pending field overrides; comment-only changes have an empty
semantic delta. Overlapping semantic changes, a stale header or an unsafe merge
produce conflict before any partial publication. The final carrier and new
header-base reference commit atomically before the receipt. Restart and later
checkpoints use that new base, so an external editor's comment is not reverted.
Header offsets never index `Y.Text`.

## YAML surgery

The scanner tracks actual tokens, comments, root shape and paired punctuation.
Semantic YAML validation does not supply slicing offsets. Existing scalar edits
replace only their value tokens; an explicitly replaced collection may change
inside that subtree. Unchanged siblings, comments and line endings stay exact.
Unsetting a key removes syntax nodes while retaining comment and whitespace
trivia between them, including comments inside collections. Literal block-scalar
content remains value data and is removed with its value.
Scalar boundaries account for explicit or inferred content indentation, nested
sequence markers and markers on a later line. Dedented comments remain trivia.
Carrier detection and concrete edits share scalar-data indentation rules.
Marker indentation does not constrain a later content line; anchors and tags
remain node properties, and continued plain scalars keep literal punctuation.
Replacing a collection preserves its final line separator and supplies the
indentation required when an indentless sequence becomes a scalar/flow value.

Missing keys in block mappings are inserted before the closing frontmatter
fence. Flow mappings insert inside their braces: `{status: todo}` becomes
`{status: todo, "owner": "editor"}`, not a second mapping after the closing brace.
Empty mappings and first/middle/last/only-key deletion have explicit punctuation
rules. The same surgery supports missing view IDs in flow mappings. Results are
reparsed to verify the requested semantic postcondition. Frontmatter edits also
revalidate the complete carrier and verify that its body is unchanged.
Plain scalar punctuation and URL colons remain scalar data. Replacement encoding
accounts for block versus flow context, quoting commas/brackets when necessary.

Anchors, aliases and duplicate keys make structured frontmatter read-only.
Authorized body edits to a known ordinary document can preserve that header
exactly. Uncertain class or protected metadata never falls back to an ordinary
document. There is no whole-header reserialization to bypass an ambiguous edit.
Class evidence in an opaque header comes from semantic root events, including
explicit YAML keys; partial editing support cannot hide a protected declaration.

## Saving a work-in-progress view

Each actual fenced `nota` block has a local analysis state:

| State | Meaning | Save and execution |
| --- | --- | --- |
| Pending | The fence is not closed | Preserve raw text and diagnostic; do not execute |
| Invalid | Closed but malformed/ambiguous YAML, invalid explicit ID or duplicate ID | Preserve raw text and diagnostic; do not execute |
| Ready | Closed unambiguous mapping with a unique valid ID | Eligible for semantic compilation; compilation may still reject its query |

An ordinary document can save every intermediate edit, including
`columns: [title,` or `id: v_`. An invalid view does not prevent durable body
save. A previously executable view is invalidated when its current block becomes
Pending or Invalid; an old configuration is not executed as the new one.
Correcting an existing explicit ID/configuration preserves that view's identity.
Explicit structured view commands may reject an invalid requested configuration
atomically. Authentication, protected metadata and encrypted-carrier checks
remain strict.

A missing ID is inserted only into a closed, unambiguous mapping. The seed uses
note identity, missing-block source identity/ordinal and a policy version, with
deterministic collision handling. Existing IDs are never silently repaired or
regenerated after moving a block. Duplicate explicit IDs invalidate all affected
occurrences. If existing IDs cannot be reserved unambiguously, insertion is
deferred with diagnostics while raw save remains allowed. Unknown options are
preserved; semantic query compilation belongs to projections.
If concrete ID insertion is unsupported, the block receives a local diagnostic
and stays non-executable while its authored bytes remain saveable.

Repeated finalization of a persisted carrier is a no-op. In a live room, permitted
ID insertion belongs to the room-authoritative edit before durable acknowledgement.
Within logical content, an insertion anchors to the source character on its right;
at the end, it anchors before the closing fence's container prefix. The resulting
physical Markdown is reparsed before accepting generated IDs. An unrepresentable
mapping defers optional insertions with diagnostics and preserves the raw carrier.

## Sections remain inside their Markdown containers

The outline records container ancestry as well as heading level. A section ends
at the next heading of equal/lower level in the same container, or at the end of
its owning blockquote/list item, whichever comes first. Root sections end at the
body boundary. A nested container's heading does not terminate its parent section.
Code-block headings are not sections; ambiguous selectors are rejected.
Empty-section insertions preserve both headings: the builder supplies a line
separator after an EOF heading and before an adjacent section when needed.

Section replacement accepts logical Markdown without its enclosing quote/list
prefixes. The builder reapplies the selected container's prefixes and continuation
indentation. Root, quote and list-item cases, including lazy continuation, need
fixtures with independently known intervals. Unsupported ambiguous layouts fail
before editing; they never widen the deletion. External paragraphs, neighbouring
items, headings and frontmatter remain byte-for-byte unchanged.
The end boundary precedes the next heading's entire physical line, retaining its
container prefix. Fenced logical content comes from canonical Markdown text
events; byte mappings are used only where those fragments match the source.
A file-leading BOM is excluded from container prefixes even without frontmatter.

## Portable filenames

A final storage component is at most 255 UTF-8 bytes and 255 UTF-16 code units,
including extension and service suffix. An explicit note slug therefore has at
most 252 UTF-8 bytes before `.md`; folder components allow 255. Character,
separator, trailing-dot/space and reserved-device-name validation applies to the
final filename. Display titles are not restricted by this filesystem budget.
Explicit names are validated, never silently shortened or normalized.

Generated conflict names use a bounded human prefix followed by `.conflict-`,
the complete canonical revision ID and `.md`. Only the human prefix is shortened
on scalar boundaries. An empty prefix uses `note`; the complete result is checked
again. Revision identity is never truncated. An existing unrelated file causes
an explicit collision outcome, never silent overwrite. Runtime adapters also
check volume and full-path constraints. Legacy raw/display metadata remains
lossless; incompatible vault paths require an explicit mapping/conflict outcome.

## Required evidence

The mandatory generated-document gate runs at least 10,000 documents plus fixed
adversarial cases. Untouched-byte and UTF-16 oracles are independent of the
plan builder. Cases include BOM/CRLF/multiline headers, combined field
and view-ID edits, flow mappings, nested sections, valid-invalid-valid view edits
and filename boundaries. Encrypted carriers retain zero extraction and strict
rejection of plaintext outside permitted regions; ordinary view diagnostics
do not weaken that boundary. Library probes alone do not certify these behaviors.

Pure room-carrier fixtures verify comment-only raw edits, preservation of disjoint
field overrides, rejection of overlapping changes and checkpoint reconstruction.
Actual CRDT rooms and durable replay are implemented and verified by their runtime
owners. [Development](development.md) describes reproducing the library gates.

## Extraction and model input

One Markdown event/range analysis supplies headings, containers, blocks and code
masks. Wiki links retain stable IDs or complete relative/absolute directory and
leaf targets, labels and source spans. Escaped text, inline/fenced code and link
destinations produce no links or hashtags. Lookup keys use canonical Unicode
normalization and full case folding; exported Unicode-version constants identify
the pinned tables. Original source spelling is never normalized in place.
Tight list items supply source blocks even when Markdown omits paragraph events.

`ChunkPlan::Deferred` retains source blocks when no model profile is supplied.
With a `TokenizerBudget`, adjacent blocks share heading context and oversized
blocks split at checked scalar boundaries. Every emitted model input is counted
again, including breadcrumbs and serving special tokens, with a maximum of 512.
Source ranges are not silently truncated. BLAKE3 keys frame the model-profile
identity and exact model input. Consumers scope their caches by Space. Fixed greedy
vocabulary fixtures include subwords, UTF-8 byte fallback and emoji; production
model/tokenizer assets belong to the search adapter.
Chunk descriptors include source identity and heading-context ranges. Breadcrumbs
retain source Markdown and fixed separators, so core can reconstruct and verify
the exact model input before issuing a classified content-part capability.

## Encrypted documents

Encrypted dispatch precedes all general extraction. Its result contains source
identity and carrier/title ranges for explicit editing, with no secondary fields,
outline, links, tags, views or chunks. Secondary egress is denied by core.

The body admits whitespace, at most one initial plain H1 and exactly one closed
`age` fence. Raw outside bytes are checked, including Markdown comments and link
definitions. Armored age input must decode to a standard header, nonce and a
structurally complete STREAM payload. Validation cannot authenticate ciphertext
without a recipient key and performs no production decryption. The public age
testkit known-answer fixture is separately decrypted in tests to the expected
plaintext. Finalization validates the encrypted carrier before and after metadata
edits; plaintext outside the permitted regions is rejected.
LF, CRLF and bare CR all separate outside lines; a title cannot hide a following
plaintext paragraph behind a different line ending.
