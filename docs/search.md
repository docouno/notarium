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
  filter browses notes in stable ID order. Chat hits are optional and are
  hydrated from the live reachable branch.
- The hybrid path fuses lexical and vector ranks with reciprocal rank fusion
  (`k = 60`). Recall can expand the leading notes through up to two graph hops.
  It serves the best eligible chunk per note first, then fills the remaining
  token budget with ranked chunks. Each chunk carries canonical source spans.
- Wait watermarks require a caught-up search cut. A bounded set of exact
  receipts can score the named canonical revisions while the indexes catch up.
  The overlay masks older hits for those notes. The response reports its cut,
  truncation, and any embedding degradation.

## Storage

Search data is derived and rebuildable. Every active Space has an independent
canonical change subscriber. Command boundaries govern publication and
acknowledgement, including commands that span several change pages.

The DataRoot holds `v1/search/<space>/tantivy/` and `vector/`. Tantivy stores
terms and fast fields without stored note or chat text. A durable folder
dictionary assigns stable ordinals, so moving a folder requires only a search
watermark update. A manifest identifies the active lexical generation and
the vector checkpoint. The reader pins both together through ArcSwap.

Vectors use a bounded mutable journal and read-only, checksummed mmap
segments. The segment contains normalized, per-vector i8 embeddings and a
CSR-HNSW graph built in Rust. SIMD scans serve selective filters up to 16,384
eligible slots. Model epochs carry a profile ID and dimension. A new epoch is
backfilled from canonical carriers before it is published.

Encrypted notes are excluded. Purge rebuilds the affected search generation
and removes retired disk copies. Chat redaction commits and merges the affected
Tantivy segments, then collects old files after pinned readers release them.
The worker checks history and durability on restart and rebuilds invalid cuts.
Result hydration always applies live authorization and class checks.

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
actor and sends only admitted parts. Interactive requests require an untainted
context and matching project scope. Provider admission rechecks access and
token limits. Chat text stays in the lexical index.

The embedding worker runs one bounded batch at a time. It checks interactive
requests first, then live edits, then import and backfill. Batches contain at
most 16 chunks and respect the model's aggregate token cap. Interactive
embedding work has a deadline of at most 150 ms, including queueing. On expiry,
the query uses lexical ranking and cancellation signals the active backend.

## Verification

`make setup` prepares an integrity-pinned official ONNX Runtime CPU fixture.
`make test` uses it offline and runs canonical integration tests with SQLite and
PostgreSQL 16 with S3. The latter pair uses disposable fixtures reached over
Unix sockets. Missing fixtures fail the relevant tests.

The two-dialect integration checks the interactive provider budget, lexical
fallback, and provider cancellation. To measure the full fallback response
against the 200 ms target, run the scenarios sequentially on an idle runner.
The command prints one `search-fallback-elapsed-us` sample per dialect.

```sh
sh docker/storage-fixtures/with-storage-fixtures.sh exec-custom \
  sh .devkit/runtime/devkit.sh cli exec --component apps/api --network none -- \
  cargo test --locked --offline --workspace --test hybrid_engine -- --nocapture --test-threads=1
```

```sh
mkdir -p .artifacts/search-scale
make benchmark-search > .artifacts/search-scale/report.json
```

The release gate builds 100,000 synthetic notes and 400,000 384-dimensional
chunks under the writable Cargo target. It measures BM25, hybrid candidate
retrieval and fusion, and the selective SIMD path. Exact quantized search gives
the recall reference. The report includes latency percentiles, recall, disk
usage, a canonical folder-move check, and the cgroup and SIMD settings. The
gate fails when a threshold is missed. Its temporary data is removed on exit.
The latency samples cover index operations. Canonical hydration, provider calls,
and the transport boundary have separate tests and budgets.
