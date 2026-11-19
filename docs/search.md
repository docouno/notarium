# Hybrid search

The `notarium-search` crate implements `SearchPort` over canonical note and
chat history. Composition supplies `CanonicalStore` and a `StructuralReadPort`
through `SearchDependencies` and selects a `VectorMode` in `SearchConfig`.
Start the engine on a Tokio runtime. `start_space` warms a Space in advance,
and queries can start its subscriber on demand. Await `SearchEngine::shutdown`
before shutting down canonical storage.

## Queries and recall

- Lexical ranking uses Tantivy with distinct title, body, memory and chat fields.
  English and Russian prose use case folding and stemming. Exact fields retain
  code identifiers and path terms. Quoted clauses match phrase positions.
- Folder and structural filters apply before ranking. A blank query with a
  filter browses notes in stable ID order. Personal chat hits enter the ranking
  for their owner. Hydration checks the live reachable branch.
- The hybrid path fuses lexical and vector ranks with reciprocal rank fusion
  (`k = 60`). Recall can expand the leading notes through up to two graph hops.
  It serves the best eligible chunk per note first, then fills the remaining
  token budget with ranked chunks. Each chunk carries canonical source spans.
- Wait watermarks require a caught-up search cut. A bounded set of exact
  receipts can score the named canonical revisions while the indexes catch up.
  The overlay applies predicates to the receipt revisions' evaluated fields
  and masks their older indexed hits. Base postings, structural filters and
  note carriers share a projected cut. When the indexes and projection have
  different cuts, search waits within the call budget. The response reports
  its cut, truncation, and any embedding degradation.

## Storage

Search data is derived and rebuildable. Every active Space has an independent
canonical change subscriber. Command boundaries govern publication and
acknowledgement, including commands that span several change pages.

The DataRoot holds `v1/search/<space>/tantivy/` and `vector/`. Tantivy stores
terms and fast fields without stored note or chat text. A durable folder
dictionary assigns stable ordinals, so moving a folder requires only a search
watermark update. A manifest identifies the active lexical generation and
the vector checkpoint. The reader pins both together through ArcSwap. Idle
Spaces release their lexical reader pins and retain their subscriptions. After
60 seconds without vector activity, they release the in-memory vector state
and embedder. The next access reopens the durable epoch and journal. Disk and
receipt-overlay writers share the four-writer pool.

Vectors use a bounded mutable journal and read-only, checksummed mmap
segments. The segment contains normalized, per-vector i8 embeddings and a
CSR-HNSW graph built in Rust. An individual upsert that exceeds the journal
capacity writes a replacement segment directly. SIMD scans serve selective
filters up to 16,384 eligible slots per segment. Epoch identity includes the
profile, dimension and input token cap. Remote epochs also bind the resource,
its runtime generation and the selected project. The previous compatible
epoch remains available while the replacement embeds its eligible corpus.
Publication switches both together.

Encrypted notes are excluded. A purge invalidates the affected search cut and
removes its retired disk copies before building a clean generation. On restart
the canonical purge fence is checked before the reader pool can delay cleanup.
Chat redaction commits and merges affected Tantivy segments, waits for pinned
readers, and publishes and acknowledges the new cut once obsolete files are
removed. The worker discards abandoned epochs and rebuilds invalid cuts.
Search checks live note visibility after asynchronous hydration and before
returning results.

## Embeddings

`VectorMode::Disabled` selects lexical search and recall with a built-in
conservative tokenizer. This mode keeps the ONNX Runtime library unloaded.

For `VectorMode::DynamicOrt`, install a matching CPU ONNX Runtime with C API 31
and supply its canonical absolute library path. Under the configured model
directory, each profile contains `<model-id>/model.onnx` with inline weights
and `<model-id>/tokenizer.json`. The graph accepts `input_ids` and
`attention_mask`, and can also accept `token_type_ids`. The output is a pooled
float32 matrix or a per-token float32 tensor. Search uses masked mean pooling
and normalizes the result. The tokenizer supports WordPiece, BPE and Unigram
profiles with the supported Hugging Face preprocessing stages. Unsupported
model formats produce lexical degradation.

`VectorMode::RemoteOnly` uses `SearchModelResolverPort` and the typed provider
port. Background indexing obtains a current disclosure grant for the revision
actor before reusing a vector or sending a part. Interactive requests require
an untainted context, a matching project scope, and a nonempty intersection
of search classes and provider disclosure. Provider admission rechecks current
access and token limits. Dispatch compares the resolved provider runtime
generation and checks the shared taint. Chat text stays in the lexical index.

The embedding worker runs one bounded batch at a time. It checks interactive
requests first, then live edits, then import and backfill. Batches contain at
most 16 chunks and respect the model's aggregate token cap. Interactive
embedding work has a deadline of at most 150 ms, including queueing. On expiry,
the query uses lexical ranking and cancellation signals the active backend.
The durable pending state schedules bounded repair when embeddings are missing.

## Verification

`make setup` prepares an integrity-pinned official ONNX Runtime CPU fixture.
`make test` uses it offline and runs canonical integration tests with SQLite and
PostgreSQL 16 with S3. The latter pair uses disposable fixtures reached over
Unix sockets. Missing fixtures fail the relevant tests.

The two-dialect integration checks the interactive provider budget, lexical
fallback, and provider cancellation. To measure full fallback responses against
the 200 ms target, run the scenarios sequentially on an idle runner. The command
prints a `search-fallback-elapsed-us` sample per dialect and a
`search-onnx-fallback-elapsed-us` sample for the local runtime.

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
the production candidate limit, hybrid retrieval and fusion, and the selective
SIMD path. Independent RRF over exact quantized search gives the hybrid recall
reference. The report includes the sampled peak allocated index bytes, verified
canonical descendants of a moved folder, index file changes, background chunks
processed before interactive work starts, the queue depths at release of the
active batch, and the cgroup and SIMD settings.
The gate fails when a threshold is missed and removes its temporary data on
exit. The latency samples cover index operations. Canonical hydration, provider
calls, and transport have separate tests and budgets.
