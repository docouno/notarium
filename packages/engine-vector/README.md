# @notarium/engine-vector

Deps-only carrier for the **optional embedder** (#200). Carries no code — like
`@notarium/desktop`, it exists to make an install decision expressible.

## Why this package exists

Vector/hybrid search (#81) needs a model to embed with, and that model is heavy:
`@huggingface/transformers` pulls CPU-only `onnxruntime-node` (~211 MB) +
`onnxruntime-web` (~130 MB), about ~360 MB in total. Since
every checkout owns its own `node_modules`, the cost repeats per active checkout even
when the work never touches embedding.

The runtime treats the embedder as an **optional capability with honest degradation**:
`@notarium/engine` loads `@huggingface/transformers` through a dynamic `import()` (a
`string`-typed specifier, so it isn't even resolved at typecheck), and the server's
composition root asks `localEmbedderAvailable()` before building one — absent, it says
so once and runs FTS-only. So the engine has **no static dependency** on this package.

What was missing was making the *install* skip it. npm has no per-package omit
(`--omit=optional` is too blunt — it also strips the platform-native binaries
esbuild/rollup/sharp/the eslint resolver need). The clean, deterministic lever npm
*does* have is **excluding a whole workspace**: put the declaration here, and the
default install leaves this one workspace out.

## What is deliberately NOT here: vec0

`sqlite-vec` (~200 KB) is an ordinary `@notarium/engine` dependency and installs in
**every** profile. It lived here until #317, and the cost was invisible: excluding the
carrier also excluded vec0, so the vector gate (`vectorGate.fixture.ts`) was closed on
every lean CI run and on every fresh checkout, and the 47 tests behind it — which
drive the real extension with a *mock* embedder and need no model at all — ran only on
the default branch. A write-path default flipped in #274 broke three of them and
reached `main` unnoticed. The excludable unit is the embedder; the 200 KB extension
costs nothing to always install, and `test/depsProfile.test.ts` now pins that split.

## How it's wired

- **Default dev install (`make deps`)** — `npm ci --include-workspace-root` with every
  workspace **except** `@notarium/engine-vector`. The embedder is never downloaded; the
  full toolchain (and its platform binaries), and vec0, still install.
- **Full install (`make deps-vector`)** and the **Docker image** — the canonical
  `deps:full` script installs every workspace including this one; npm hoists
  `@huggingface/transformers` to the **root** `node_modules`, where `@notarium/engine`
  resolves it at runtime. The same script sets `ONNXRUNTIME_NODE_INSTALL=skip`:
  Notarium has no GPU execution-provider path, so onnxruntime-node's default
  postinstall download of ~302 MB CUDA/TensorRT binaries would be dead weight and an
  unnecessary dependency on a NuGet CDN.

Nothing imports `@notarium/engine-vector`; the engine loads the carried package
directly. Keep this manifest and the engine's dynamic-load seam in sync when the
embedder's versions change.
