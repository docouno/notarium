# Development

Use Linux x86_64, a local Docker Engine, Docker Compose **5.0.0+**, Git and GNU
Make. Devkit 0.4.1 pins the container toolchains. Host Node/Rust SDKs do not replace
them. Optional npm CLI entry points need Node 24.22.1 on the host.

`make setup` downloads images and caches dependencies and requires networking.
Subsequent check/test/build commands use `--network none`, read-only sources,
manifests and lockfiles, with writable declared cache/output paths.

| Command | Purpose |
| --- | --- |
| `make doctor` | Check the checkout and prepared images |
| `npx --yes @docouno/devkit@0.4.1 doctor .` | Diagnose host, Docker and quotas |
| `make setup` | Prepare all five components |
| `make check` | Formatting, lint and types, including all Cargo targets |
| `make test` | All component tests, architecture rules and process smoke tests |
| `make build` | Build all components offline |
| `make check app=api` | Select the Rust app |
| `make test package=api-contract` | Select the contract library |
| `make contract-sync` | Regenerate OpenAPI from Rust |
| `make package-desktop` | Build Rust and package Electron with the sidecar |
| `make up app=web` | Start web and API on ephemeral loopback ports |
| `make up app=desktop headless=1` | Start desktop in the headless environment |
| `make status` / `make logs` | Inspect this checkout's services |
| `make down` | Stop this checkout's services |

Use `make test` for process tests: its `test-api: build-api` prerequisite creates
standalone binaries without forbidden Cargo edges. Use `make help` for selectors.

## Dependencies and ownership

`.devkit/manifest.json`, generated projections and `.devkit/runtime/` are managed.
Never edit them or their hashes manually. The root Makefile, Compose overrides,
sources and ecosystem manifests are product-owned. There is no root Cargo.toml.
Declare external Rust dependencies in `[workspace.dependencies]` and inherit
them through `{ workspace = true }` in owning crates so setup fetches them.

Change dependencies through the pinned container, then reconcile and set up:

```sh
sh .devkit/runtime/devkit.sh cli exec --component apps/api --write --network bridge -- cargo update
make sync reconcile=1
make setup
```

For npm changes, use the same interface with the owning component and an npm
command. Local `file:` dependencies connect web/desktop to client and all three
to api-contract. Every component has independent checks and builds. Unpublished
design-system packages are not dependencies of this scaffold.

`contract-sync` emits into `.artifacts/contract-sync` before atomically replacing
`packages/api-contract/openapi.v1.json` after successful generation. Its producer
runs offline with read-only sources. Check the generated JSON with `make check`;
contract tests detect structural drift.

## Branches and evidence

Keep released v0 `main` frozen; base new branches on `v1`. With Worktrunk, use
`wt switch -c <branch> -b v1`. The initial v1 root is an orphan commit without v0
implementation. Use `umask 022` so container mounts can read new source files.
Keep temporary evidence in ignored `.artifacts/<task>/`, respect real cgroup
quotas and run heavy checks sequentially. Stop only this checkout's services.

## Core and syntax gates

`make test` includes the domain, authorization, receipt, port-protocol and document
tests. `generated_documents` enforces a floor of 10,000 successful generated
documents across seventeen scenario families, even when `PROPTEST_CASES=1`. It reports
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
`PORT` explicitly to change its listener. Compose sets `PORT=8080` for the proxy.

Desktop output lives in `apps/desktop/release/`. The executable
`resources/notarium-sidecar` sits beside `app.asar`. It does not yet implement
the protected desktop service. Both sidecar and migrator support only `--help`
and exit 2 for normal invocation. The starter desktop connects to the development
API through its platform bridge.
