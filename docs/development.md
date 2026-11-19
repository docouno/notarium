# Development

Use Linux x86_64, a local Docker Engine, Docker Compose **5.0.0+**, Git and GNU
Make. Devkit `0.5.1` pins the container toolchains (`Rust 1.99.1`, `Node 24.22.1`,
static `pnpm 12.21.0`). Host Node/Rust SDKs do not replace them; host Node is only
needed for optional `npx` CLI entry points.

`make setup` downloads images and caches dependencies — including the pinned
`pnpm 12.21.0` binary, shared caches under `DEVKIT_CACHE_DIR` (default
`~/.cache/docouno/devkit`, with hardlinked `pnpm-store` and reusable derived
container images), the digest-pinned PostgreSQL 16 image, the source-built
MinIO Community storage test fixture (`compose.storage-tests.yaml`), and the
SHA-256-pinned ONNX Runtime 1.31 CPU test library (using host `curl`, `unzip`
and `sha256sum`) — and requires networking. Subsequent check/test/build commands
use `--network none`, read-only sources, manifests, lockfiles and
`node_modules/.pnpm`, with writable declared cache/output paths. `make test`
automatically launches and tears down isolated Unix-domain-socket PostgreSQL 16
and MinIO Community fixtures for `apps/api` without network access; integration
tests fail closed if fixtures are absent (see [canonical storage](storage.md)).

| Command | Purpose |
| --- | --- |
| `sh .devkit/runtime/devkit.sh cli doctor .` | Lock-free preflight of host, Docker, Compose, cgroups and checkout (before `make setup`) |
| `make setup` | Prepare all five components, pinned `pnpm`, derived images and API fixtures |
| `make doctor` | Verify prepared images, locks and checkout readiness (after `make setup`) |
| `make info` / `make info json=1` | Inspect checkout readiness, sticky port leases and observed services (`make status` is a quiet alias) |
| `make check` | Formatting, lint and types, including all Cargo targets |
| `make fix` | Apply Prettier, ESLint `--fix` and `rustfmt` explicitly |
| `make test` | All component tests, architecture rules and process smoke tests |
| `make build` | Build all components offline |
| `make check app=api` | Select the Rust app |
| `make test package=api-contract` | Select the contract library |
| `make exec command='...'` | Run a command inside a pinned container (`app=`, `package=`, `component=`, `write=1`, `network=bridge`) |
| `make sync` | Reconcile projections and locks (`preview=1`, `reconcile=1`) |
| `make update to=VERSION` | Update accepted Devkit release (`preview=1` to preview) |
| `make recover` | Recover from an interrupted Devkit update transaction |
| `make contract-sync` | Regenerate OpenAPI from Rust and format with `pnpm exec prettier` |
| `make package-desktop` | Build Rust and package Electron with the sidecar |
| `make up app=web` | Start web and connected API on sticky loopback ports |
| `make up app=desktop headless=1` | Start desktop in a headless environment |
| `make logs` | Inspect this checkout's service logs (`follow=1` streams) |
| `make down` | Stop this checkout's services while preserving sticky port leases |
| `make down cleanup=1` | Verify ownership, stop remnants and release sticky port leases (preserving volumes) |

Use `make test` for process tests: its `test-api: build-api` prerequisite creates
standalone binaries without forbidden Cargo edges. Use `make help` for selectors.

API setup also pulls a pinned PostgreSQL 16 fixture image. API tests start a
disposable database with `--network none`, no published ports and a shared Unix
socket. The pinned test container keeps read-only sources and accesses that
socket through `.artifacts/control-db-fixture/active.json`. Missing fixture
configuration fails the database suite. The project wrapper serializes fixture
runs within one checkout and removes its container and scratch directory on
clean exit; logs remain in `.artifacts/control-db-fixture/` when a run fails.
No host PostgreSQL installation is required.

## Dependencies and ownership

`.devkit/manifest.json`, generated projections (including `.devkit/runtime/api.env`
and `.devkit/runtime/pnpm.env`) and `.devkit/runtime/` are managed. Never edit them
or their hashes manually. The root Makefile, `compose.yaml`, `.config/wt.toml`,
sources and ecosystem manifests are product-owned. There is no root Cargo.toml.
Declare external Rust dependencies in `[workspace.dependencies]` and inherit
them through `{ workspace = true }` in owning crates so setup fetches them.

The four Node components share one root `pnpm` workspace (`pnpm-workspace.yaml` and
`pnpm-lock.yaml`, `nodeLinker: isolated`, `packageImportMethod: hardlink`). Internal
`workspace:*` dependencies connect web and desktop to client and all three to
api-contract. Every component has independent checks and builds. Unpublished
design-system packages are not dependencies of this scaffold.

Change dependencies through the pinned container with `make exec`, then run
`make setup` (and `make sync` after direct edits to `package.json`, `Cargo.toml`
or `.npmrc`):

```sh
# Node app or package (use -w at the workspace root when omitting app= / package=)
make exec app=web write=1 network=bridge command='pnpm add <pkg> --lockfile-only --ignore-scripts'
make setup

# Rust workspace
make exec app=api write=1 network=bridge command='cargo update'
make setup
```

