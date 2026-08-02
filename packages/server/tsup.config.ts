import { execSync } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs'

import { defineConfig } from 'tsup'

// Build identity, inlined as string literals so the runtime never reads
// package.json or runs git: version is the lockstep root version; commit comes
// from the GIT_SHA build-arg (Docker) or git at build; builtAt is now; SOURCE_URL
// is the exact-revision source link a RELEASE build passes in (empty otherwise —
// there is nothing honest to point at). These surface on /api/about and
// `notarium version`. See packages/server/src/libs/buildInfo.
const rootPkg = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { version: string }
const gitSha =
  process.env.GIT_SHA ||
  (() => {
    try {
      return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .trim()
    } catch {
      return ''
    }
  })()
const builtAt = process.env.BUILD_TIME || new Date().toISOString()

// Bundle the host into dist/main.js. Workspace packages (@notarium/*) export
// raw TS sources, so they MUST be inlined here — the production runtime has no
// TS loader. Real npm deps (fastify, zod, …) stay external and come from the
// production node_modules.
export default defineConfig({
  // The server host AND the operator CLIs ship in the production
  // image. Recovery must work where neither tsx nor the TS sources exist.
  // The admin recovery tool must ship in the production image too
  // (`docker compose exec notarium admin …`),
  // or a lost admin password is unrecoverable exactly where it matters most:
  // the dockerized deploy has neither tsx nor the TS sources.
  // The embed-pool worker is its OWN entry → dist/embedWorker.js, a sibling of
  // dist/main.js. createEmbedPool resolves it by location (new URL('./embedWorker.js',
  // import.meta.url)) so the same code path serves the bundled runtime and the tsx
  // dev/test run (where it loads the .ts). The engine is inlined into it (noExternal);
  // @huggingface/transformers stays external, loaded from the runtime node_modules.
  entry: {
    main: 'src/apps/server/main.ts',
    admin: 'src/apps/server/commands/admin/main.ts',
    backup: 'src/apps/server/commands/backup/main.ts',
    restore: 'src/apps/server/commands/restore/main.ts',
    version: 'src/apps/server/commands/version/main.ts',
    embedWorker: '../engine/src/libs/embedding/embedWorker.ts',
  },
  // Inline build identity — buildInfo.ts reads these, falling back to
  // package.json/git only when absent (the unbundled dev run).
  define: {
    // VERSION is what the ARTIFACT calls itself. The release entrypoint always
    // passes it: equal to the manifests' version for a real release, `X.Y.Z-rc.<sha>`
    // for a pre-release. It is empty only for a plain `docker build` or a host
    // `npm run build`, which fall back to the manifests.
    'process.env.NOTARIUM_VERSION': JSON.stringify(process.env.VERSION || rootPkg.version),
    'process.env.NOTARIUM_GIT_SHA': JSON.stringify(gitSha),
    'process.env.NOTARIUM_BUILD_TIME': JSON.stringify(builtAt),
    'process.env.NOTARIUM_SOURCE_URL': JSON.stringify(process.env.SOURCE_URL || ''),
  },
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  noExternal: [/^@notarium\//],
  esbuildPlugins: [
    {
      name: 'copy-meta-db-migrations',
      setup(build) {
        build.onEnd(({ errors }) => {
          if (errors.length) {
            return
          }

          const source = new URL('./src/services/metaDb/migrations/', import.meta.url)
          const destination = new URL('./dist/metaDb-migrations/', import.meta.url)
          rmSync(destination, { recursive: true, force: true })
          mkdirSync(destination, { recursive: true })
          cpSync(new URL('manifest.json', source), new URL('manifest.json', destination))
          cpSync(new URL('sqlite/', source), new URL('sqlite/', destination), { recursive: true })
          cpSync(new URL('postgres/', source), new URL('postgres/', destination), {
            recursive: true,
          })
        })
      },
    },
  ],
  // Native ML deps MUST load from the production node_modules, never the bundle.
  // As shipped, @notarium/engine (inlined above) reaches them ONLY through a
  // variable-specifier dynamic import (`import(TRANSFORMERS_MODULE)`) + a runtime
  // `createRequire('sqlite-vec')` — neither of which esbuild resolves or code-splits
  // — so this `external` list is belt-and-suspenders: it documents the runtime deps
  // and guards a future revert to a LITERAL `import('@huggingface/transformers')`,
  // which esbuild WOULD resolve and try to code-split. Why a split is dangerous:
  // onnxruntime's backend registry (onnxruntime-common) is a SINGLETON the native
  // addon registers into at load; splitting that registry from the addon drops
  // `listSupportedBackends`, so every embed warmup throws and the vector channel
  // silently degrades to FTS. The deps come from the @notarium/engine-vector carrier
  // workspace (npm ci), npm-hoisted to the root node_modules, resolved at runtime
  // only with VECTOR_SEARCH=on inside the bundled container.
  external: ['@huggingface/transformers', 'onnxruntime-node', 'onnxruntime-common'],
  // tsup strips the `node:` protocol off builtin imports by default, and
  // `node:sqlite` (node 22.5+) only exists WITH the protocol — the stripped
  // bare "sqlite" import crashes the production bundle at startup.
  removeNodeProtocol: false,
  clean: true,
  sourcemap: true,
})
