# Releasing

A published Notarium image has to answer one question without being trusted:
**which source is this, exactly?** Everything below exists to make that answer a
fact — readable from the artifact itself — rather than a claim in a release note.

Publishing goes through one entrypoint (`scripts/releaseImage.mjs`) and deliberately
has no second way in. What differs is who presses it. **A real publication is a CI
job, not a command anyone types**: `release:publish` and `release:rc` sit behind the
gate that verified the very revision they publish, and their registry credential
exists only on a protected ref (see [ci.md](ci.md)). A release built from a laptop
would be a release nothing verified.

The same entrypoint has two local front doors. They are **not** a rehearsal — both
publish for real, to the same public registry, and a version tag cannot be taken back:

```bash
make release              # a release      → :X.Y.Z, then :latest
make release-rc           # a pre-release  → :X.Y.Z-rc.N, :latest untouched
```

Reach for them only when there is no pipeline to lean on. They are separate targets,
not one target with a flag, because they promise different things — and that
difference should not hinge on remembering an argument. The CI jobs mirror them one
to one for the same reason.

Rehearsal is a different command: `npm run release:image -- --dry-run` runs the gates
and a real build and publishes nothing, and `make release-smoke` drives the whole flow
against a disposable registry. Note what dry-run cannot cover — the immutability gate
answers from the registry twice, and the second answer is only meaningful once
something has been pushed.

It refuses to publish anything it cannot fully account for. A refusal is the
feature; a release that "mostly" matches its source is worse than no release.

## Identity

Four values travel with every released image and must agree everywhere they
appear:

| Value | Where it comes from | Where you can read it back |
|---|---|---|
| version | the lockstep root `package.json`, plus `-rc.N` for a pre-release | `notarium version`, `/api/about`, label `…image.version` |
| revision | the commit the release tag names | `notarium version --json`, `/api/about`, label `…image.revision` |
| build time | the moment the image was built | `notarium version`, `/api/about`, label `…image.created` |
| source | `<repository>/tree/<revision>` | `notarium version`, `/api/about`, **Settings → About** |