`contract-sync` emits into `.artifacts/contract-sync` before formatting with
`pnpm exec prettier` and atomically replacing `packages/api-contract/openapi.v1.json`
after successful generation. Both producer and formatter run offline with read-only
sources. Check the generated JSON with `make check`; contract tests detect
structural drift.

## Development stands and preview URLs

Development services allocate checkout-owned sticky loopback host ports from
`DEVKIT_PORT_RANGE` (`10000-19999` by default), tracked in a shared lease registry
under `DEVKIT_CACHE_DIR`. Managed `.devkit/runtime/api.env` provides `HOST=0.0.0.0`
and `PORT=8080` in Compose so the web proxy targets `api:8080`, while standalone
`notariumd` continues to default to `PORT=3000`. Managed `depends_on` in
`.devkit/compose.apps.yaml` starts `api` automatically when running `make up app=web`
or `make dev app=web`. Aggregate `make up` / `make dev` without `DISPLAY` (and
`headless=0`) skips Electron with a warning; explicit `app=desktop` requires
`DISPLAY` or `headless=1`.

To expose stands through a reverse proxy, set `DEVKIT_PREVIEW_URL_TEMPLATE`
(for example `https://{port}-{branch}.example.test`) in the process environment or
the checkout's `.env`. To inherit a template from a named worktree once per clone,
run `git config --local devkit.previewSourceBranch <branch>` (an empty
`DEVKIT_PREVIEW_URL_TEMPLATE=` disables inheritance). `make info` reports applied
URLs, retained leases and whether changed preview settings require a restart.

`make down` stops this checkout's services while retaining its sticky leases and
volumes. `make down cleanup=1` verifies ownership and releases leases while
preserving volumes. On an existing checkout upgraded from Devkit `0.4.x` that
already has a `.devkit/state/` directory, run a one-time `make down` on `0.5.1`
before invoking cold `sh .devkit/runtime/devkit.sh cli stand reserve .`.

## Branches, worktrees and evidence

Keep released v0 `main` frozen; base new branches on `v1`. The initial `v1` root
is an orphan commit without v0 implementation. Nested worktrees under `/.worktrees/`
are ignored by Git and Docker.

The repository includes project-owned Worktrunk hooks in `.config/wt.toml`
(`pre-start` reserves sticky ports, opt-in `post-start` runs with
`DEVKIT_WT_AUTOSTART=1`, and `pre-remove` cleans up stand resources and leases):

```sh
# Interactive shell
wt switch -c <branch> -b v1
wt remove <branch>

# Non-interactive shells and automation (avoids hook-approval prompts)
wt switch -c <branch> -b v1 --yes
wt remove --foreground --yes <branch>
# Or pre-approve hooks once for the repository:
wt config approvals add --yes
```

When removing older `0.4.1` linked worktrees from a `0.5.1` checkout with
`.config/wt.toml`, either rebase them onto `v1` first or run `make down` inside the
old worktree and remove it with `wt remove --no-hooks <branch>`, because `0.4.1`'s
`.devkit/runtime/devkit.sh` does not implement `worktree-hook`.

Use `umask 022` so container mounts can read new source files. Keep temporary
evidence in ignored `.artifacts/<task>/`, respect real cgroup quotas and run heavy
checks sequentially. Stop only this checkout's services.

## Core and syntax gates

`make test` includes the domain, authorization, receipt, port-protocol and document
tests. `generated_documents` enforces a floor of 10,000 successful generated
documents across twenty-four scenario families, even when `PROPTEST_CASES=1`. It reports
the effective case count, RNG seed and family counts. Failures shrink and persist
replay seeds in the writable Cargo target directory. Fixed adversarial fixtures
remain in the source tree; the normal offline gate needs no external corpus.

For an isolated reproduction after setup:

```sh
sh .devkit/runtime/devkit.sh cli exec --component apps/api --network none -- \
  env PROPTEST_CASES=1 cargo test --locked --offline -p notarium-syntax --test generated_documents
```

Set `PROPTEST_RNG_SEED` to replay a reported seed or explore another deterministic
corpus; values above the case floor increase the run. Root `make check`, `make test`
and `make build` remain the integration gates. Contract doubles demonstrate typed
ownership and cleanup; they do not certify future runtime durability or latency.

## Delivery smoke checks

```sh
docker build -f docker/Dockerfile -t notarium:local .
docker run --rm -p 127.0.0.1:3000:3000 notarium:local
```

The server runs as UID 1000, defaults to `PORT=3000` and serves `/health`. Override
`PORT` explicitly to change its listener. Managed `.devkit/runtime/api.env` sets
`PORT=8080` for the Compose web proxy.

Desktop output lives in `apps/desktop/release/`. The executable
`resources/notarium-sidecar` sits beside `app.asar`. It does not yet implement
the protected desktop service. Both sidecar and migrator support only `--help`
and exit 2 for normal invocation. The starter desktop connects to the development
API through its platform bridge.
