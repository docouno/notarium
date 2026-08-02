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
| `lean` | `lean:static`, `lean:unit`, `lean:build` | every push and merge request |
| `lean` | `lean:release-preflight` | a release tag only — answers in seconds whether this ref can publish at all |
| `extended` | `extended:unit`, `extended:postgres`, `extended:e2e`, `extended:visual` | a release or rehearsal tag, the default branch, on demand elsewhere |
| `extended` | `extended:visual-bootstrap` | manual, and only on the default branch or a rehearsal tag — it replaces the canonical baselines rather than proposing a candidate |
| `verify` | `visual:gate`, `visual:accept`, `verify:backup-smoke`, `verify:release-smoke` | with the extended lane |
| `release` | `release:rc` | manual; the default branch or a `-rc.N` tag |
| `release` | `release:publish` | manual; a `vX.Y.Z` tag only |
| `deploy` | — | declared and empty, on purpose |

**The lean jobs share one stage** because stages are barriers. Split across stages, a
lint error would mean the tests never run, and a type error would only surface on the
next push — the serial fix-push-discover loop the split exists to kill. Jobs that
should report together sit together; stages separate only real dependencies: the code
is green, *then* the built image proves itself, *then* anything is published.

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

**The full dependency profile is not optional in the extended lane.** Since the
license corpus validates the complete production tree, `test/release/licenseCorpus.test.ts`
is red on a lean install; the vector suites need the native stack. `deps:lean` and
`deps:full` are npm scripts precisely so the Makefile, this pipeline and the future
public gate cannot drift apart on what "install" means.

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
v1/channels/candidates/<slug>.json   a proposed snapshot, slug = <ref>-<commit>
reviews/<date>-<slug>/index.html     presigned links to what changed
```

The review key is dated and carries the candidate slug because it is browsed by hand:
a listing sorts chronologically, the name says which ref and commit it belongs to, and
it is literally the slug `visual:accept` takes — so the folder answers "which one am I
accepting" without a lookup.

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

**An approval expires by construction.** The candidate slug carries the exact commit,
so pushing a new one means `visual:accept` addresses a candidate that does not exist,
rather than silently blessing different pixels.

### What the gate reads

The verdict comes from Playwright's own JSON report, not from the files under
`test-results/`. A directory cannot answer the question: an attempt that *passes*
writes no artefact, so a cell that failed once and passed on retry looks exactly like
a real change, and walking the directory would publish that flake as one. Playwright's
`flaky` status is exactly that case and is dropped — the retry already is the second
render, so nothing has to be rendered twice on purpose.

Two numbers reach the gate, because they are two different verdicts:

- `VISUAL_DIFFS` — cells whose pixels moved. Reviewable, acceptable.
- `VISUAL_FAILURES` — tests that failed **without** a screenshot (a timeout, a broken
  page). There is nothing to review and accepting a baseline will not fix it.

`extended:visual` succeeds even when the pixels differ, and `visual:gate` carries the
verdict. That is not laxity — it is the only arrangement GitLab allows: an
`environment:url` from a dotenv report is applied only to a job that *succeeded*, a
failed job hands its artefacts to nothing downstream, and `needs:` on a failed job
skips the dependant. "The failing job produces the review link" is not expressible.

The gate exists only in the pipelines where the comparison ran, and only speaks when it
actually reported. Both halves are deliberate: it carries `needs: extended:visual`, so a
comparison that died before writing its dotenv skips the gate rather than letting it
read an empty report as "nothing moved" (that failure is already red through the
comparison itself); and it carries the extended lane's own events as rules, so a merge
request that only ran `lean` shows no visual verdict rather than a green one. It was
previously present in every pipeline, and reported "matches the accepted baseline" in
runs where nothing had been compared at all.

### Accepting a change

1. The pipeline runs `extended:visual`. It pulls the canonical set, compares, and — if
   anything moved — uploads a candidate plus a review page.
2. `visual:gate` is red, names the count, and prints the review page's **bucket path**.
3. Open that page out of the bucket by hand (download `index.html`, open it locally —
   the images inside are presigned and load for seven days).
4. If the new rendering is correct, run **`visual:accept`**. It moves the channel to
   the candidate you just looked at. No render, no recompute.

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

### Bootstrapping

`extended:visual-bootstrap` is manual and one-off: it renders the whole set with
`--update-snapshots` in the canonical image, on the runner that will be checking it,
and publishes it as a first candidate. Deliberately not seeded from a developer
machine — that way the question "does this host render like the runner" never has to
be asked, and the invariant "baselines are produced by the lane that verifies them"
holds from the first snapshot.

It is offered on the default branch and on a rehearsal tag, and nowhere else. This is
the one button in the contour that *replaces* the canonical set instead of proposing a
candidate for review, so it does not belong in an arbitrary merge request's pipeline
one stray click away. Needing it on a branch means tagging that branch `ci/<label>`,
which is the same explicit, disposable act the rest of the lane is rehearsed with.

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
cannot offer a review page, and it never pretends to have published one.

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

**The build directory belongs to the runner slot, not to the job.** Whatever a job leaves
behind there is inherited by the next job on that slot, and the lanes here do not agree
on a user: `lean` drops to uid 1000 (the permission guards prove nothing as root), while
the dind lanes run as root. A tree left owned by another user makes git 2.35+ refuse the
repository outright — `detected dubious ownership` — so the lanes that read the revision
declare `safe.directory`, and `lean` hands ownership back when it is done. Skip either
half and a release lane's outcome depends on which slot it happened to land on.

Heavy lanes carry `resource_group: heavy` so they serialise. Each one builds
multi-gigabyte images; running the executor's full concurrency of them at once peaks
at tens of gigabytes of transient layers, which is worth bounding on any runner whose
disk is shared with something else.
