# Architecture

The only Cargo workspace root is `apps/api/Cargo.toml`. Its 14 explicit members
use edition 2024 and Rust 1.99.1, with unsafe code denied in first-party crates.
The default member is `notarium-bin`; its default binary is `notariumd`.
`notariumd` and `notarium-sidecar` use `mimalloc::MiMalloc`.

The target backend separates control, canonical and rebuildable derived state.
Local delivery uses independent SQLite files without `ATTACH DATABASE`: control
data, canonical data with a batch writer and Zstd CAS, and derived generations
published through ArcSwap. Cloud delivery targets PostgreSQL 16 and S3. Search
targets pure Rust i8 mmap CSR-HNSW with `std::arch` SIMD. ONNX is loaded dynamically
through `ort`, never downloaded during offline builds. These are boundaries for
upcoming work, not implemented storage or search behavior in this scaffold.

## Internal dependency allowlist

Every name except `fitness-gates` has the prefix `notarium-`. Allowed edges are
an upper bound; they do not imply implemented integrations.

| Crate | Allowed internal dependencies |
| --- | --- |
| core | none |
| syntax | core |
| control | core |
| canonical | core, syntax |
| projections | core, syntax, canonical |
| search | core, syntax, canonical |
| collab | core, syntax, canonical |
| vault | core, syntax, canonical |
| jobs | core, syntax, canonical, control |
| agents | core, syntax, control |
| http | core, control, agents, collab, vault |
| bin | core, syntax, control, canonical, projections, search, collab, jobs, vault, agents, http |
| migrate | core, syntax, canonical, control |
| fitness-gates | core, syntax, control, canonical, projections, search, collab, jobs, vault, agents, http |

No crate imports `notarium-bin`, `notarium-migrate` or `fitness-gates`. Fitness
tests invoke compiled binaries as external processes. HTTP cannot directly import
canonical/projections/search/jobs. Agents cannot directly depend on `tantivy`,
`ort` or `yrs`. Core has no internal dependencies or I/O behavior.

Native tests inspect `cargo metadata --no-deps` using package identities and paths,
including aliases, development/build dependencies, optional and target-specific
declarations. All workspace dependencies must be inherited by an owning crate and
locked for offline setup. `Cargo.lock` must contain none of `openssl-sys`,
`native-tls`, `aws-lc-sys`, `cmake`, `cxx`, `usearch` or `tikv-jemalloc-sys`.

TLS uses rustls 0.23 with ring, reqwest 0.13 with `rustls-no-provider`, and tonic
0.14 with `tls-ring`. Dependencies build in the pinned Rust image without adding
C++/OpenSSL tools. Per-crate scaffold tests are compile smoke checks, not domain
certification.

## Client and delivery boundaries

`notarium-http` owns code-first OpenAPI 3.1 declarations, emitted into
`packages/api-contract`. Starter TypeScript interfaces are consumed through that
package. Product SDK generation and transport APIs come later.

The shared React client has no Electron privileges. Main/preload/renderer belong
to one desktop app, which packages the Rust sidecar as an external resource.
The target desktop separates user Markdown files from private SQLite/CAS/index
data. Its protected sidecar lifecycle is not implemented yet.

The server container runs as UID/GID 1000 without Node and defaults to port 3000.
Dev Compose uses port 8080 behind the web proxy. `/health` and `/api/greeting`
are infrastructure/starter routes, not the product API.
