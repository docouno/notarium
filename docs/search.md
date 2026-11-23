# Hybrid search

The `notarium-search` crate implements `SearchPort` over canonical note and
chat history. Composition supplies `CanonicalStore` and a `StructuralReadPort`
through `SearchDependencies` and selects a `VectorMode` in `SearchConfig`.
Start the engine on a Tokio runtime. `start_space` warms a Space in advance,
and queries can start its subscriber on demand. Await `SearchEngine::shutdown`
before shutting down canonical storage.

## Queries and recall

- Lexical ranking uses Tantivy with title, body (shared across searchable note
  classes, including agent memory) and chat fields (`TOKENIZER_VERSION = 2`).
  Filter metadata is stored in fast fields without stored note or chat text.
  English and Russian prose use case folding and stemming. Exact fields retain
  code identifiers and path terms. Quoted clauses match phrase positions.
  Queries run score-thresholded top-K collection across segments, building a
  per-segment ordinal bitmap upfront when a structural filter narrows the
  candidate set to at most 4,096 notes (`SELECTIVE_NOTE_MASK_LIMIT`). Clause
  queries require a quorum (`1` clause for 1–2 clauses, `2` for 3–4 clauses, and
  `ceil(3 * count / 5)` for 5 or more); queries with more than two clauses fall
  back to single-clause matching only when fewer than `min(top_k, 10)` hits
  satisfy the quorum. Notes count strict matches across the indexed and receipt
  revisions together. When that leaves fallback slots, the highest BM25 scores
  across both sources fill them. Both sources share one lexical candidate limit
  before rank fusion. Tied note scores use ascending note ID. Scores use term
  document frequencies, average field lengths and corpus size across the pinned
  segments of both sources. As with ordinary
  Tantivy searches, a segment merge can change scores by removing postings
  for superseded revisions. Chats count matches on the currently visible branch.
  Both paths observe the request deadline and cancellation.
- Folder and structural filters apply before ranking. A blank query with a
  filter browses notes in stable ID order using per-segment term ordinals.
  Personal chat hits enter the ranking only for an authorized personal
  audience. Final delivery verifies note visibility and chat branch access at
  a consistent canonical head and applies the current taint of returned chats. A
  project-scoped Keeper can search its explicitly pinned skills outside the
  project when no folder is requested.
- For provider-recipient search and recall, the output limit counts notes
  admitted for that recipient. A single lexical and vector collection can
  inspect up to 800 distinct ranked notes per branch before graph expansion.
  Strict lexical matches take priority within that window. The single-clause
  fallback counts recipient-admitted strict notes, then fills the remaining
  slots up to `min(top_k, 10)` with admitted weaker matches before rank
  fusion and graph expansion. Both tiers share the same 800-note limit.
  When present, the existing structural mask plus the receipt overlay bounds
  this collection without reducing its ordinary chunk depth. An additional
  distinct strict or vector match marks the typed result truncated. An extra
  weak match marks it truncated while the fallback floor is still unfilled.
  Provider-facing tools omit this flag and hidden counts. The larger window reuses the same query embedding. Ordinary
  search and recall retain their `max(100, 4 * top_k)` candidate limits.
- The hybrid path fuses lexical and vector ranks with reciprocal rank fusion
  (`k = 60`). The vector branch ranks each note by its best matching chunk
  and also retains the leading chunks for recall. Recall can expand the
  top 16 notes through up to three graph hops. For a provider recipient,
  only admitted notes with graph nodes count toward the 16 seeds. Each
  visit reads up to 64 neighbors per direction. Up to 64 distinct admitted
  neighbors determine the degree penalty and can receive a boost or become
  the next frontier. All visits in a layer check their first 64 candidates
  before requesting replacements. Each subsequent batch checks at most as
  many candidates per visit as there are open slots. A full visit skips
  the rest of its page.
  Across all hops, the provider search checks up to 1,040 additional
  distinct neighbors for admission. All seeds and hops share
  1,040 node visits and the request deadline. Work beyond either cap marks
  the typed result truncated. Recall serves the best
  eligible chunk per note first, then fills the remaining token budget while
  respecting the optional per-note token limit. Lexical fallback ranks chunks by matching
  phrases and normalized terms. Each chunk carries canonical source spans.
