# Contributing to Notarium

Thanks for looking. This file covers working on Notarium itself — the layout, the scripts, the Docker tooling and the release process. For *using* Notarium see the [README](README.md) and https://notarium.ai/en/docs/; for the reasoning behind the design see [docs/architecture.md](docs/architecture.md).

## Repository layout

npm workspaces, nine packages:

| Package | Role |
|---|---|
| `notarium` | The published npm CLI (`npx notarium`) — the only workspace that is not private. It runs on a developer machine and is a different surface from the CLI inside the image ([docs/cli.md](docs/cli.md#npm-cli)). |
| `@notarium/contract` | The executable wire contract for `/api/*` and the MCP tools: zod schemas plus inferred types, one source of truth. |
| `@notarium/core` | The host-agnostic domain core: the `KnowledgeStore` port, the read model, and pure services (identity, journal, visibility, graph). No Node, fs, HTTP or React. |
| `@notarium/engine` | `NotariumStore` — the canonical in-process engine: markdown as truth plus a derived SQLite/FTS5 index. |
| `@notarium/engine-vector` | The optional CPU embedder (`@huggingface/transformers` + `onnxruntime`). Separated precisely so a default install does not pull ~360 MB of binaries. The `vec0` extension is not here — it is an ordinary engine dependency and installs everywhere. |
| `@notarium/engine-memory` | `InMemoryStore` — a reference implementation of the port and an executable spec for deterministic tests. |
| `@notarium/server` | The Fastify host: REST over `KnowledgeStore`, the SPA static files, the MCP gateway, and the admin CLI. |
| `@notarium/web` | The React SPA (Vite): CodeMirror 6, the graph, virtualization. |
| `@notarium/desktop` | A stub Electron shell — empty at MVP, no code yet. |

The split that trips people up first is `engine` vs `engine-vector`: semantic search needs the embedder *installed* **and** `VECTOR_SEARCH=on`. `make deps` deliberately skips the embedder; `make deps-vector` and the Docker image include it. With `on` but no embedder, the server says so once at boot and serves full-text rather than failing. The `vec0` extension is not part of that split — it installs either way, so the vector test suites run on a default checkout.

## Working on the host

Node 24 is expected.

```bash
npm run deps:lean      # default: no embedder
npm run dev            # → http://localhost:3000
npm run dev:tunnel     # the same behind an HTTPS tunnel (see ALLOWED_HOSTS below)
npm run server         # one Fastify process → http://localhost:3000
npm run build && npm start
```

`deps:lean` is the default install the split was made for; `npm run deps:full` (or
`make deps-vector`) adds the ~360 MB embedder when you actually need semantic search.
Use that script rather than a bare `npm ci`: onnxruntime-node otherwise downloads
another ~302 MB of CUDA/TensorRT providers from NuGet during postinstall, while
Notarium's embedder has no GPU execution-provider path. When changing a manifest with
`npm install`, set `ONNXRUNTIME_NODE_INSTALL=skip` for the same reason.

**The app answers on `3000` in every mode** — in production that is Fastify itself, in dev it is Vite with the backend behind the proxy on `3001`, so the URL you open never changes. `npm run dev` moves them with `VITE_PORT` and `API_PORT`; `npm run server` and `npm start` use `PORT`. `dev:tunnel` is the exception and takes the web port from `PORT` (it has to hand the same number to the HMR client, so it sets `VITE_PORT` itself).

Vite only accepts local Host headers by default (a DNS-rebinding guard), so reaching the dev server through a tunnel or a remote box needs `ALLOWED_HOSTS=my.host` (a leading dot — `.example.dev` — covers all subdomains; `all` disables the check). `dev:tunnel` additionally pins the HMR websocket to `:443`.

Keep these green before opening a pull request:

```bash
npm run typecheck
npm run lint
npm run format:check
npm run canon:check    # every `// canon: docs/…` reference resolves to a real anchor
npm run audit:runtime
npm test
npm run test:pg        # requires TEST_PG_URL; `make test-pg` supplies an ephemeral DB
npm run e2e            # Playwright; e2e:docker / visual run in a container
```

`package.json` is the authoritative list of scripts.

`npm test` skipping tests is expected, and the run tells you why — the last line names each closed gate, and whether you can do anything about it. A gate that names a command wants an install (a live database, the optional embedder, or — on a checkout older than the change that made `sqlite-vec` universal — a plain `npm run deps:lean`); `make checkup` opens every one of them. A gate that names a platform instead is a verdict, not a chore: `vec0`'s prebuilt binary is glibc-only, so on musl those suites cannot run here at all. See [dev-environment.md](docs/dev-environment.md#invariants).

## Working in Docker

`make` on its own prints every target. The common ones:

| Target | What it does |
|---|---|
| `make dev` | dev stack with HMR |
| `make up` / `down` | prod image locally / stop and remove |
| `make logs` / `ps` / `sh` | logs / status / a shell in the container |
| `make deps` / `deps-vector` | install dependencies without / with the ~360 MB CPU embedder |
| `make test-coverage` | production build + full coverage, including native vector and permission tests, in an isolated unprivileged Docker stage |
| `make checkup` | every portable code gate: static checks, full containerized coverage/build, live Postgres, backup smoke, container-native e2e; visual is also compared when its external baselines are present |
| `make test-pg` | ephemeral Postgres + live meta-DB contracts/migrations |
| `make test-browser` | e2e in a pinned Playwright image with container-native JS dependencies; visual too when external baselines are installed |
| `make import-bench [NOTES=10000]` | the Markdown-tree import at its supported scale through the production composition; correctness fails the run, timings are reported |
| `make seed CASE=<name>` / `seed-list` | seed a stand with a fixture |
| `make image` / `save` | build the image locally / export it as a tarball for an air-gapped transfer |
| `make release` / `release-rc` | publish a traceable image / publish a pre-release `X.Y.Z-rc.N` |
| `make release-smoke` | run that same flow end to end against a disposable registry |

One self-contained image: a single Node process serving the SPA, the REST API and the in-process engine, with no external services.

The one non-obvious constraint: the base image is Debian, not Alpine, because the native binaries behind vector search are glibc-only. Switching to Alpine breaks them.

## Releasing

Releases are cut by the maintainer in two steps. `npm run release <patch|minor|major|x.y.z>` owns the *version*: it sets one lockstep version across every package, folds the Changelog into a dated section, commits and tags. A manual CI job then owns the *artifact*: it builds the image from the exported release tag, verifies that the built image reports exactly the version, commit and source it should, and publishes an immutable version tag before moving `latest`. It refuses anything it cannot account for — a dirty tree, an unpublished tag, an already-published version. Publishing runs in the pipeline that verified the revision, rather than from anyone's checkout. `make release` drives the same entrypoint from a terminal and publishes just as irreversibly — it is the fallback for when there is no pipeline, not a dry run. To rehearse, use `npm run release:image -- --dry-run` or `make release-smoke`.

One package goes to npm: the `notarium` CLI, published by hand under the maintainer's account (2FA) and deliberately outside `make release` — the release artifact is the image. It still carries the lockstep version, so a CLI-only fix ships at the next product version rather than as its own patch ([docs/release.md](docs/release.md#cutting-a-release)). Every other workspace is private. The running version, its commit and a link to the exact source revision are visible at **Settings → About** and from `notarium version`. The full flow, including pre-releases (`make release-rc` publishes `X.Y.Z-rc.N`, numbered from what the registry already holds) and how to exercise it against a throwaway registry (`make release-smoke`), is in [docs/release.md](docs/release.md).

## Conventions

- **The contract is the source of truth.** `/api/*` and MCP tool shapes live in `@notarium/contract` as zod schemas; types are inferred from them, never hand-written alongside.
- **Comments earn their place.** A comment should carry local, non-obvious truth — an invariant, a footgun, a wire-vs-domain mismatch — or point at the canon with `// canon: docs/<file>.md#anchor`. Restating what the code or the canon already says is noise. The full rubric is in [docs/architecture.md](docs/architecture.md#comments).
- **Docs and code move together.** If a change alters behaviour described in `docs/`, update that file in the same pull request; `npm run canon:check` validates the canon references.
- Repository-facing text is English. Cyrillic appears only where it is a functional fixture — slug transliteration, search-over-Russian test corpora, query samples in the benchmarks.
- **`#N` anywhere in the repository except commit messages refers to the project's internal issue tracker**, which is not public — it turns up in `docs/`, in code comments and in a few package READMEs. The issues themselves are not the canon: the reasoning that survived them lives in `docs/`, and the numbers are kept as provenance for people who do have access. Commit messages carry no issue references at all — see [Commits](#commits).

## Commits

What lands on `main` is one commit per change — pull requests are squashed — so the
message that matters is the pull request's title and description, not the checkpoints on
the branch behind it.

```
<type>(<scope>): <subject>
```

There are four types, and the type answers one question: does a user see this?

| Type | Means |
|---|---|
| `feat` | new behaviour a user can observe |
| `fix` | behaviour that was wrong is now right |
| `perf` | the same behaviour, measurably cheaper — with the measurement in the body |
| `chore` | everything else: docs, dependencies, refactors, tests, CI, repository mechanics |

The scope is where a reader would look first: a package's directory under `packages/`
(`core`, `contract`, `engine`, `engine-vector`, `engine-memory`, `server`, `web`, `cli`,
`desktop` — the directory, not the manifest name, so the published CLI is `cli`), a
subsystem where that says more than the package it lives in (`search`, `graph`, `editor`,
`auth`, `jobs`), or a cross-cutting area (`docs`, `ci`, `release`, `deps`, `repo`). A
change spread across packages takes the primary one.

The subject is English, imperative, lowercase after the colon, no full stop, and the whole
line fits in 72 characters. A breaking change marks the type with `!` — `fix(server)!:` —
and a `BREAKING CHANGE:` footer says what breaks and how to migrate; being pre-1.0 is not
a reason to leave that out. The body is optional and carries the *why*, under the same
rubric as comments — local, non-obvious truth rather than a restatement of the diff. The
one exception to all of this is written by a machine: `npm run release` commits
`chore(release): vX.Y.Z`, naming the version rather than an action, because that is the
line people scan the log for.

**Issues are referenced from the pull request, never from the commit message.** A commit
message is immutable and outlives the tracker it was written against, while a pull request
stays editable and is where the conversation already is — closing keywords in its
description work just as well. (GitHub's squash button appends its own `(#N)` to the
subject; that one is generated, points at the pull request itself, and is fine.)

## Pull requests

This repository is where contributions are accepted. `main` here is the branch you fork,
and a pull request opened against it is merged here, with the button, under your own name.
Day-to-day work happens in a private repository as well — that is where `#N` points and
why the published history starts at a single commit — but it changes nothing about the
path below: a fork of this repository is a complete working copy, canon included.

1. **Fork, then branch.** Work on a branch in your fork rather than on `main`.
2. **Keep the checks green before opening the pull request** — the commands under
   [Working on the host](#working-on-the-host). They do not run automatically on pull
   requests yet, so otherwise the first thing a review does is run them by hand; a branch
   that already passes gets read as code instead of triaged as a maybe.
3. **Open the pull request against `main`.** Title it the way a commit is titled —
   `type(scope): subject`, imperative, under 72 characters — because that title *becomes*
   the commit message on `main` when the pull request is squashed. In the description say
   *why* rather than restating the diff; the diff is already there. Small, focused changes
   get reviewed faster than large ones, and a change that alters behaviour described in
   `docs/` updates that file in the same pull request.
4. **Sign the CLA.** Notarium is dual-licensed (AGPL-3.0 plus a commercial license), and
   offering a commercial license requires the rights to all first-party code — so a
   contribution has to come with permission to relicense it. You keep your copyright.
   **The agreement is still being finalised, and until it exists nothing external can be
   merged** — not because the change is unwelcome, but because merging first is precisely
   what would make that code impossible to license commercially, and unpicking it later
   means rewriting your work. So write to commercial@notarium.ai *before* starting on
   anything substantial: you will get the current state, and small fixes can often be
   handled another way in the meantime. Pull requests opened now are read and reviewed;
   they wait on this one step, not on interest.
5. **Review, then merge.** Notarium is maintained by one person, so review is sequential
   rather than fast; a pull request that sits is queued, not ignored.

Unsure whether a change is wanted before you write it? Open an issue first — a short
description of the problem you hit is enough, and it is cheaper than a pull request that
has to be turned down.

## Security

Do not report a vulnerability through a pull request or a public issue — the fix would
be public before anyone could deploy it. [SECURITY.md](SECURITY.md) has the private
channel, the scope, and the disclosure expectations.

## License

By contributing you agree that your contributions are licensed under [AGPL-3.0-only](LICENSE), subject to the CLA note above. See [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md) for the dual-licensing model.