The values are inlined into the bundles at build time (`tsup`/`vite` `define`), as
string literals, so the running container reads no manifest and never shells out to
git — the runtime stage has no git at all. Outside a release build the ones that
would have to be guessed are honestly empty instead: a plain `docker build` produces
an image reporting `null` for commit and source (P5 —
[architecture.md](architecture.md#p5)). Build time is always real, because the build
always knows when it happened.

The `source` link is what an operator follows from a running instance to the code
it was built from. That path is also what AGPL-3.0 asks us to offer the people
using the service, which is why it lives in the UI and not only in registry
metadata.

## What the release entrypoint enforces

The order matters — each step is a gate, not a formality.

1. **The version is releasable** (releases only). A clean `x.y.z`, matched by a
   dated `## [x.y.z] — YYYY-MM-DD` section in the Changelog, with nothing still
   parked under `[Unreleased]`. A pre-release is exempt — see below.
2. **The tag exists and is the tree you are looking at.** A `vX.Y.Z` pointing at
   `HEAD`, on a clean working tree. Its shape is not checked — annotated or
   lightweight, what matters is the commit it names.
3. **The tag is public.** `git ls-remote` against the source repository must find
   that tag at that commit. An image whose source link nobody can open is not
   traceable, only decorated.
4. **The version tag is free in the registry.** If `IMAGE:VERSION` already
   exists, the release stops. A published version tag is immutable: people pin
   versions, and a pinned version that quietly changes content is the failure this
   whole flow is built to prevent. An unreadable answer (no login, no network)
   also stops it — refusing beats pushing blind.

   There is one case where that answer can be *legitimately* unreadable: an image
   repository that does not exist yet, since a registry may answer "no such
   repository" and "you may not look" the same way. **Create the repository in the
   registry UI before the first release** and the question does not arise — an
   existing but empty repository on Docker Hub answers `no such manifest`, which
   reads cleanly as "the tag is free" (verified against the real Hub while logged
   in as the owner). `--first-publication` exists for the other route — letting the
   first push create the repository — and is recorded in the release record.
5. **The build context is the tag, not your disk.** The sources are exported with
   `git archive <tag>` into a scratch directory, and the image is built from
   there, using the Dockerfile from that same export. Uncommitted edits, an
   untracked scratch file, a local Dockerfile tweak — none of them can reach a
   published layer, because they are not in the context at all. This is the
   difference between a guard (which can be bypassed) and a property (which
   cannot).
6. **The exported production dependency graph passes the security policy.** The
   audit runs from the archive, against its own `package-lock.json` and reviewed
   exceptions — never against the maintainer's working tree. Any unreviewed
   high/critical advisory, invalid/expired exception or audit failure stops before
   the first image layer is built.
7. **The built image is interrogated before it is published.** `notarium version
   --json` inside the image, the OCI labels via `docker inspect`, the SPA bundle
   (it carries its own inlined identity — a mismatch there is the stale-bundle
   symptom About exists to surface), and a real boot on a fresh volume answering
   `/api/health` and `/api/about`. Any disagreement with the release record fails
   the release.
8. **Publication is ordered.** The immutability check runs again (minutes have
   passed), then `IMAGE:VERSION` is pushed and its digest read back from the
   registry. Only then does `latest` move. A broken build can never leave `latest`
   pointing at itself.
9. **The platform is what was asked for.** `--platform` is a request; an older
   builder can hand back the host architecture instead. The built image's own
   `Os/Architecture` is compared to the declared platform before publication, so an
   arm64 machine cannot quietly publish the amd64 release. Publication currently
   accepts only `linux/amd64`: the committed native license corpus is
   architecture-specific, so arm64 stays fail-closed until the multi-arch release
   task provides a union/per-platform corpus.
10. **`latest` only moves forward.** Releases are not always chronological — a
   backport to `0.1.x` can land after `0.2.0` — and `latest` is what every plain
   `docker pull` gets. So the release reads the version currently published under
   `latest` (from its own OCI label, no image pull) and refuses to move it onto an
   equal or older version, or onto anything it cannot read. That refusal does not
   fail the release: the version tag is already published and correct, and the run
   says so. `--force-latest` overrides when moving it really is what you mean.

Two of these are deliberately NOT fatal, because they happen after the version tag is
already published and immutable: an unreadable digest and a failed `:latest` push. The
run reports what landed, prints how to finish by hand, and exits non-zero — aborting
instead would leave a published image with no record of it and no supported way to
complete the release.

The digest printed at the end is the artifact identity — record it with the
release notes.

## Production dependency audit

`make audit-runtime` audits the complete npm production graph represented by the
root lockfile, including every workspace and the optional vector carrier installed
in the production image:

```bash
make audit-runtime
```

The release entrypoint repeats this check after `git archive`, using
`scripts/runtimeAudit.mjs`, `security/runtime-audit-policy.json` and
`package-lock.json` from the exported revision. A local policy edit therefore
cannot approve a different graph from the one Docker receives. The npm advisory
service is part of the gate: an unavailable or malformed audit response is a
failure, not an implicit pass.

The command fixes its authority to the public npm advisory registry and explicitly
includes the root plus every workspace, production, optional and peer dependency.
Inherited npm workspace/omit selectors are neutralised, so a maintainer's `.npmrc`
or CI environment cannot quietly narrow the graph claimed by this gate.

High and critical findings block by default. Prefer upgrade or removal; an
exception is the last resort and has exactly this shape:

```json
{
  "advisory": "GHSA-2345-6789-cfgh",
  "package": "example-package",
  "version": "1.2.3",
  "condition": "Why the vulnerable path is unreachable in this release.",
  "owner": "notarium-maintainers",
  "expires": "2026-08-31"
}
```

The advisory id and installed version are exact — ranges and wildcard approvals
are rejected. `condition`, `owner` and an inclusive UTC expiry date are mandatory.
An expired exception fails, and an exception that no longer matches the audit also
fails so patched packages remove their temporary policy debt.

This production graph is the server/image boundary, not a claim that build-only
or browser-bundled packages are harmless. The latter currently live in
`devDependencies`; review them with the full `npm audit` and keep their
compatibility/security migrations explicit rather than weakening the production
gate. The browser inventory in the license corpus remains the authoritative list
of what the Vite/PWA build ships.

The root `overrides` currently carries exact patched versions of
`@hono/node-server`, `adm-zip` and `sharp` because their direct parents still
declare older vulnerable ranges. Consequently `npm ls --all` reports those three
edges as `invalid`: this is expected range debt, not an unresolved install.
`npm ci`, the production audit, the complete server/vector/browser tests and the
release smoke are the compatibility gates. Remove each override as soon as its
parent accepts the patched line; never widen an override to a range.

## Cutting a release

Before cutting the tag, refresh the committed license corpus from a clean, full
dependency install. The generator validates every visited package against
`package-lock.json` and refuses a stale or lightweight `node_modules`:

```bash
make deps-vector
npm run licenses
git diff -- THIRD_PARTY_NOTICES.md packages/web/public/licenses packages/web/public/fonts
```

Review and commit any resulting corpus change with the dependency change. This is
an explicit release-maintenance step rather than an image-build mutation: the
release image is built from the immutable tag and must not generate uncommitted
legal material on the fly.

The browser inventory has one deliberate manual edge. Dependencies bundled from
`packages/web` devDependencies and code injected by build/PWA plugins are listed
explicitly in `FRONTEND_ROOTS` in `scripts/gen-licenses.mjs`; they cannot be
derived from production manifests alone. When adding, updating or removing a
bundled devDependency, Vite/PWA plugin or build transform, make a production build
with source maps (`npm exec -w @notarium/web -- vite build --sourcemap`), compare
the packages represented in the emitted bundle with the browser corpus, and update
`FRONTEND_ROOTS` before regenerating. An ordinary package bump that does not
change that build-time inventory needs only the commands above.

Vite is called directly there rather than through `npm run build -w @notarium/web`
because that script chains the [bundle-size gate](pwa.md#bundle-size) after Vite, and
npm appends a `--` flag to the end of the whole chain — so `--sourcemap` would reach the
gate instead of Vite, silently emitting no maps. The consequence is that this one
diagnostic build is not size-checked; rebuild normally afterwards rather than leaving an
ungated `dist` behind.

```bash
npm run release <patch|minor|major|x.y.z>   # bump the lockstep version, fold the
                                            # Changelog, commit, tag vX.Y.Z
git push && git push origin vX.Y.Z          # publish the commit and the tag
```

Then press **`release:publish`** on the tag's pipeline. That is the whole release:
the pipeline that verified the revision is the pipeline that publishes it.

**The tag has to be readable at `--source-repo` before the job runs**, which is not
necessarily the remote the pipeline runs on: the gate resolves the source link there,
and an image whose source nobody can open is not traceable. If you push from a checkout
with more than one remote, the tag goes to all of them first.

`npm run release` (`scripts/release.mjs`) owns the *version*: it writes one
version across every manifest, turns `[Unreleased]` into a dated section, commits
and creates the annotated tag. `release:publish` (`scripts/releaseImage.mjs`) owns
the *artifact*. They are separate because the tag has to be public before the
image can honestly point at it — the artifact gate reads the public repository and
refuses a tag it cannot find there.

A tag cut through a web UI works just as well as `git tag -a`, message or no message.
The gate deliberately does not care about the shape of a tag: nothing here reads a
tagger or a tag message (no `git describe`, no `--follow-tags`, no signature check),
and where a release came from is already carried by the commit, the image's `builtAt`
and the Changelog section. Requiring an annotation bought nothing and failed at the
worst possible moment — after the full gate had run and someone had pressed publish.

Registry coordinates default to `docouno/notarium` on Docker Hub with sources at
`github.com/docouno/notarium`; override with `--image`, `--registry` and
`--source-repo`. Only a local run needs `docker login` — the job authenticates from
its protected credential.

The npm CLI is **not** built by this flow, but it does share its version.
`packages/cli` (`notarium` on npm) is the one publishable workspace, and the
lockstep bump rewrites its version like every other manifest — so the CLI can only
be published *at* a product version, and a CLI-only fix reaches users at the next
product release rather than as its own patch. That is deliberate: one version
number across the repository means `notarium@X.Y.Z` and the `X.Y.Z` image are
always the same revision, so neither side has a compatibility matrix to guess at.
The cost is a slower path for CLI-only changes, and it is the accepted one. Its help text therefore points at the floating `docouno/notarium:latest`
rather than a pinned tag it would outlive.

`0.1.0` is already taken on npm: the name was claimed before the CLI had been
reviewed, so what sits in the registry under that version is an earlier build —
it predates the argument-contract and stream handling described in
[the image CLI contract](cli.md#npm-cli), and carries no `NOTICE`. npm versions are
immutable, so that build stays where it is; the corrected CLI reaches users at the
next product version, and until then the published `npx notarium` is a weaker
executable than this repository describes.

**So the npm step does not run for `0.1.0` at all** — the version is spent, and
`npm publish` would refuse it. It resumes at the next product version. Everything
below describes that step when it does run.

Publishing itself is by hand (`npm publish -w notarium`, maintainer account, 2FA)
from a clean tree at the release tag — `prepublishOnly` rebuilds `dist` from the
working tree, so anything uncommitted would ship silently. It is irreversible after
72 hours, so run `npm publish -w notarium --dry-run` first and read the warnings
rather than the file list: a `bin` path written with a `./` prefix is dropped from
the published metadata with only a warning to say so, and `npm pack` shows that
path intact, so the tarball looks correct while `npx notarium` would have no
executable at all.

### The first release is different

Step 1 does not apply to `0.1.0`, and running it will refuse: the manifests already
say `0.1.0`, so there is nothing to bump. `npm run release 0.1.0` stops on "tag v0.1.0
already exists", and `npm run release patch` would cut the wrong version. The Changelog
was likewise folded by hand — a dated `[0.1.0]` section was written ahead of the
release, so `foldUnreleased` had nothing to create. That is a one-off consequence of
dating a section before it shipped.

**One thing it leaves behind.** `foldUnreleased` rewrites an `## [Unreleased]` heading
into the new dated section, and the hand-folded Changelog has no such heading at all —
so the next `npm run release` will refuse until one is added back. Open an
`## [Unreleased]` section with the first change that lands after this release, and the
normal two-step flow works again from there.

**Its date must be the day it is actually published.** For `0.1.0` that had to be set
by hand as part of cutting the root, because no tooling ran to set it.

The tag is the other difference. The private history carried a `v0.1.0` on the June
MVP merge — from before the product existed — which the gate rejects because it does
not name `HEAD`, correctly. It does not survive the squash root, so a clone of the
public repository never sees it.

So `0.1.0` is cut on the squash commit itself:

1. Push the root to both remotes.
2. Cut `v0.1.0` on it in each.
3. Press `release:publish` on the tag's pipeline.

The tag has to reach the public repository before the button, not because of ordering
etiquette but because the gate reads it there: an image whose `source` link is a 404 is
exactly what the identity chain exists to prevent.

Every later release goes through the normal two steps above.

## Pre-releases

A pre-release publishes the SemVer pre-release `X.Y.Z-rc.N` into the **same**
repository, through the same entrypoint:

```bash
make release-rc
```

Its version is the release it **precedes**, not the one already out. Between releases
the manifests still hold the last cut version, so a naive `X.Y.Z-rc.N` would
SemVer-order *below* a published `X.Y.Z` whose code it supersedes — and any
version-sorting tool would read "upgrade to X.Y.Z" as forward when it is a downgrade.
So the release checks whether `X.Y.Z` is already in the registry and, if it is (or if
the registry cannot say), attaches the pre-release to `X.Y.(Z+1)` instead.

It differs from a release in exactly four ways, all of them consequences of it not
being one: no release tag is required (it builds from `HEAD`), the source revision
is not required to be published, the Changelog is not required to be folded (a
pre-release is by definition cut from a tree with work still in flight), and
`latest` is left alone — by convention `latest` means the newest *stable* image. Everything else holds: the
context is still an export, the identity is still verified, the tag is still
immutable. The image reports `0.1.0-rc.1` rather than `0.1.0`, so a build handed to
someone early cannot be mistaken for the release it precedes.

**`N` is the first candidate number the registry does not already hold.** It is asked
for with the same immutability probe that guards every version tag, so the counter
needs no state of its own — and a registry that will not say what it holds is a
refusal, not a free number. The revision is deliberately *not* in the version string:
it is in the labels, in `notarium version`, in `/api/about` and in the source link,
while `-rc.<sha>` in the version made candidates of one release SemVer-order
alphabetically by hash — that is, at random — and left no way to aim a candidate at a
planned minor.

Two things a pre-release does NOT promise, and says so on the way out: its source
link points at a revision nobody checked is reachable in the public repository,
and it is not the release.

Because it is the same code path, it is also how the flow is rehearsed before a
real cut — including the parts that only exist at publication time (the
immutability gate, the digest, the version→latest ordering):

```bash
make release-smoke
```

That starts a disposable local registry, runs the entrypoint against it, and
asserts the behaviour end to end: the image is built, verified, pushed, read back,
and a second push of the same tag is refused.

For a dry run against real coordinates without publishing anything:

```bash
npm run release:image -- --dry-run
```

## Platform

The published image is **`linux/amd64`**, declared rather than inherited from
whatever machine ran the build — an arm64 maintainer building "the release" on
their laptop would otherwise hand everyone an image they cannot run. Other
architectures build from source in the meantime; a multi-arch artifact is its own
task, because it also changes what "one digest" means and how the immutability
check reads a manifest list.

## Base image

`docker/Dockerfile` pins `node:24-slim` **by digest**, in both stages. Without
that, "the image built from tag v0.1.0" resolves to something different every time
upstream moves, and the traceability above stops at our own code.

Bumping it is a deliberate commit, not a side effect of a rebuild:

```bash
docker buildx imagetools inspect node:24-slim --format '{{.Manifest.Digest}}'
```

Use the **index** digest (the multi-arch manifest list), keep the builder and
runtime stages in lockstep, and update `…image.base.digest` in the same edit. The
release checks the exported Dockerfile and refuses to build if those three literals
disagree, so a half-done bump cannot ship an image whose metadata names a base it was
not built on. Nothing, however, tells you the pin has gone stale — re-pinning is a
maintenance habit, not an automated one.