- Wait watermarks require a caught-up search cut. A bounded set of exact
  receipts can score the named canonical revisions while the indexes catch up,
  using a lightweight in-memory single-segment overlay writer outside the disk
  writer pool (skipped for blank browse queries).
  The overlay evaluates receipt revisions against the field schema at the base
  cut and masks their older indexed hits. Exact carriers pass both historical and
  current authorization before ranking. Intervening folder or schema changes
  and receipts for package publication require full catch-up. Base postings,
  structural filters and note carriers share a projected cut. When the indexes
  and projection have different cuts, search waits within the call budget.
  Folder and field lookups continue to use the selected cut if the projector
  advances during the request. The response reports its cut, truncation and
  any embedding degradation.

## Storage

Search data is derived and rebuildable. Every active Space has an independent
canonical change subscriber. Command boundaries govern publication and
acknowledgement, including commands that span several change pages.
During a cold build, a transient storage read timeout retries the same note
page up to twice within its original budget. A purge or history change
invalidates the pinned cut and starts a new build.

The DataRoot holds `v1/search/<space>/tantivy/` and `vector/`. Tantivy stores
terms and fast fields without stored note or chat text. A durable folder
dictionary assigns stable ordinals. Moving a folder advances the lexical
watermark without rewriting postings. With a remote provider, the worker also
rechecks vector membership in the background, since the grant for a note can
change when its folder moves to another project.
A manifest identifies the active lexical generation and
the vector checkpoint. After an edit the worker masks old vector slots before
admitting vectors at the new lexical cut. If vector files are temporarily
unavailable, lexical search continues. The manifest retains the physical
checkpoint and the cursor before the first deferred edit. On reopen the worker
replays canonical changes from that cursor, masks affected notes, and queues
their embeddings. A purge, redaction or lost replay history invalidates the
checkpoint. A mismatch between the committed Tantivy generation and the
search manifest triggers a rebuild. The pending marker keeps outstanding
embedding work recoverable after restart. Readers pin a cut through ArcSwap.
Idle Spaces drop their lexical reader and unpublish their in-memory snapshot
after 30 seconds without activity (`LEXICAL_IDLE`), release cached embedder
handles after 60 seconds without vector activity (`EMBEDDER_IDLE`) while
retaining lightweight mmap vector epochs, and evict idle Space workers after
300 seconds (`WORKER_IDLE`). A progressing embedding repair keeps its reader,
embedder and worker active between pages. Idle eviction resumes after repair
finishes, during prolonged retry backoff or when the embedder is unavailable.
Archived Spaces scrub their derived data
immediately and evict their worker after 30 seconds (`ARCHIVED_IDLE`). Disk
indexing shares the bounded four-writer pool, while exact receipt overlays run
in ephemeral in-memory writers outside that pool.

Vectors use a bounded mutable L0 journal with batched fsync (soft background
flush threshold at 12 MiB or 20,000 chunks, hard upsert limit at 16 MiB or
25,000 chunks, and bounded headroom up to 32 MiB or 50,000 entries for
delete-only batches while a background flush or compaction plan is active;
without an active plan, delete overflow flushes tombstones and resets the
journal) and read-only, single-pass BLAKE3-checksummed v2 mmap segments
(112 MiB estimated build budget per segment). A long note can span several
segments. Backfill and direct replacements publish all its pieces in one
manifest update. A temporary failure for any chunk keeps that revision out
of vector results until repair completes. Other complete notes can still be
published. A permanently unembeddable chunk, such as an all-zero embedding,
is skipped regardless of which other chunks share its batch. Backfill,
dirty-note repair and full sweeps process at most
256 pending quantized rows (1 MiB of i8 payload at 4,096 dimensions). Warm
repair reads up to 16 carriers per page and checks admitted chunk metadata
against the current snapshot before copying embeddings. Long replacements use
private temporary segments. The owner links them into the epoch after checking
for concurrent edits. Discarded replacements release their files, and recovery
collects abandoned staging directories. The canonical page, Markdown and
metadata of the current note, model workspace, L0 cache, segment builder and
mapped segments also consume memory. Each segment contains normalized, per-vector i8
embeddings, a CSR-HNSW graph built in Rust, sorted note-slot and content-key
indexes, and precomputed class/folder filter bitmaps. Non-blocking partial
compaction plans and writes replacement segments outside the reader lock before
committing atomically. An individual upsert that exceeds the journal capacity
writes its replacement segments directly. SIMD scans serve selective filters up to
16,384 eligible slots per segment after intersecting field, class and folder
constraints. Epoch identity includes the profile,
dimension and input token cap. Remote epochs also bind the provider, its
resource and credential runtime generations, and the selected project.
When switching from a local model or changing models within the same remote
provider and runtime generations, the previous epoch remains available while
the replacement embeds its eligible corpus and catches up with edits. Switching
remote providers, rotating runtime generations, or leaving a remote provider
immediately stops sending query plaintext to the prior remote recipient and
serves lexical results with `EmbeddingsPending` until the replacement epoch is
ready. Readers switch to the new model and its vectors together.

