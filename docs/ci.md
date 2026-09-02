# Continuous integration

What a pipeline here promises, and where each promise is actually written down.

`.gitlab-ci.yml` is an **adapter**, not the contract. What a gate runs lives in
`package.json` scripts, so a second provider — a public gate on another forge, when
there is one — can call the same commands instead of reimplementing them in a second
YAML nobody diffs against the first. A step that is more interesting than `npm run <script>` is a smell: that
logic belongs in a repo script.

## Lanes

| Lane | Jobs | Runs |
| --- | --- | --- |
| `lean` | `lean:static`, `lean:unit`, `lean:build` | every push, merge request and meaningful tag; unit is the canonical lean coverage + JUnit producer |
| `lean` | `lean:release-preflight` | a release tag only — answers in seconds whether this ref can publish at all |
| `extended` | `extended:unit`, `extended:postgres+visual`, `extended:postgres+visual:gate`, `extended:e2e` | a release or rehearsal tag, the default branch, on demand elsewhere |
| `extended` | `extended:activity-groups` | manual and non-blocking on every pipeline; an on-demand load acceptance, never part of regular checkup |
| `extended` | `checkup:compare` | manual on a `ci/*` rehearsal tag; byte-identical subjects, legacy/candidate orchestration inside one runner |
| `verify` | `visual:gate`, `verify:backup-smoke`, `verify:release-smoke` | with the extended lane |
| `verify` | `visual:accept` | manual on the protected default branch only |
| `release` | `release:rc` | manual; the default branch or a `-rc.N` tag |
| `release` | `release:publish` | manual; a `vX.Y.Z` tag only |
| `deploy` | — | declared and empty, on purpose |

**The lean jobs share one stage** because stages are barriers. Split across stages, a
lint error would mean the tests never run, and a type error would only surface on the
next push — the serial fix-push-discover loop the split exists to kill. Jobs that
should report together sit together; stages separate only real dependencies: the code
is green, *then* the built image proves itself, *then* anything is published.

**Static checks share one job and one install, but keep separate verdicts.** The
repo-owned `check:static` runner starts format, canon, meta-migrations, lint and
typecheck together, prefixes their output, waits for every sibling after an ordinary
failure and writes `test-results/checkup-static.json` in declaration order. The YAML
only selects that preset and publishes its compact report; it does not duplicate the
subprocess graph.

