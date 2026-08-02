# @notarium/engine-vector

Deps-only carrier for the **optional native vector stack** (#200). Carries no
code — like `@notarium/desktop`, it exists to make an install decision expressible.

## Why this package exists

Vector/hybrid search (#81) runs on a heavy native stack: `@huggingface/transformers`
pulls `onnxruntime-node` (~513 MB) + `onnxruntime-web` (~130 MB), and `sqlite-vec`
adds the `vec0` extension. That is ~660 MB — about 60 % of a checkout's
`node_modules` — and since every checkout owns its own `node_modules`, the cost
repeats per active checkout even when the work never touches vector search.

The runtime already treats vector as an **optional capability with honest
degradation**: `@notarium/engine` imports `@huggingface/transformers` through a
dynamic `import()` (a `string`-typed specifier, so it isn't even resolved at
typecheck) and `sqlite-vec` through a lazy `createRequire`; when they're absent
the store degrades to FTS (`createNotariumStore` → `capabilities.vector = false`).
So the engine has **no static dependency** on these packages.

What was missing was making the *install* skip them. npm has no per-package omit
(`--omit=optional` is too blunt — it also strips the platform-native binaries
esbuild/rollup/sharp/the eslint resolver need). The clean, deterministic lever npm
*does* have is **excluding a whole workspace**: put the declaration here, and the
default install leaves this one workspace out.

## How it's wired

- **Default dev install (`make deps`)** — `npm ci --include-workspace-root` with every
  workspace **except** `@notarium/engine-vector`. The vector subtree is never
  downloaded; the full toolchain (and its platform binaries) still installs.
- **Vector dev (`make deps-vector`)** and the **Docker image** — a plain `npm ci`
  installs every workspace including this one; npm hoists `@huggingface/transformers`
  and `sqlite-vec` to the **root** `node_modules`, where `@notarium/engine` resolves
  them at runtime.

Nothing imports `@notarium/engine-vector`; the engine imports the carried packages
directly. Keep this manifest and the engine's dynamic-load seam in sync when the
vector stack's versions change.
