# Notarium

Notarium is a knowledge workspace for people and AI agents. Version 1.0 is being
built from scratch on `v1` with a Rust backend, React web client and Electron
desktop client. The `main` branch remains the released v0 showcase.

This branch contains the development foundation, pure domain contracts,
byte-preserving document syntax, control storage and transport-independent account
authentication, Space access, OAuth issuance, OIDC identity and provider services.
Canonical storage, search, collaboration, agents and the
product UI arrive in subsequent waves. The greeting screen and its API are
starter examples, not a production application.

## Start developing

Use Linux x86_64, local Docker Engine, Docker Compose **5.0.0+**, Git and GNU Make.
Host Node **24.22.1** is optional for npm CLI entry points. Development tools run
in pinned containers; no private services or additional agent tooling are needed.

```sh
git clone --branch v1 git@github.com:docouno/notarium.git
cd notarium
make setup
make doctor
make check
make test
make build
```

Setup downloads images and dependencies and needs networking. Later gates use
`--network none`, read-only sources and writable cache/output mounts. The accepted
environment is `@docouno/devkit@0.4.1`, Rust 1.99.1 (edition 2024), Node 24.22.1,
React 19.3.1 and Electron 45.0.0. Optional CLI host diagnostics:
`npx --yes @docouno/devkit@0.4.1 doctor .`.

```sh
make up app=web
make status
# Open the reported web URL and request a starter API greeting.
make down
```

Host ports are ephemeral and bound to loopback. Compose sets `PORT=8080` on the
API for the web proxy; the standalone daemon defaults to `PORT=3000`.

## Workspace

| Path | Responsibility |
| --- | --- |
| `apps/api` | Cargo workspace: 12 runtime crates, offline migrator and fitness gates |
| `packages/api-contract` | `@notarium/package-api-contract`: TypeScript starter contract and OpenAPI 3.1 |
| `packages/client` | `@notarium/package-client`: shared starter React UI and portable interfaces |
| `apps/web` | `@notarium/app-web`: browser entry point and HTTP adapter |
| `apps/desktop` | `@notarium/app-desktop`: Electron main/preload/renderer and platform adapters |
| `docker/Dockerfile` | Rust-only, non-root server image |

Four npm components use local `file:` dependencies. Web and desktop consume the
client library; all three consume api-contract. Each app owns its lifecycle.

The backend targets separate control, canonical and rebuildable derived storage.
HTTP and agents consume core ports instead of directly importing engine storage
or search. Native tests enforce the [crate matrix](docs/architecture.md).
See [development commands and ownership](docs/development.md) for details.
The implemented library boundaries are documented in [core contracts](docs/core-contracts.md)
and [document syntax](docs/syntax.md).
See [control storage](docs/control.md) for the implemented primitives and their
current integration limits.

## Contract and delivery

```sh
make contract-sync
make package-desktop
docker build -f docker/Dockerfile -t notarium:local .
docker run --rm -p 127.0.0.1:3000:3000 notarium:local
```

The contract comes from actual `notarium-http` declarations; a test detects drift
in `packages/api-contract/openapi.v1.json`. Desktop packaging builds Rust first
and includes the executable sidecar outside `app.asar`. Sidecar startup/security
and migration remain scaffolds: their binaries only support `--help` and reject
normal operation. The server image runs as UID 1000 without a Node runtime.

## License

Notarium is available under [AGPL-3.0-only](LICENSE) or a commercial license.
Vendored development tooling retains its own licenses and notices.