**`lean:build` proves more than "it compiles".** The job is one `npm run build`, and the web
workspace's build script runs `scripts/checkWebBundleBudget.mjs` after Vite, so a generated JS
chunk over the [per-chunk budget](pwa.md#bundle-size) turns the lane red without a job, a stage
or a line of YAML of its own. Same red locally, in the image builder and in the Playwright
build, because all four call that one script — which is the adapter rule applied literally.

**Lanes that run `npm ci` install the declared npm first.** Not for tidiness: `.npmrc`
sets `engine-strict`, and no base image here ships an npm that clears the floor
`package.json` declares, so without the pin the install refuses outright. The version is
read from `packageManager` — the adapter rule again, the number lives in the repo. In
`.lean` the pin goes before the `chown`, because the npm cache is configured inside
`$CI_PROJECT_DIR` and root-owned cache entries would then make the unprivileged `npm ci`
refuse the folder. Lanes that never install — the release lanes only run `npm audit`, and
`extended:unit` runs inside the `--target test` image, which inherits the builder's pin —
carry no pin.

**The extended lane runs on events, never on a timer.** Its inputs are pinned — the
base image by digest, dependencies by lockfile — so the same commit a week later
renders the same answer, and a scheduled run would re-verify an unchanged input. What
changes the answer is a change landing or a release being cut. Everywhere else it is
available on demand, deliberately as a non-blocking manual job: a blocking one leaves
every pipeline sitting unfinished, waiting for a click nobody owes it.

**Two tag shapes, and nothing else, mean anything to this pipeline:**

| Tag | Protected | What it is |
| --- | --- | --- |
| `vX.Y.Z`, `vX.Y.Z-rc.N` | yes | a release. Immutable and never deleted; the only shape the release and deploy lanes may ever attach to. |
| `ci/<label>` | no | a rehearsal. Runs the full gate exactly as a release will, on a ref that is deleted afterwards. |

Any other tag is a bookmark and produces no pipeline at all. The rehearsal shape
exists because the two properties are irreconcilable in one namespace: a release tag
must never be deleted, and a ref used to shake the pipeline out must always be.

**"Run pipeline" in the UI is deliberately not a full run.** The button means "run
the pipeline for this ref", and for an ordinary ref that is the lean one. Making a
click silently cost forty minutes of a serialised runner would make the button mean
something other than what it says — a rehearsal is an explicit, named, disposable
act instead.

**The full dependency profile is not optional, but it is not a reason to repeat the
ordinary corpus.** Lean coverage runs every Vitest file once and is the comparable
MR/main metric. Exactly two cases need the embedder carrier manifests: the native license
corpus and the CPU-only provider assertion. `extended:unit` builds the full production/test
image and runs only those cases before graph-revision. The vec0 suites remain in lean as
they have since #317. `deps:lean` and `deps:full` are npm scripts precisely so the Makefile,
this pipeline and a future public gate cannot drift apart on what "install" means.
The full script is also the single CPU-only install contract: it disables
onnxruntime-node's default CUDA/TensorRT postinstall download, which the product cannot
use and which would otherwise add a second package host to the extended gate.

**`extended:unit` calls one graph-revision command after the two full-only cases.**
`make graph-revision-gate` owns the full #410 contour: it builds traceable runtime and
runner images from the same tree, seeds the neutral 1357-note / ≥20.3 MiB corpus into an
isolated volume, requires effective vector + graph channels, performs one warm mutation
while health/search/unrelated-read/heartbeat run together, and runs the isolated
`--expose-gc` memory sampler. The runtime report reads the actual Markdown count and bytes
observed in the shared volume; it does not restate the generator's expected size. A private,
non-wire observer on the concrete production engine records successful adjacency generations:
the named source→target edge must be absent in the warm generation and present in a later
generation after graph-enabled search. Search ranking and REST/MCP contracts are not used as
the completion signal. The job's `node:24-alpine` image runs the repo-owned full-deps,
profile and graph scripts; YAML adds the Docker client plugins plus `bash` + `make`, then
invokes that command. Image lifecycle, exact OCI identity, cleanup, thresholds, reports
and the compact e5 test tier stay in the repo target/scripts. Its model cache is an ephemeral writable tmpfs;
the runtime image and application data volume remain unchanged. The existing `context-open` baseline is a
different scenario and is not changed or reused. Both graph-revision reports are
disposable job evidence under `test-results/graph-revision/`, not committed baselines.
The dind daemon cannot mount the job checkout, so runner inputs and both JSON reports
cross the Docker API with `docker cp`; the target never bind-mounts a client path. The
job-owned BuildKit builder and every graph seed/runtime/runner container receive the
dynamically resolved lane-A cpuset explicitly: tasksetting the Docker client does not
constrain work created by the sibling daemon.
memory report also carries exact cold single-flight and warm-mutation counter deltas
(`metadataRows`, body reads, parser calls, hit/miss/join, retries/fallback and entries),
while the runtime report owns the HTTP/vector/adjacency-completion latency proof.
CI always supplies `CI_COMMIT_SHA`. Locally, the target infers `HEAD` only from a clean checkout;
a dirty tree must name its frozen identity explicitly or the target refuses before building.

**`extended:activity-groups` is a manual thin adapter over `make activity-groups-gate`.**
It does not inherit the extended event rules and is not part of `make checkup`: the
2M-depth/breadth contour is an on-demand load acceptance, not a tax on every main or
release pipeline. Its manual rule is non-blocking, so merely leaving the button unused
does not keep a pipeline open.
The Alpine `docker:27-cli` job installs `bash` alongside Git, Make and Node because
the repository Makefile explicitly declares `SHELL := /bin/bash`; without that
runtime prerequisite the adapter exits before the gate can create a report.
The gate runner itself joins a private corpus network, so it cannot inherit the
GitLab job container's service-network DNS. In the remote-dind path the driver maps
the TLS name `docker` to the nested container's host gateway and mounts the shared
client certificate directory; this lets its resource/provenance probes address the
same daemon without weakening TLS verification.
The complete profile exceeded thirty minutes on the reference runner. Its temporary
manual adapter therefore has a one-hour outer ceiling, while each child phase retains
an eight-minute ceiling so one broken corpus cannot monopolize the shared heavy resource
group for the whole window.
The target materializes the pinned `main@4d824c3` baseline, builds the exact candidate,
starts resource-capped app/PostgreSQL containers, and delegates corpus generation,
current/historical Note/Folder × Everyone/Mine cycles, existing-surface/append pairing,
rebuild liveness, storage/cardinality and negative controls to the repository runner.

Grouped latency is measured through the production Fastify → CachedStore →
HistorySurface → journal/driver chain, including current-location composition and a
real location-churn turn; benchmark-only folder folding is not an accepted substitute.
Each of the three latency cycles starts a fresh process over a fresh SQLite file copy
or PostgreSQL dump restore, so a previous matrix cell cannot donate database/cache state.
The same cycle runs a 50 ms event-loop heartbeat around the complete production route,
including cold worker startup, main-thread current-location joining, Note sorting,
Folder folding, warm reads and location churn; a fast wall response cannot therefore
hide a perceptible synchronous Dashboard stall. The heartbeat owns every measured
production call and reports the exact 24 historical or 25 current turns; a report that
samples only an idle tail fails even when its delay counters are zero. The full gate
also requires every turn to observe the live timer handle before invoking the route;
a timer created lazily inside the final stop/tail cannot produce an accepted report. The full gate
caps one timer delay at 100 ms and cumulative debt at 25 ms per production turn,
calibrated above the accepted
10k worker envelope (27–42 ms max, roughly 15 ms debt per ready read) but below the
rejected repeated 180–250 ms main-thread stall class. Smoke prints those crossings as
diagnostics without claiming the resource-qualified verdict.
The 2M depth and breadth shapes remain the SQLite read/storage acceptance corpora —
the contour whose synchronous event-loop regression motivated the gate. PostgreSQL
keeps the 200k base read matrix plus its live async contracts, producer contention and
liveness evidence; replaying the two SQLite-specific 2M scale axes there adds runtime,
not a distinct invariant. Derived projections are materialized offline through the
same production set-oriented batch functions at 100k rows per transaction; using the
interactive ten-row scheduler for snapshot construction would add hundreds of
thousands of irrelevant IPC turns. The real ten-row worker remains mandatory in the
liveness phase.
Deep read corpora omit revision blobs because Activity is structurally required to
perform zero body reads; exact source-byte breadth remains represented by the generated
file corpus, while the bounded producer profile still exercises real blob-backed writes.

Producer and liveness evidence use bounded, purpose-shaped corpora instead of replaying
all 2M rows through the interactive append path: producer amplification runs 10k
revisions over 4k active notes in both dialects plus PostgreSQL contention, while
liveness rebuilds 10k revisions over 10k notes through the real production scheduler.
Fresh-ready cardinality requires a head for every non-baseline origin note; baseline-only
notes intentionally have no Activity head until a later change makes them visible.
These exact profiles are recorded in the report and fail closed on drift. This keeps
the original 2M read-regression proof while bounding a task pipeline rather than
silently holding the heavy runner for hours.
SQLite and PostgreSQL dialect lanes execute sequentially. Running them together made
one dialect's corpus construction contaminate the other's event-loop heartbeat; the
gate prefers an isolated measurement and relies on the hard runtime ceilings instead.

The liveness phase measures 90 seconds at the production 50 ms scheduler pace, then
fast-forwards the same batch-10 maintenance calls under named per-phase heartbeat and
foreground probes. Near-publication invalidation, connection/worker restart,
replacement publication, abandoned-generation GC and ready reads each own block,
latency and append evidence; GC batch time is a gated report field rather than a
discarded diagnostic. The final generation must match raw event/note cardinality. Any
missing phase/proof is a failed report, not a boolean filled in by the evaluator.

`smoke` mode uses small production-shaped corpora and is diagnostic; only `full` accepts
the pinned 200k/2M/40k-note manifest and claims the 2 vCPU/2 GiB result. Smoke still
fails when any named phase records an event-loop block of one second, because that
invalidates the liveness observation on every host. Uncapped work-unit and grouped
latency tails of one second are printed as explicit smoke warnings; the
resource-qualified `full` evaluator owns their pass/fail verdict. A Docker daemon
that cannot apply those cgroups fails before measurement rather than emitting a report
with invented resource metadata: the runner inspects its own and PostgreSQL's actual
Docker image ids plus `HostConfig.NanoCpus/Memory`, and the report carries those observed
facts. Under dind the target builds a runner image and moves
the pre-tree archive, scripts and final report through `docker cp`, because the daemon
cannot bind-mount the job checkout.

**Lean coverage has three GitLab surfaces, all produced by the existing `lean:unit`
job.** Its
`coverage:` regex reads only Vitest's `Lines` summary, which feeds the job/MR percentage
and coverage history. It publishes `coverage/cobertura-coverage.xml` `when: always` as both a
downloadable artifact and `artifacts:reports:coverage_report`, which feeds changed-line
annotations, plus `test-results/vitest-junit.xml`, which feeds the MR test count and test
summary. None substitutes for another. `reportOnFailure` keeps diagnostic XML on a red
suite; a repo validator rejects missing/truncated reports and non-repository-relative
Cobertura filenames before a green job can publish them. The coverage XML stays capped at
GitLab's 10 MiB limit.

**Resource topology is repo-owned and bounded across the whole project.** GitLab
`resource_group` is the reservation boundary the Docker executor does not provide:
`notarium-ci-lane-a` and `notarium-ci-lane-b` reserve logical halves rather than named
hardware positions. A job from another branch, tag, merge request or main pipeline waits
for the matching half instead of applying the same relative slice over work already
there. The groups remain independent, so two disjoint jobs can still fill the runner's
complete allowed cpuset.

Lean coverage owns the first half. Static first owns the second, then build reuses it
through a same-stage readiness edge. Once build releases lane B,
`extended:postgres+visual` owns that group as one GitLab job and splits the half again:
PostgreSQL gets its first quarter and visual its second. Keeping both children in one job
is load-bearing: two jobs cannot atomically share one resource-group lease, while
serializing them would add the visual wall to the critical path. E2E then reuses the
complete second half. The full-only image/graph job waits for lean coverage and reuses
the first half; backup, release smoke and either publication job follow there.
`scripts/checkup/profile.mjs` applies exact Linux affinity before installs and final
commands and prints requested/effective values. Plans contain fractional shares, not a
reference machine size: 4/8/16 allowed CPUs map halves to 2/4/8 and quarters to 1/2/4;
non-zero or sparse affinity lists are sliced by position. Only an actually impossible
layout is refused (the combined quartered wave needs at least four CPUs). Dind builds
cannot inherit that taskset, so every automatic image lane creates a disposable Buildx
`docker-container` builder with `cpuset-cpus` equal to the resolved lane and selects it
explicitly through `BUILDX_BUILDER`; `default-load` keeps the existing local-image
contract. GitLab dind supplies its endpoint and client certificates through
`DOCKER_HOST`/`DOCKER_TLS_*`, which Buildx refuses to persist directly in a builder, so
the helper first snapshots that endpoint into a distinct job-owned Docker context and
passes the context to `buildx create`. Builder and context are removed together. The
builder image is digest-pinned in the repo helper rather than following Buildx's mutable
`buildx-stable-1` default. Repo-created runtime containers receive the same cpuset at
`docker run/create`.
The GitLab-owned PostgreSQL service itself remains outside child-process affinity, but
its owning job is inside the logical lane-B reservation. Runner work from other projects
remains outside this repository's authority.
The second wave is a resource dependency, not a test dependency: it prevents the two
Playwright contours and both PG processes from fighting over a saturated host while
still reporting all extended verdicts in one pipeline.

**Parallelism follows isolation boundaries, not individual test files.** Fake E2E runs
two existing Playwright projects at once while every project keeps `workers: 1` and
`fullyParallel: false`; real E2E and visual stay at one worker, and retry-passes remain
red. `extended:postgres+visual` pays one install, waits for its PostgreSQL service without
holding visual back, and records both child outcomes in
`test-results/ci-extended-wave1.json`. PostgreSQL creates a sibling database for the
lock-pairs contour, then runs the four contract files serially beside the serial
lock-pairs file. `test-results/postgres-lanes.json` records both database names, counts,
walls and exits; either PG lane or the visual producer makes the aggregate red without
hiding the other result. The wave job itself stays green once those artifacts are
durable — GitLab cannot pass artifacts from a failed producer to the visual approval
flow. `extended:postgres+visual:gate` immediately reads the aggregate and carries its PG/infra
failure; `visual:gate` independently carries pixel, report and retry failures.

**`checkup:compare` is measurement, not another implementation of the gate.** Historical
trees are retained as negative controls because their export, timing, worker and browser
failures cannot form a three-green timing cohort. The manual rehearsal therefore
materializes the exact candidate commit twice and uses its one driver in normalized
legacy mode (standalone coverage → PG → backup → browser) and candidate mode
(session-owned reuse plus PG ∥ browser). All source, corpus and stability bytes are
identical; only orchestration differs. Warm-up and measured runs alternate order in one
dind/cache protocol. The report keeps driver execution wall, phase wall, max and lease
wait separate; GitLab scheduler/resource-group queue is outside the speed denominator.
Each subject keeps separate stdout/stderr logs. A failed subject stops the cohort but
still writes the aggregate with completed runs, the failed-run paths and its exit/signal,
so `artifacts:when: always` has a machine-readable verdict rather than only a stack trace.
The accepted orchestration benchmark is not rerun automatically after every hardening
patch or patch-equivalent rebase. A fresh legacy cohort is required only when the phase
DAG, artifact-count model or claimed savings changes; ordinary closeout fixes use targeted
contracts and one final candidate/full rehearsal.
The job starts from `node:24-alpine`, adds the Docker client plugins for the existing dind
service and declares a four-hour ceiling: the repository's engine-strict Node floor is met,
while the roughly 160-minute reference cohort still has bounded room for cache variance and
cleanup. The driver prints periodic progress while detailed child streams remain in files.

**`verify:backup-smoke` is one command, because the drill's orchestration lives in
`make backup-smoke`** — the adapter rule applied to a job that used to restate the build,
the image name and the cleanup in YAML. What that target does with its two images, and why
it tags them run-uniquely rather than leaving them untagged, is in
[dev-environment.md](dev-environment.md). The job installs `nodejs make bash`: `bash` is not
incidental — the Makefile declares `SHELL := /bin/bash`, which the `docker:27-cli` image does
not carry. There is no `after_script`, because the target hands its own images back.
Once `extended:unit` releases project-global lane A, backup may start while independent
PostgreSQL/browser work is still finishing on lane B;
`verify:release-smoke` follows backup on the same slice. Neither publishes. The public
release jobs deliberately have no bypassing `needs`, so their later stage still waits
for every verify verdict.

**The shipped image carries no fixture entrypoint.** What the drill has to prove is that a
REAL half-finished durable import survives the archive — an upload staged under the stable
space id with a live `pending` queue row over it, which is what production maintenance
recognises and keeps. That fixture is created by a one-shot container off the `builder`
stage (`test/backup/durableImportFixture.ts`, through the same `dataPathsFromEnv` /
meta-DB / staging seams the server composes), never by a test-only API in the runtime.
The earlier drill wrote a bare file under the space SLUG with no row at all: production
correctly reclaimed it past its grace, and a correct GC on a loaded machine read as a
failed backup gate (#330).

**Publishing is a human decision on a tree the gate has already passed — but not a
human command.** Both release jobs are manual and sit in a later stage than `verify`,
so a red gate means the button is never reachable; nothing has to cross-check "was this
revision verified", because the run that verifies it is the run that publishes it. The
credential is a protected variable, so it does not exist on an unprotected ref at all.
What a person supplies is the decision and the tag — never the build.

**Two jobs, because a release and a candidate promise different things.** `release:rc`
publishes `X.Y.Z-rc.N` and leaves `:latest` alone; `release:publish` publishes the
immutable `:X.Y.Z` and moves `:latest` onto it. Separate jobs rather than one job with
a flag, for the same reason `make release` and `make release-rc` are separate targets:
that difference must not hang on an argument. `release:publish` is offered on a
`vX.Y.Z` tag only — not on `vX.Y.Z-rc.N`, which names a pre-release, and not on a
branch, where the gate would almost always refuse anyway because the tag has to name
exactly the commit being built. A button that only passes by coincidence is worse than
no button.

**Only one of the two is offered on any given ref.** `release:rc` runs on the default
branch and on `-rc.N` tags; `release:publish` on `vX.Y.Z`. Cutting a release tag used
to raise both buttons side by side, which made publishing a candidate into the public
registry a matter of clicking one row too high.

**A release tag has to exist twice.** The gate reads which commit the tag names
locally, and confirms over the network that the same commit is readable in the public
repository, because the image records a source link people can follow. So the tag
reaches GitHub before the button is pressed; a tag that only exists here stops the job
on that check, which is the check working.

**`deploy` is still empty** because rolling a candidate out is currently a one-off
boundary cutover performed from an operator session, not a job. Publishing the GitHub
release is an operator step for the same reason and is likewise not a job here.

## Visual baselines

Baselines are 60-plus full-page PNGs that change whenever the UI does. They live in
private object storage, not in git, so history stays cheap and the matrix can grow.

### Where they live

Two buckets in any S3-compatible object storage, named by `VISUAL_S3_BASELINE_BUCKET`
and `VISUAL_S3_REVIEW_BUCKET` — the protocol knows nothing about the provider beyond
SigV4 and path-style addressing:

- the **baseline** bucket — the images and the pointers, versioned.
- the **review** bucket — review pages, disposable.

Two service accounts: a reader (get) and a writer (get plus put). Everything is
addressed by content digest or by a known key, so neither needs list. The writer
deliberately **has no delete**: nothing in the protocol removes anything, so the
credential that runs in CI cannot destroy a baseline even if it is misused.

Layout, all content-addressed:

```
v1/blobs/sha256/<file-digest>        one PNG, shared by every snapshot that uses it
v1/snapshots/sha256/<digest>.json    a manifest: cell name → blob digest
v1/channels/main.json                the pointer that says which snapshot is canonical
v1/channels/candidates/<slug>.json   proposed snapshot, slug = <ref>-<commit>-<pipeline>-<job>
reviews/<date>-<slug>/index.html     presigned links to what that producer job changed
```

The review key is dated and carries the candidate slug because it is browsed by hand:
a listing sorts chronologically, the name says which ref and commit it belongs to, and
the page repeats the exact producer identity carried by the handoff — so the folder
answers "which reviewed run is this" without a lookup.

Blobs are **global**, not per-snapshot: a snapshot with five changed cells costs five
PNGs, not the whole set. That is the only thing that keeps the storage bill flat as
the matrix grows.

### The three properties this is built to have

**Accept never renders.** The run that found the difference already produced the
pixels. Re-rendering at approval time would be a second, independently
non-deterministic pass — you would be accepting something other than what you looked
at. So `publish` uploads the complete candidate and `accept` only moves a pointer.

**Unchanged cells keep their exact bytes.** A cell that "passed" passed within
Playwright's tolerance, not byte for byte. Carrying its fresh render into the new
baseline would let sub-threshold noise accumulate approval by approval until it
crosses the threshold on its own.

**An approval cannot drift.** The candidate slug carries the exact commit,
pipeline and producer job. Only after its review page succeeds does `publish` create
the immutable pointer and fixed `visual-handoff.json` containing its
candidate/commit/pipeline/job/base/snapshot identity. `visual:accept` consumes that
artifact rather than recomputing it or trusting overridable environment variables,
then verifies the pointer, content-addressed manifest and unchanged base channel before
moving `main`. Accept jobs share `resource_group: visual-baseline-accept`, so the base
check and move are serialized. Another producer run gets a different address and cannot
redirect this handoff; a stale base or overwritten/mismatched pointer fails closed.

**A render never rebases itself.** `pull` removes stale local evidence first and writes
`visual-pulled-base.json` (including an explicit `null` channel) only after every blob
was verified and the local directory was materialized. Publish reads that exact base,
checks that `main` still names it, and fetches its manifest by the recorded snapshot;
it never substitutes the channel current at publish time. The read-only verdict performs
the same channel check with reader credentials, so A→B, A→none and none→A transitions
are red rather than a stale green or a candidate merged onto unrelated pixels.

**Retry is diagnostic, never green.** Fake and real Playwright configs set
`failOnFlakyTests`; a first failure may still retry to collect a trace, but the job remains
red. Visual comparison keeps its inverted publish flow, so it materializes the result
in the fixed handoff artifact and `visual:gate` owns the red verdict beside pixel diffs
and non-pixel failures. Broken/report-integrity evidence publishes nothing. On an
established exact base, a retry-pass may coexist with stable diffs: its fresh bytes are
excluded, the exact accepted cell digest is carried and bound into manifest/pointer/
handoff, while the stable diffs remain reviewable. Accepting those stable cells does not
make the current run green: the gate still reports every flaky cell, and the next pipeline
proves convergence. A first baseline, unknown flaky cell or flakes-only run still has no
candidate.

The pinned Playwright image's Node 24 runtime is kept off Maglev for browser builds,
budget checks, runners, preview composition and long-lived fake/real servers. This is a
narrow best-effort fence for native deaths observed under contention, not a retry or a
root fix: the
[related Node 24 corruption](https://github.com/nodejs/node/issues/64841) is not
fundamentally Maglev. A JavaScript failure or native process death still stays red;
the durable exit is a Playwright image on Node
[26.8.0+](https://nodejs.org/en/blog/release/v26.8.0) or a future fixed Node 24.
The Playwright configs preserve a real desktop bus when present and otherwise pass
`DBUS_SESSION_BUS_ADDRESS=disabled:` only to the browser child. Without it Chrome writes
that fallback into the process environment itself beside an [upstream-documented TSan
race](https://chromium.googlesource.com/chromium/src.git/+/2fc330d0b93d4bfd7bd04b9fdd3102e529901f91);
the fixed fallback keeps the absent session bus explicit and avoids native `getenv` crashes.

### What the gate reads

The verdict comes from Playwright's own JSON report, not from the files under
`test-results/`. A directory cannot answer the question: an attempt that *passes*
writes no artefact, so a cell that failed once and passed on retry looks exactly like
a real change, and walking the directory would publish that flake as one. Playwright's
`flaky` status is exactly that case and is dropped — the retry already is the second
render, so nothing has to be rendered twice on purpose.

Three numbers reach the gate through `visual-handoff.json`, because they are three
different verdicts. `review.env` mirrors them only for informational/UI use; GitLab
variable precedence makes dotenv unsuitable as an authority:

- `VISUAL_DIFFS` — cells whose pixels moved. Reviewable, acceptable.
- `VISUAL_FAILURES` — non-pixel failures: a test without a screenshot, a skipped or
  zero-test run, a global runner error, inconsistent stats, or a duplicate declared
  cell name. There is nothing to review and accepting a baseline will not fix it.
- `VISUAL_FLAKES` — tests that passed only on retry. The gate stays red and names them.
  With stable diffs on an established base, the review explicitly carries their old
  accepted digests; otherwise no candidate is published.

The visual child of `extended:postgres+visual` keeps its producer result green when only the
pixels differ, and `visual:gate` carries the
verdict. That is not laxity — it is the only arrangement GitLab allows: an
`environment:url` from a dotenv report is applied only to a job that *succeeded*, a
failed job hands its artefacts to nothing downstream, and `needs:` on a failed job
skips the dependant. "The failing job produces the review link" is not expressible.

The gate exists only in the pipelines where the comparison ran, and only speaks when it
actually reported. Both halves are deliberate: it carries `needs: extended:postgres+visual`, so a
comparison that died before writing its handoff skips the gate rather than letting it
read a missing report as "nothing moved" (that failure is already red through the
comparison itself); and it carries the extended lane's own events as rules, so a merge
request that only ran `lean` shows no visual verdict rather than a green one. It was
previously present in every pipeline, and reported "matches the accepted baseline" in
runs where nothing had been compared at all.

### Accepting a change

Only a protected default-branch pipeline may move the baseline channel. Rehearsal,
release and ordinary refs compare against it and carry the red gate, but they never
offer `visual:accept`: an unprotected ref has no writer credential or candidate, so such
a button would be both powerless and misleading.

1. The default-branch pipeline runs the visual child of `extended:postgres+visual`. It pulls the canonical set, compares, and — if
   anything moved — uploads a candidate plus a review page.
2. `visual:gate` is red, names the count, and prints the review page's **bucket path**.
3. Open that page out of the bucket by hand (download `index.html`, open it locally —
   the images inside are presigned and load for seven days).
4. If the new rendering is correct, run **`visual:accept`** in that pipeline. It reads
   the exact producer identity from `extended:postgres+visual`'s fixed artifact, verifies the immutable
   pointer and snapshot, then moves the channel. No render, no recompute.

The first run uses exactly the same flow. With no `main` channel, `pull` materializes
an empty baseline set, Playwright reports every named screenshot as new, and `publish`
creates a candidate and review page containing the whole matrix. `visual:accept` then
moves the channel to that reviewed candidate. There is no separate command that can
replace the channel from an unreviewed `--update-snapshots` render.
Every candidate is fail-closed: an empty/inconsistent report and any broken or skipped
test publish nothing. Retry-passes cannot contribute bytes: only stable diffs may form a
candidate, and only when every flaky cell already exists in the exact pulled base.
The first run has the additional requirement that it contain at least one new image,
because there is no accepted snapshot from which it could carry cells forward.

All `toHaveScreenshot` calls in the visual projects resolve into
`test/visual/visual.spec.ts-snapshots/` and use the canonical
`*-chromium-linux.png` renderer suffix. A new spec or project therefore adds cells to
the same manifest instead of silently creating a second snapshot directory that the
storage protocol never reads.

**Why a path and not a link.** Both ways of handing over a presigned URL are closed:
printed in a job log it comes out with `[MASKED]` where `X-Amz-Credential` sits,
because the key id is a masked variable; set as an environment URL it is silently
discarded, because GitLab caps `external_url` at 255 characters and a SigV4 URL is
around 360. A path is short, survives redaction and is still true in a month. A proper
review surface — a small service that serves these pages — is the real fix and is not
part of this contour yet.

**A diff covering the whole matrix is information, not noise.** Every cell moving at
once means a global change — a font, a colour token, a browser bump — or that the
baselines were produced on a different class of machine than the one comparing them.
Both are worth understanding before accepting; the first is usually intended.

### Known gap

Playwright reports cells that changed and cells that are new, never cells that
disappeared. A cell dropped from the matrix keeps its entry in the manifest
indefinitely. Harmless while the matrix keeps its shape; it needs real handling when
responsive work reshapes the set of frames.

### Running it locally

`make checkup` compares the visual suite only when
`test/visual/visual.spec.ts-snapshots/*.png` is present in the checkout, and reports
an explicit skip otherwise — it never blesses the current rendering as its own
baseline. To fetch the canonical set, run the protocol directly with reader
credentials:

```bash
VISUAL_S3_ENDPOINT=… VISUAL_S3_REGION=… VISUAL_S3_BASELINE_BUCKET=… \
  VISUAL_S3_KEY_ID=… VISUAL_S3_SECRET=… node scripts/visualBaseline.mjs pull
```

## CI variables

| Variable | Protected | What it is |
| --- | --- | --- |
| `VISUAL_S3_ENDPOINT` / `VISUAL_S3_REGION` | no | which S3-compatible storage, and its region |
| `VISUAL_S3_BASELINE_BUCKET` / `VISUAL_S3_REVIEW_BUCKET` | no | the two buckets above |
| `VISUAL_S3_READ_KEY_ID` / `VISUAL_S3_READ_SECRET` | no | reader; enough to compare |
| `VISUAL_S3_WRITE_KEY_ID` / `VISUAL_S3_WRITE_SECRET` | yes | writer; publish a candidate, move the channel |
| `DOCKERHUB_TOKEN` | yes | the registry credential the release lane authenticates with |
| `DOCKERHUB_USER` | no | registry account; defaults to the image namespace |

None of the storage variables has a default in the code (`DOCKERHUB_USER` does, and is the
only one that can be omitted). Where the baselines live is deployment
configuration: a fork runs the same lane against its own storage, and a default would
point its writes at a bucket it does not own. A missing one is named on stderr rather
than guessed at — as `VISUAL_S3_KEY_ID` / `VISUAL_S3_SECRET`, which is what the job
passes the chosen pair in as, rather than by its `*_READ_*` / `*_WRITE_*` name above.

Because the writer is protected, it is absent on ordinary branches — and the lane
degrades honestly there: it still compares and still fails on a difference, it just
cannot offer a review page, and it never pretends to have published one. The adapter
checks both optional writer fields with default-safe shell expansion under `set -u`;
if either is absent, it runs the local verdict path and still emits the dotenv report.
The same path always emits the authoritative `visual-handoff.json`; downstream jobs do
not read verdict or identity from environment variables.

## What the runner has to provide

The pipeline is built around a docker+dind executor, privileged, with two properties
that are runner configuration rather than job configuration:

- `/certs/client` shared between the job and the dind service — without it the
  documented TLS setup cannot work, because the two containers each get their own
  empty directory.
- `/cache` shared into jobs, so the npm cache keyed on the lockfile survives between
  runs. Without it every job refetches a resolution set that has not changed.
- `shm_size` of 2 GB — the default 64 MB of `/dev/shm` crashes Chromium with
  unexplained "Target closed" errors. (`docker/compose.test.yml` defends against the
  same thing locally with `ipc: host`.)

Only lanes that **build images** use dind. The browser lanes run in the pinned
Playwright image as the job image, so the runner pulls it to its host once and reuses
it; inside dind those 2.3 GB would be re-pulled on every run and thrown away.
Automatic dind lanes create a job-named Docker context plus Buildx builder on their
resolved cpuset and remove both in `after_script`. The context materializes the existing
TLS endpoint for Buildx; it does not introduce another daemon or credential source. This
is a resource boundary, not another cache: each dind daemon is already job-scoped, and
the builder exists only so build steps cannot escape the resource-group half through the
daemon service.

**The build directory belongs to the runner slot, not to the job.** Whatever a job leaves
behind there is inherited by the next job on that slot, and the lanes here do not agree
on a user: `lean` drops to uid 1000 (the permission guards prove nothing as root), while
the dind lanes run as root. A tree left owned by another user makes git 2.35+ refuse the
repository outright — `detected dubious ownership` — so the lanes that read the revision
declare `safe.directory`, and `lean` hands ownership back when it is done. Skip either
half and a release lane's outcome depends on which slot it happened to land on.

Every automatic CPU-heavy job carries one of the two project-global resource groups.
Image-heavy dind work (`extended:unit`, backup smoke, release smoke and publication)
shares logical lane A and therefore remains serial across every pipeline. Static/build,
the combined PostgreSQL+visual wave and E2E share lane B in dependency order. The repo
profile maps both lanes onto the complete cpuset actually granted to the job; group names
never encode hardware ids. The legacy `heavy` group remains only for explicitly launched
diagnostic/load jobs whose operator already owns the decision to spend the entire host;
they are not part of an automatic gate.
