# Architecture

The only Cargo workspace root is `apps/api/Cargo.toml`. Its 14 explicit members
use edition 2024 and Rust 1.99.1, with unsafe code denied in first-party crates.
The default member is `notarium-bin`; its default binary is `notariumd`.
`notariumd` and `notarium-sidecar` use `mimalloc::MiMalloc`.

The backend separates control, canonical and rebuildable derived state. Local
delivery uses independent SQLite files without `ATTACH DATABASE`: control data,
canonical data with a batch writer and Zstd CAS, and derived generations
published through ArcSwap. Cloud delivery pairs PostgreSQL 16 with S3-compatible
CAS. Search combines Tantivy with a pure Rust i8 mmap CSR-HNSW index and
`std::arch` SIMD. The optional ONNX backend loads the CPU runtime dynamically
through `ort`. Offline builds use cached dependencies.

The core, syntax, canonical and control libraries implement [domain contracts](core-contracts.md),
[document syntax](syntax.md) and [control-plane services](control.md), including
authority/egress checks, typed ports, history-scoped receipts, exact comparisons,
byte-preserving edits, SQLite/PostgreSQL control storage, authentication, OAuth/OIDC,
the native keyring, guarded outbound HTTP, the AI provider gateway and the
[control backup participant](control-backup.md). [Canonical storage](storage.md) provides SQLite and PostgreSQL persistence, CAS,
chat history and a backup participant. The [search engine](search.md) subscribes
to canonical changes independently and consumes the structural projection port.
Application composition provides the projection and embedding adapters. The
current HTTP and MCP transport work remains separate.

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
`ort` or `yrs`. Core has no internal dependencies or I/O behavior. A separate
native gate rejects parser, storage and runtime dependencies in core, including
renamed, optional, target, development and build declarations. Core, syntax and canonical all use `forbid(unsafe_code)` so inner modules cannot
override the workspace rule.

Native tests inspect `cargo metadata --no-deps` using package identities and paths,
including aliases, development/build dependencies, optional and target-specific
declarations. All workspace dependencies must be inherited by an owning crate and
locked for offline setup. `Cargo.lock` must contain none of `openssl-sys`,
`native-tls`, `aws-lc-sys`, `cmake`, `cxx`, `usearch` or `tikv-jemalloc-sys`.

TLS uses rustls 0.23 with ring, reqwest 0.13 with `rustls-no-provider`, and tonic
0.14 with `tls-ring`. Dependencies build in the pinned Rust image without adding
C++/OpenSSL tools. Core/syntax tests exercise domain and document behavior;
Canonical tests exercise dual-dialect storage and CAS. Control storage tests its SQL schema, target import/export, authentication,
Space authority and crash recovery. Search tests exercise lexical analysis, pure-Rust CSR-HNSW and SIMD kernels (with `unsafe` quarantined to `src/vector/mmap_segment.rs` and `src/vector/simd.rs`), pure-Rust tokenizers and dynamic ONNX loading, dual-dialect causal alignment and physical erasure, plus an offline 100k/400k scale gate. Remaining per-crate scaffold tests are compile
smoke checks.

`notarium-control` owns a 45-table baseline in SQLite and the PostgreSQL
`v1_control` schema. Its typed target records support offline import and paged
export from a retained read snapshot. `ControlService` implements `AuthPort` and
Space membership/lifecycle operations with durable revocation and canonical
coordination. Its native keyring and guarded HTTP transport provide credential
storage and bounded network primitives. `OAuthService` implements the local
authorization server, and `OidcService` verifies external identity and issues
native sessions through explicit account bindings. `ProviderService` implements
encrypted provider configuration, current disclosure admission, bounded completion
and embedding calls, and durable spending reservations. `ControlPlane` composes that provider with
its matching account-state service. Episodes, reference contexts, ability overlays,
schedule claims and content-free telemetry are implemented without a tool loop
or ticker. `ControlBackup` implements the control participant's writer fence,
pinned snapshots, stable artifacts and cursor rebinding. A paired canonical/control
backup and archive coordinator remains a separate integration. See
[control services](control.md).

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