Encrypted notes are excluded. A purge invalidates the affected search cut and
removes its retired disk copies before building a clean generation. On restart
the canonical purge fence is checked before the reader pool can delay cleanup.
Chat redaction commits and merges affected Tantivy segments, waits for pinned
readers, and publishes and acknowledges the new cut once obsolete files are
removed. If the reader or writer pool blocks the update, the worker retires
the old generation on disk before waiting to rebuild it. The worker
discards abandoned epochs and rebuilds invalid cuts. On reopening an archived
Space the worker retires its derived data before waiting for reactivation.
Search checks live note visibility after asynchronous hydration and before
returning results. Mixed results recheck the selected chat entries if the
canonical head changes during that final check.

## Embeddings

`VectorMode::Disabled` selects lexical search and recall with a built-in
conservative tokenizer. This mode keeps the ONNX Runtime library unloaded.

For `VectorMode::DynamicOrt`, install a matching CPU ONNX Runtime with C API 31
and supply its canonical absolute library path. Under the configured model
directory, each profile contains `<model-id>/model.onnx` with inline weights
and `<model-id>/tokenizer.json`. Treat each installed model ID as immutable.
To update the weights or tokenizer, install both files under a new model ID
and select that profile in the resolver. Search builds a new vector epoch
before switching queries to the replacement model.

The graph accepts `input_ids` and
`attention_mask`, and can also accept `token_type_ids`. The output is a pooled
2D float32 matrix (`sentence_embedding`) or a per-token 3D float32 tensor
(`last_hidden_state`). For token-level outputs the resolver selects masked mean
pooling with `LocalOnnx` or the first token with `LocalOnnxCls`, according to
the model profile. Search normalizes the result and uses a separate local
vector epoch for each pooling mode. The tokenizer supports WordPiece and BPE
profiles with the supported Hugging Face preprocessing stages and bounds single
inputs to 64 KiB. Unsupported model formats produce lexical degradation.

`VectorMode::RemoteOnly` uses `SearchModelResolverPort` (which resolves
Space-level embedding targets, composable with
`ProviderService::resolve_search_embedding_model`) and the typed provider port.
Background indexing obtains a current disclosure grant for the revision actor
before reusing a vector or sending a part. Each scheduled part batch rechecks
the selected target before dispatch. A revision author who has left the Space
is skipped while other eligible authors continue indexing. For remote epochs,
background model maintenance checks a durable witness of the Space admission
epoch and member account authorization versions. A changed witness schedules a
paged vector repair that checks each author's current membership and consent.
The manifest records the witness together with pending work so an interrupted
repair resumes on restart. While a pass is running, new admission changes or
remote folder moves preserve its cursor and schedule one more pass over the
Space. After a restart, pending repairs start from the first page. Local model
epochs and interactive query embedding do not read this witness. Interactive
requests recheck the default recipient when they leave the queue. Control verifies the
effective default again while admitting interactive queries and background
parts. Changing the default recipient drains in-flight implicit calls for the
affected Space before the preference commits. Explicit calls retain their
own provider admission. They require an untainted
context, a matching project scope, and a nonempty intersection of search
classes and provider disclosure. For project-scoped queries the canonical
egress lease pins the requested folder inside that project through dispatch. Provider admission rechecks current access and
token limits. Dispatch compares both resolved runtime generations and checks
the shared taint. Chat runs and Keepers can disclose a query only in their
pinned Space. Reading another Space marks the branch before remote vector
search, so the lexical path can serve the query locally. A scheduled Keeper
also needs a live lease and current approval of its role and skills. Query
embedding sends the query text alone. Remote indexing excludes descendants of
trashed folders. Chat transcript indexing stays lexical.

