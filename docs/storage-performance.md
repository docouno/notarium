# Storage performance and integration targets

Use the release storage suite to qualify database operations. Measure a user
action again at the first layer that can observe its completion. A successful
save has a durable receipt. A board move becomes visible when the next frame
shows the correct order and counts for that receipt.
[Run the storage suite](storage.md#reproduce-the-storage-measurements)

## Reference configurations and results

High and Medium identify two measured reference systems. Both had an 8-vCPU,
16-GiB allocation and an ext4 data volume. High used a Core i5-12500 host
with NVMe storage. Medium used an EPYC Rome guest with a virtual block
device whose physical medium was unknown. SQLite used WAL with
`synchronous=FULL`. PostgreSQL 16 used `fsync=on` and
`synchronous_commit=on`. The local tests used file-backed CAS.

| Measurement | High | Medium |
| --- | ---: | ---: |
| 4 KiB append + fdatasync, p95 | 0.867 ms | 1.621 ms |
| 256 KiB append + fdatasync, p95 | 1.276 ms | 2.048 ms |
| Single-thread BLAKE3 + Zstd level 3, median per 4 KiB document | 7.47 µs | 12.97 µs |
| SQLite rollback, p95 / p99 | 3.197 / 3.969 ms | 7.614 / 8.787 ms |
| PostgreSQL rollback, p95 / p99 | 4.250 / 6.125 ms | 11.858 / 18.054 ms |
| SQLite, 50 writers, zero readers, three runs (mutations/s) | 4,152.4 / 4,187.6 / 4,126.5 | 1,910.3 / 1,937.2 / 1,908.3 |
| SQLite, 50 writers, 200 readers, three runs (mutations/s) | 3,992.5 / 4,078.4 / 3,937.5 | First run stopped after one reader error |

These release measurements used commit
`4665459572174d74fc58c8ebaf010d1a59985593`, tree
`16e1dfb7d53c9b84debaa5c92cbdc511a5e02267`. High completed the full
suite. The Medium launcher exited with an error during its first mixed writer
run. Its completed rollback and zero-reader writer results come from the
launcher log. Each local rollback profile verified 1,000 fresh commands and 17
closed rooms per command. The separate 200-command PostgreSQL/S3 profile
over a local Unix socket reported p95 of 4.176 ms on High and 12.620 ms on
Medium. Remote object storage needs a measurement over the intended network.

| Profile | Current acceptance on both systems | Candidate operating target |
| --- | --- | --- |
| SQLite rollback with local CAS | p95 <5 ms | High <4 ms. On Medium, reduce the measured 7.614 ms to the shared target. |
| PostgreSQL rollback with local CAS | p95 <5 ms | High <5 ms. On Medium, reduce the measured 11.858 ms to the shared target. |
| SQLite 50 writers, zero or 200 readers | >2,000 confirmed mutations/s in **each** run, zero errors | High >3,500/s in each run. On Medium, eliminate the reader error and repeat both profiles against the shared target. |

## Repeatable comparison

Record commit and tree, release build, client and server resource limits,
mount, database settings, cache state and competing workload. Characterize
a new host independently of the application results. For the disk figures
above, alternate 4 KiB and 256 KiB appends to one file on the data mount,
call fdatasync after each append and collect 320 samples per size after
32 warmup rounds. For the codec, time the same release binary and corpus on
one thread for 32 batches of 512 documents after four warmup batches.

Run three independent release series per configuration. Match input sizes,
corpus topology, concurrency, warmup and operation mix. When a workload
supports a fixed seed, record and reuse it. Fresh commands need distinct
identities to exercise writes. Start the timer before the public operation,
stop it at durable acknowledgement, and verify the receipt and resulting
state. For user-facing reads, stop at the first correct visible result. Keep
timeouts, errors, retries, and incomplete profiles in the report alongside
successful latency distributions and sample counts. Report p95 and p99 per
run and backend. With 1,000 observations, roughly ten fall in the slowest
one percent.

Promote tighter targets after the slowest comparable run leaves room for
run-to-run variation and the downstream latency budget. If Medium misses a
target, measure queue delay, SQL and commit time, CAS work, CPU throttling,
I/O waits and WAL volume during the operation. Test increasing offered load
to locate the point where throughput flattens while queues and tail latency
grow. Record the reason for each failed read. Keep class permissions, causal
visibility and acknowledgement durability in every comparison.

## Measures for the next integration

| User action | Owning component and next observable result |
| --- | --- |
| Open a board or move a card | Projections measure the four-filter, top-50 view at p95 <5 ms warm and ≤15 ms cold. After a move, check the first result for its receipt while a projection backlog exists. Track card order, group counts and visible frame time. [Projections](https://github.com/docouno/notarium/issues/5) |
| Search a Space | Search measures lexical p95 <40 ms and hybrid p95 <95 ms on its specified corpus. Verify authorized results and lexical fallback at the 150 ms embedding deadline. Time the first useful visible results through the client separately. [Search](https://github.com/docouno/notarium/issues/6) |
| Type together or save an open note | Collaboration measures local echo, durable update acknowledgement and delivery to the second editor separately. The <3 ms coalesced checkpoint applies to the intercepted path. Verify that acknowledged edits survive restart. [Collaboration](https://github.com/docouno/notarium/issues/7) |
| Switch chat branch or undo a Keeper run | Chats and Keepers measure the correct 50-entry window, command receipt and visibility of restored notes. Measure time to the first provider token separately. Keep the storage window p95 <1 ms and rollback p95 <5 ms as component checks. [Chats and Keepers](https://github.com/docouno/notarium/issues/8) |
| Edit while an import or backup runs | Jobs measure foreground read/save tails during background work, the export manifest read <50 ms, the paired backup barrier <1 ms, archive completion and verified restore. [Jobs and backup](https://github.com/docouno/notarium/issues/9) |
| Save from an external editor or switch branches | Vault measures filesystem change to durable receipt and visible revision. Track convergence and ID preservation across the 300-file checkout. The <500 ms sidecar shutdown check times the flush and release after parent exit. [Vault and sidecar](https://github.com/docouno/notarium/issues/10) |

For ordinary note saves the scale suite specifies p95 <12 ms on local NVMe
SQLite and <25 ms on PostgreSQL, under 50 writes/s and 500 reads/s with a
50,000-note import. The storage saturation suite uses 50 concurrent writers.
Time request-to-receipt through the API and action-to-visible-result in the
product client as those entry points become available.
[API integration](https://github.com/docouno/notarium/issues/11) ·
[System workload and acceptance](https://github.com/docouno/notarium/issues/13)
