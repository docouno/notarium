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
| `@notarium/engine-vector` | The optional native vector stack (`onnxruntime` + `sqlite-vec`). Separated precisely so a default install does not pull ~660 MB of binaries. |
| `@notarium/engine-memory` | `InMemoryStore` — a reference implementation of the port and an executable spec for deterministic tests. |
| `@notarium/server` | The Fastify host: REST over `KnowledgeStore`, the SPA static files, the MCP gateway, and the admin CLI. |
| `@notarium/web` | The React SPA (Vite): CodeMirror 6, the graph, virtualization. |
| `@notarium/desktop` | A stub Electron shell — empty at MVP, no code yet. |

The split that trips people up first is `engine` vs `engine-vector`: semantic search needs the native stack *installed* **and** `VECTOR_SEARCH=on`. `make deps` deliberately skips the native stack; `make deps-vector` and the Docker image include it. With `on` but no stack, search degrades to full-text rather than failing.

## Working on the host

Node 24 is expected.

```bash
npm install
npm run dev            # → http://localhost:3000
npm run dev:tunnel     # the same behind an HTTPS tunnel (see ALLOWED_HOSTS below)
npm run server         # one Fastify process → http://localhost:3000
npm run build && npm start
```

**The app answers on `3000` in every mode** — in production that is Fastify itself, in dev it is Vite with the backend behind the proxy on `3001`, so the URL you open never changes. Move them with `PORT` and `API_PORT`.

Vite only accepts local Host headers by default (a DNS-rebinding guard), so reaching the dev server through a tunnel or a remote box needs `ALLOWED_HOSTS=my.host` (a leading dot — `.example.dev` — covers all subdomains; `all` disables the check). `dev:tunnel` additionally pins the HMR websocket to `:443`.

Keep these green before opening a pull request:

```bash
npm run typecheck
npm run lint
npm run format:check
npm test
npm run test:pg        # requires TEST_PG_URL; `make test-pg` supplies an ephemeral DB
npm run e2e            # Playwright; e2e:docker / visual run in a container
```

`package.json` is the authoritative list of scripts.

`npm test` skipping tests is expected, and the run tells you why — the last line names each closed gate and the command that opens it. Those suites need the optional native vector stack or a live database; `make checkup` runs every one of them. See [dev-environment.md](docs/dev-environment.md#invariants).

## Working in Docker

`make` on its own prints every target. The common ones:

| Target | What it does |
|---|---|
| `make dev` | dev stack with HMR |
| `make up` / `down` | prod image locally / stop and remove |
| `make logs` / `ps` / `sh` | logs / status / a shell in the container |
| `make deps` / `deps-vector` | install dependencies without / with the native vector stack |
| `make test-coverage` | production build + full coverage, including native vector and permission tests, in an isolated unprivileged Docker stage |
| `make checkup` | every portable code gate: static checks, full containerized coverage/build, live Postgres, backup smoke, container-native e2e; visual is also compared when its external baselines are present |
| `make test-pg` | ephemeral Postgres + live meta-DB contracts/migrations |
| `make test-browser` | e2e in a pinned Playwright image with container-native JS dependencies; visual too when external baselines are installed |
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
- **`#N` refers to the project's internal issue tracker**, which is not public. The issues themselves are not the canon: the reasoning that survived them lives in `docs/`, and the numbers are kept as provenance for people who do have access.

## Pull requests

Work on a branch, keep the checks above green, and describe *why* in the pull request rather than restating the diff. Small, focused changes get reviewed faster than large ones.

> ⚠️ **Before a first external contribution:** a Contributor License Agreement is required, because Notarium is dual-licensed (AGPL-3.0 plus a commercial license) and offering a commercial license requires the rights to all first-party code. The CLA process is being set up — please open an issue or write to commercial@notarium.ai before submitting a substantial contribution.

## Security

Do not report a vulnerability through a pull request or a public issue — the fix would
be public before anyone could deploy it. [SECURITY.md](SECURITY.md) has the private
channel, the scope, and the disclosure expectations.

## License

By contributing you agree that your contributions are licensed under [AGPL-3.0-only](LICENSE), subject to the CLA note above. See [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md) for the dual-licensing model.