Local CPU ONNX inference and remote provider calls run on separate bounded
priority schedulers so remote network latency never starves local inference.
Each scheduler runs one bounded batch at a time and checks interactive requests
first, then live edits, then import and backfill. Batches contain at most 16
chunks; remote provider batches stay within the model's aggregate
`max_input_tokens` cap, while local ONNX batches pack up to 16 chunks each
bounded by `max_input_tokens` (up to `max_input_tokens * 16` tokens per batch).
Interactive vector search has one deadline of at most 150 ms covering model
selection, provider project lookup, queueing, embedding, vector filter
preparation and traversal. Local and lexical searches skip the provider project
lookup. When this deadline expires, the query returns lexical results with
`BudgetExceeded`.
The same deadline bounds waits for projection access during traversal.
Recipient-filtered provider queries start at the ordinary candidate depth and
widen progressively to the full recipient probe budget only when recipient
filtering rejects candidates and leaves too few hits, reusing prepared query
vectors and overlay hits across passes.
The durable pending state schedules bounded repair when embeddings are missing.
Ready targeted batches alternate with full-sweep pages. Targeted repair resumes
after the last attempted note ID and wraps at the end. A note-specific rate
limit delays only carriers that failed. Fresh revisions, unattempted notes and
sweep pages for other notes remain eligible. Failed notes share a retry
deadline. When a request or concurrency quota is exhausted, the affected
Space pauses background indexing for that target. The current batch can retry
once after the reported delay, with fresh admission, while the scheduler
remains available to queries and other Spaces. This bounded retry also applies
after the provider processes a batch and the next one hits the token quota.
A batch of terminally unembeddable inputs also advances the note's cursor.
An initial token refusal defers that note immediately.
Repeated refusals or waits longer than a minute release the private batch.
Each page can finish while unrelated edits arrive. If a note changes during
its embedding call, the worker discards that result and retries the new text.

## Verification

`make setup` prepares an integrity-pinned official ONNX Runtime CPU fixture.
`make test` uses it offline and runs canonical integration tests with SQLite and
PostgreSQL 16 with S3. The latter pair uses disposable fixtures reached over
Unix sockets. Missing fixtures fail the relevant tests.

The two-dialect integration checks the interactive provider budget, lexical
fallback, and provider cancellation. To measure full fallback responses against
the 200 ms target, run the scenarios sequentially on an idle runner. The command
emits a `search-fallback-elapsed-us` sample per dialect and a
`search-onnx-fallback-elapsed-us` sample for the local runtime to standard
error.

```sh
sh docker/storage-fixtures/with-storage-fixtures.sh exec-custom \
  sh .devkit/runtime/devkit.sh cli exec --component apps/api --network none -- \
  cargo test --locked --offline --workspace --test hybrid_engine -- --nocapture --test-threads=1
```

```sh
mkdir -p .artifacts/search-scale
make benchmark-search > .artifacts/search-scale/report.json
```

The release gate writes 100,000 canonical fixture notes and builds 400,000
384-dimensional chunks under the writable Cargo target. It measures BM25 at
the production candidate limit and reports a separate BM25 latency distribution
for a term matching the whole corpus. Both BM25 p95 values must be below 40 ms.
The broad query and blank browse also report their projection lookup counts.
The gate measures hybrid retrieval and fusion, selective SIMD scans, warm
vector epoch reopen, and non-blocking compaction. The selective timing includes constructing the
folder and dense membership bitmaps on the fixture snapshot and querying with
the same projection checks and candidate limit as the search engine. The
report includes separate mask preparation and kernel times. Independent RRF over exact quantized search and
an unquantized float32 cosine reference measure ANN and quantization recall.
The report includes sampled peak allocated index bytes, process anonymous RSS
and HWM across build, reopen and compaction, verified canonical descendants and
post-move search visibility of a moved folder, index file changes, background
chunks processed before interactive work starts, the queue depths at release of
the active batch, and the cgroup and SIMD settings.
The gate fails when a threshold is missed and removes its temporary data on
exit. The latency samples cover index operations. Canonical hydration, provider
calls, and transport have separate tests and budgets.
