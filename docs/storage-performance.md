# Storage performance and integration targets

Use the release storage suite to qualify database operations. Measure a user
action again at the first layer that can observe its completion. A successful
save has a durable receipt. A board move becomes visible when the next frame
shows the correct order and counts for that receipt.
[Run the storage suite](storage.md#reproduce-the-storage-measurements)

## Reference configurations and results

High and Medium identify two measured reference systems. Both had an 8-vCPU,
16-GiB parent cgroup allocation and an ext4 data volume. The benchmark
process could see eight logical CPUs on High and sixteen on Medium. Record
both the launcher quota and the CPU count visible to the process when
comparing concurrent workloads. High used a Core i5-12500 host
with NVMe storage. Medium used an EPYC Rome guest with a virtual block
device whose physical medium was unknown. SQLite used WAL with
`synchronous=FULL`. PostgreSQL 16 used `fsync=on` and
`synchronous_commit=on`. The local tests used file-backed CAS.

| Measurement | High | Medium |
| --- | ---: | ---: |
| 4 KiB append + fdatasync, p95 across three runs | 0.827–0.891 ms | 1.616–2.005 ms |
| 256 KiB append + fdatasync, p95 across three runs | 1.268–1.290 ms | 1.952–2.443 ms |
| Single-thread BLAKE3 + Zstd level 3, median per 4 KiB document across three runs | 7.09–7.29 µs | 13.45–13.87 µs |
| SQLite rollback, p95 / p99 | 3.197 / 3.969 ms | 7.614 / 8.787 ms |
| PostgreSQL rollback, p95 / p99 | 4.250 / 6.125 ms | 11.858 / 18.054 ms |
| SQLite, 50 writers, zero readers, three runs (mutations/s) | 4,152.4 / 4,187.6 / 4,126.5 | 1,910.3 / 1,937.2 / 1,908.3 |
| SQLite, 50 writers, 200 readers, three runs (mutations/s) | 3,992.5 / 4,078.4 / 3,937.5 | First run stopped after one reader error |

The first three rows used the same release codec executable, driver and input
corpus on both machines. Comparing the medians of three runs, Medium took
1.95 times as long for the codec, 2.08 times as long for the 4 KiB durable
append and 1.75 times as long for the 256 KiB durable append.

The database measurements in the table used commit
`4665459572174d74fc58c8ebaf010d1a59985593`, tree
`16e1dfb7d53c9b84debaa5c92cbdc511a5e02267`. High completed the full
suite. The Medium launcher exited with an error during its first mixed writer
run. Its completed rollback and zero-reader writer results come from the
launcher log. Each local rollback profile verified 1,000 fresh commands and 17
closed rooms per command. The separate 200-command PostgreSQL/S3 profile
over a local Unix socket reported p95 of 4.176 ms on High and 12.620 ms on
Medium. Remote object storage needs a measurement over the intended network.

### Storage acceptance by hardware class

Select the hardware class before running the release suite. Keep the data
volume, CPU/disk calibration, resource limits and build identity with the
reports. Qualify each class with three independent full series on the same
runtime and reference system. Check each latency limit and writer floor.
Keep every failed and incomplete attempt with its exit status.

| Profile | High | Medium |
| --- | ---: | ---: |
| SQLite rollback, local CAS, 1,000 fresh commands | p95 <4 ms | p95 <10 ms |
| PostgreSQL rollback, local CAS, 1,000 fresh commands | p95 <5 ms | p95 <15 ms |
| SQLite, 50 writers with zero or 200 readers | >2,000 confirmed mutations/s in each run | >1,600 confirmed mutations/s in each run |
| Chat window, 10,000 reads of 50 turns per topology | p95 <0.5 ms | p95 <1 ms |
| Confirmed paired backup pause on SQLite, 1 and 64 Spaces | p95 <1 ms | p95 <1 ms |
| Confirmed paired backup pause on PostgreSQL, 1 and 64 Spaces | p95 <1 ms | p95 <2.5 ms |

Every class checks receipts, rights, resulting state and zero errors. The
ordinary command without a tier keeps the original <5 ms local rollback
limits, the >2,000 mutations/s writer floor and the <1 ms chat and paired
pause limits. The PostgreSQL/S3 Unix-socket profile reports its own latency.
Record whether the rollback component and the full suite each passed.
The writer report includes internal SQLite read timeouts and all returned
reader and writer errors, including warmup. A note edit may restart its
read-only preparation once if a short SQLite snapshot expires. Both attempts
share the original command deadline. The latency includes both attempts and
the durable write. Each snapshot retains its own time limit.

Three full High series on the same runtime revision (`f6651e2c`) gave
SQLite rollback p95 of 3.29, 3.38 and 3.26 ms. PostgreSQL rollback had
p95 of 4.54, 8.97 and 4.98 ms. All twelve chat profiles stayed at or below
0.322 ms. The six writer runs in the first series sustained 3,909–4,183
mutations/s. One mixed run in the second series fell to 330/s with a p95
batch write time of 233 ms. The full suites returned pass, fail and pass.
These results rule out promoting 3,500/s to a High release floor.
Across 24 additional High chat profiles on `7e7ef4fb` and `c2925d8d`, the
largest p95 was 0.329 ms rounded upward.

Two paired PostgreSQL experiments on High alternated ordinary pool checkouts
and reuse of one idle rollback session, with 500 fresh commands per mode in
each experiment. The ordinary checkouts used six backend processes and gave
p95 of 9.13 and 5.86 ms. Session reuse gave 4.20 and 4.00 ms. Median latency
rose from approximately 3.14–3.15 to 3.20–3.21 ms. Each run also verified the
17 closed rooms and restored history after every rollback.

A full-sized repeat on Medium at `f6651e2c` measured 7.80 ms in
SQLite and 11.51 ms in PostgreSQL. A separate 200-command diagnostic on
each backend timed the phases of each individual rollback. At SQLite's
p95 of 7.70 ms, the durable commit took 2.97 ms and buffered SQL inserts
took 1.70 ms. At PostgreSQL's p95 of 11.42 ms, the statement that checks
and applies the changes took 7.80 ms and commit took 1.34 ms.

Across three full Medium series on `7e7ef4fb`, the 18 SQLite saturation
runs ranged from 1,742 to 2,008 confirmed mutations/s (bounds rounded
outward). Two exceeded 2,000/s. The Medium release floor is 1,600/s in
each run. Sustaining >2,000/s remains the engineering target. The six
PostgreSQL backup profiles on that revision recorded confirmed pause p95
between 1.319 and 1.951 ms. A separate 2,000-capture diagnostic on the same
system measured 1.53 ms with one Space and 2.08 ms with 64. The 2.5 ms
Medium budget covers the first confirmed safe point through both resume
acknowledgements. Measure user-visible save latency at ordinary concurrency.

### Ordinary edits on both references

The same release executable on `f6651e2c` completed 53,303 measured
open/edit/readback cycles on High and 29,564 on Medium, with zero errors.
Reopening the store verified the last confirmed head for every note. Each
cell gives the range across three independent series. Eight workers edited
distinct notes in one Space as the same owner, with a 100 ms pause between
cycles. A single worker issued the next cycle immediately.

| Reference | Backend | Workers | Open p95 (ms) | Durable edit p95 (ms) | Durable edit p99 (ms) | Whole cycle p95 (ms) |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| High | SQLite | 1 | 0.33–0.33 | 3.42–3.47 | 4.16–4.44 | 4.19–4.26 |
| High | PostgreSQL | 1 | 0.75–1.38 | 4.34–6.04 | 5.10–7.12 | 5.93–8.98 |
| High | SQLite | 8 | 0.48–0.51 | 5.10–5.48 | 6.27–6.48 | 5.95–6.37 |
| High | PostgreSQL | 8 | 1.21–1.31 | 13.90–14.80 | 16.95–20.37 | 16.21–16.95 |
| Medium | SQLite | 1 | 0.96–1.08 | 7.95–8.82 | 10.98–11.20 | 10.06–11.01 |
| Medium | PostgreSQL | 1 | 2.24–3.47 | 10.66–12.78 | 13.84–15.69 | 15.05–19.29 |
| Medium | SQLite | 8 | 2.21–2.33 | 14.89–15.79 | 77.98–145.88 | 18.53–18.90 |
| Medium | PostgreSQL | 8 | 4.07–4.72 | 33.08–41.72 | 94.47–123.20 | 38.59–50.09 |

On `c2925d8d`, the public interaction example completed 52,562 cycles on
High and 27,659 on Medium. All 24 reopen audits passed. On Medium the
slowest single-worker save p95 across three repeats was 9.82 ms for SQLite
and 15.05 ms for PostgreSQL. At eight workers, 1.07% of SQLite saves and
1.54% of PostgreSQL saves exceeded 100 ms. On High the corresponding
shares were 0.96% and 0%. The binaries for these two runs were built
separately from the same tree.

Track eight-worker p99 alongside single-worker p95. These series cover a
4 KiB note and local database access. HTTP, rendering and the 50,000-note
import enter the system budgets in their respective integration tests.
Reproduce the interaction with the release fixture.

```sh
sh docker/storage-fixtures/with-storage-fixtures.sh benchmark --interactions
```

## Repeatable comparison

Characterize the host independently of application latency. After `make setup`,
build the release codec example once on Linux. From the repository root run

```sh
sh .devkit/runtime/devkit.sh cli exec --component apps/api --network none -- \
  cargo build --offline --locked --release -p fitness-gates --example storage_codec_probe
```

Copy that executable and `scripts/storage-calibration.py` to both compatible
Linux hosts. Use Python 3.9+ and supply an existing writable directory on the
same filesystem as the database. For example, from the original checkout run

```sh
python3 scripts/storage-calibration.py apps/api/target/release/examples/storage_codec_probe \
  /path/on/database-volume > storage-calibration.json
```

Record the release commit/tree, database settings, filesystem mount, effective
CPU and memory limits, cache state and competing work. The JSON records the
binary and driver SHA-256, target directory and device number. Check that
`codec.corpus_blake3` is
`dfd19ddf972050fc6f758933718a5b3e0a36c5d31a2f113f35720e8487d3c43c`.
This covers the concatenated 512 documents in order, each 4,096 bytes.
The probe measures the production LocalZstdV1 codec in 32 single-thread
batches after four warmup batches. Disk samples use one growing temporary
file (about 90 MiB), one append followed by fdatasync, alternating the order
of 4 KiB and 256 KiB appends over 32 warmup and 320 measured rounds. The
report includes the SHA-256 of each input block and the individual timings.
The reference values above are historical measurements. Compare new runs
using identical executable, driver and input hashes.

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

On a Medium ext4 volume, a diagnostic SQLite snapshot spent 955 ms in a
revision lookup under the 50-writer, 200-reader workload. Thread samples
caught its file read waiting for space in the ext4 journal. In a separate
comparison on that volume, six mixed runs with default access timestamps
reported three read failures. All six runs with access timestamps suppressed
on fresh fixture files completed without read failures. A separate set of
24 mixed runs compared the database and blob directories on the same volume.
Six runs in each configuration produced five read errors with ordinary
timestamps, five with timestamps suppressed only for blobs, and zero when
suppressed for database files, with or without the blob setting. With the
database directory alone changed, the six runs completed 181,835 reads and
350,877 mutations versus 163,700 reads and 357,302 mutations in the control.
Record filesystem and timestamp settings when comparing tails. Run
acceptance with the settings used by the deployment.

## Measures for the next integration

| User action | Owning component and next observable result |
| --- | --- |
| Open a board or move a card | Projections measure the four-filter, top-50 view at p95 <5 ms warm and ≤15 ms cold. After a move, check the first result for its receipt while a projection backlog exists. Track card order, group counts and visible frame time. [Projections](https://github.com/docouno/notarium/issues/5) |
| Search a Space | Search measures lexical p95 <40 ms and hybrid p95 <95 ms on its specified corpus. Verify authorized results and lexical fallback at the 150 ms embedding deadline. Time the first useful visible results through the client separately. [Search](https://github.com/docouno/notarium/issues/6) |
| Type together or save an open note | Collaboration measures local echo, durable update acknowledgement and delivery to the second editor separately. The <3 ms coalesced checkpoint applies to the intercepted path. Verify that acknowledged edits survive restart. [Collaboration](https://github.com/docouno/notarium/issues/7) |
| Switch chat branch or undo a Keeper run | Chats and Keepers measure the correct 50-entry window, command receipt and visibility of restored notes. Measure time to the first provider token separately. Keep the selected tier’s chat-window and rollback p95 limits as component checks. [Chats and Keepers](https://github.com/docouno/notarium/issues/8) |
| Edit while an import or backup runs | Jobs measure foreground read/save tails during background work, the export manifest read <50 ms, the applicable backend and tier’s confirmed paired pause, archive completion and verified restore. [Jobs and backup](https://github.com/docouno/notarium/issues/9) |
| Save from an external editor or switch branches | Vault measures filesystem change to durable receipt and visible revision. Track convergence and ID preservation across the 300-file checkout. The <500 ms sidecar shutdown check times the flush and release after parent exit. [Vault and sidecar](https://github.com/docouno/notarium/issues/10) |

For ordinary note saves the scale suite specifies p95 <12 ms on local NVMe
SQLite and <25 ms on PostgreSQL, under 50 writes/s and 500 reads/s with a
50,000-note import. The storage saturation suite uses 50 concurrent writers.
Time request-to-receipt through the API and action-to-visible-result in the
product client as those entry points become available.
[API integration](https://github.com/docouno/notarium/issues/11) ·
[System workload and acceptance](https://github.com/docouno/notarium/issues/13)
