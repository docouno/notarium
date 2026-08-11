import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// Build identity of this SPA bundle, inlined via `define` and read by
// src/libs/buildInfo.ts. Shown on the About settings tab next to the server's own
// build — a mismatch means a stale cached bundle is talking to a newer server.
// version is the lockstep root version; commit from the GIT_SHA build-arg (Docker)
// or git at build; builtAt is now.
const rootPkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
)
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

// Dev: Vite serves the SPA and proxies API calls to the Fastify backend (which
// runs the knowledge engine in-process). The app answers on 3000 in EVERY mode —
// production (one process) and dev alike — so the backend steps aside to 3001
// behind the proxy rather than the other way round; `API_PORT`/`API_TARGET`
// move it if 3001 is taken. Port and proxy target stay env-overridable so the
// same config serves host `npm run dev` and the in-container dev mode (Vite on
// the published port, API on an internal one — see compose.dev.yml).
// Hostnames allowed to reach the dev server. Vite 5 rejects non-local Host
// headers by default (a DNS-rebinding guard), which also breaks access through
// an HTTPS dev tunnel. Unset keeps that safe default — localhost and IPs only.
// Reaching the dev server by any other name needs ALLOWED_HOSTS=host1,host2
// (a leading-dot entry whitelists a domain and all its subdomains), or "all".
const allowedHosts = (() => {
  const raw = process.env.ALLOWED_HOSTS
  if (!raw) return undefined
  if (raw.trim() === 'all') return true
  return raw.split(',').map((s) => s.trim()).filter(Boolean)
})()

// When the dev server is reached through an HTTPS tunnel, the page loads on :443
// but Vite listens on a different internal port, so the HMR client must open its
// websocket on :443 instead of the server port — otherwise live reload silently
// fails to connect.
// Set HMR_CLIENT_PORT=443 for tunnel access; leave unset for plain localhost.
const hmrClientPort = process.env.HMR_CLIENT_PORT
  ? Number(process.env.HMR_CLIENT_PORT)
  : undefined

// PWA: installable app shell + static precache. DELIBERATELY shell-only —
// /api is never cached (privacy: single-user/no-auth today; offline DATA is its
// own story, after auth) and /mcp/SSE must never be intercepted. So:
//   - generateSW precaches the build assets + icons only. The ONE runtimeCaching
//     rule is for reading-view web fonts: they are excluded from precache
//     (globIgnores) and load lazily — only the active preset's subset is ever
//     fetched — so a CacheFirst rule on /fonts/*.woff2 caches each as it's used,
//     keeping the app offline-capable without forcing all ~12 files onto every
//     install. Scoped to fonts; it cannot match /api (data stays network-only).
//   - navigateFallbackDenylist keeps /api and /mcp on the network — a hard nav
//     or download (e.g. the ZIP export) must hit the server, never the cached
//     index.html.
//   - registerType 'prompt': a new SW waits; the app shows a "reload to update"
//     toast and only then activates it (src/composers/PwaProvider). No silent
//     reload mid-edit.
// Registration is done in React (virtual:pwa-register/react) so the update prompt
// can use the app's toast system — hence injectRegister:false.
// VITE_PWA=off disables the whole plugin (manifest + SW + virtual module stub):
// the test build sets it so e2e/visual stay deterministic and SW-free; the SW is
// verified live against a production build instead.
const pwaDisabled = process.env.VITE_PWA === 'off'

// Workbox's per-file precache wall, at Workbox's own default value rather than a choice
// of ours — it is spelled out only because the size contract is anchored to it.
// canon: docs/pwa.md#bundle-size
const PRECACHE_MAX_FILE_BYTES = 2 * 1024 * 1024

// Synchronous heavyweight vendor families, split out of the application entry. A name is
// matched exactly unless it ends in `-`, which matches a package-name prefix.
// canon: docs/pwa.md#bundle-size
const CHUNK_FAMILIES = {
  editor: [
    'codemirror',
    '@codemirror/autocomplete',
    '@codemirror/commands',
    '@codemirror/lang-css',
    '@codemirror/lang-html',
    '@codemirror/lang-javascript',
    '@codemirror/lang-markdown',
    '@codemirror/language',
    '@codemirror/language-data',
    '@codemirror/search',
    '@codemirror/state',
    '@codemirror/view',
    '@lezer/common',
    '@lezer/css',
    '@lezer/highlight',
    '@lezer/html',
    '@lezer/javascript',
    '@lezer/lr',
    '@lezer/markdown',
  ],
  'markdown-math': ['katex'],
  'syntax-highlighting': ['highlight.js'],
  graph: [
    'bezier-js',
    'd3-array',
    'd3-drag',
    'd3-force-3d',
    'd3-scale',
    'd3-scale-chromatic',
    'd3-selection',
    'd3-zoom',
    'force-graph',
    'graphology',
    'graphology-',
    'kapsule',
    'react-force-graph-2d',
    'react-kapsule',
    'tinycolor2',
  ],
}

// The LAST `node_modules/` wins, so a nested copy (`a/node_modules/b`) counts as b.
// Rollup hands ids in host form, hence the separator normalisation.
const packageOf = (moduleId) => {
  const id = moduleId.replace(/\\/g, '/')
  const at = id.lastIndexOf('/node_modules/')

  if (at === -1) {
    return null
  }
  const [scope, scoped] = id.slice(at + '/node_modules/'.length).split('/')

  return scope.startsWith('@') ? `${scope}/${scoped}` : scope
}

const manualChunks = (moduleId) => {
  const pkg = packageOf(moduleId)

  return pkg
    ? Object.keys(CHUNK_FAMILIES).find((chunk) =>
        CHUNK_FAMILIES[chunk].some((name) =>
          name.endsWith('-') ? pkg.startsWith(name) : pkg === name,
        ),
      )
    : undefined
}

export default defineConfig({
  // In Docker dev, packages/web is bind-mounted as a writable directory so Vite can
  // emit its temporary bundled config next to vite.config.js. Keep the optimizer cache
  // relocatable so the container does not need package-local node_modules from host.
  cacheDir: process.env.VITE_CACHE_DIR || 'node_modules/.vite',
  plugins: [
    react(),
    VitePWA({
      disable: pwaDisabled,
      registerType: 'prompt',
      injectRegister: false,
      // Icons are pre-generated and committed (public/, see pwa-assets.config.ts),
      // so the production build never needs sharp. includeAssets pulls the ones
      // not caught by globPatterns into precache; they live under public/.
      includeAssets: ['favicon.ico', 'favicon.svg', 'apple-touch-icon-180x180.png'],
      manifest: {
        name: 'Notarium',
        short_name: 'Notarium',
        description: 'Self-hosted, AI-agent-native knowledge base.',
        lang: 'en',
        display: 'standalone',
        // Stable app identity, decoupled from start_url: if start_url ever gains a
        // path/query, browsers keyed on the default id (=start_url) would treat it
        // as a different app and double-install instead of updating.
        id: '/',
        start_url: '/',
        scope: '/',
        orientation: 'any',
        // Static splash/title-bar colours for first paint, tuned to the default
        // (dark) theme; the live <meta name="theme-color"> follows the chosen
        // theme at runtime (ChromeProvider). Keep in sync with tokens.scss --bg.
        theme_color: '#151517',
        background_color: '#151517',
        icons: [
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: 'maskable-icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        maximumFileSizeToCacheInBytes: PRECACHE_MAX_FILE_BYTES,
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff,woff2}'],
        // Reading-view fonts load on demand (only the chosen preset's subset
        // is fetched), so they must NOT be swept into the install-time precache —
        // that would download every vendored file up front and defeat the laziness.
        // The runtimeCaching rule below caches each one the first time it's used.
        // This bucket also holds the ALWAYS-ON fonts (Inter for the UI, JetBrains
        // Mono for code/the editor), so maxEntries must comfortably exceed those
        // plus an active reading preset's subsets — 64 (vs ~13 families × subsets)
        // keeps the core + a couple of explored presets resident so they survive
        // offline, while still bounding the cache. LRU evicts only stale extras.
        //
        // KaTeX math fonts follow the SAME laziness rule but live elsewhere:
        // `import 'katex/dist/katex.min.css'` makes Vite emit its ~19 web fonts as
        // build assets under `assets/KaTeX_*-<hash>.woff2` (NOT `/fonts/`), so the
        // `**/fonts/**` ignore misses them and the woff/woff2 glob would precache all
        // ~0.5 MB on every install — even though only a minority of notes have math,
        // and the browser only ever pulls the specific glyph subsets a formula uses.
        // Exclude them from precache and cache each on first use, exactly like the
        // reading fonts. (A tiny KaTeX woff2 that Vite base64-inlines into the CSS
        // rides along with the stylesheet — unavoidable and negligible.)
        globIgnores: ['**/fonts/**', '**/assets/KaTeX_*.woff', '**/assets/KaTeX_*.woff2'],
        runtimeCaching: [
          {
            urlPattern: /\/fonts\/[^/]+\.woff2$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'reading-fonts',
              expiration: { maxEntries: 64, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: /\/assets\/KaTeX_[^/]+\.woff2?$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'katex-fonts',
              // KaTeX ships ~19 families × {woff2,woff}; 48 keeps a math-heavy note's
              // full set resident offline while bounding the cache. LRU evicts extras.
              expiration: { maxEntries: 48, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
        navigateFallback: '/index.html',
        // Server-owned surfaces stay on the network — never answered from the
        // precached shell. /api carries all data (SSE included); /mcp is the agent
        // gateway; /oauth and /.well-known are the server-rendered OAuth facade
        // — the consent page at /oauth/authorize is a REAL top-level
        // navigation, so without denying it the SW hijacks the flow with the SPA
        // shell and the app 404s the whole connector authorize step. The `(\/|$)`
        // boundary also denies the bare path (not just `/…/`), matching the
        // server's own SPA-fallback guard. Everything else falls back to the SPA
        // shell offline.
        navigateFallbackDenylist: [
          /^\/api(\/|$)/,
          /^\/mcp(\/|$)/,
          /^\/oauth(\/|$)/,
          /^\/\.well-known(\/|$)/,
        ],
        cleanupOutdatedCaches: true,
      },
      // No service worker under `make dev`: a dev SW intercepts navigations and
      // persists across restarts, which masks HMR and serves a stale shell — and
      // its precache is a no-op in dev anyway (no hashed assets). The install/
      // update UX is covered by e2e (synthetic event) and verified live against a
      // production build (`make up`); dev stays SW-free.
      devOptions: { enabled: false },
    }),
  ],
  define: {
    // VERSION is what the ARTIFACT calls itself — passed by the release
    // entrypoint, `X.Y.Z-rc.<sha>` for a pre-release — so the SPA and the server
    // agree. Empty outside a release build, where the manifests are the answer.
    __APP_VERSION__: JSON.stringify(process.env.VERSION || rootPkg.version),
    __GIT_SHA__: JSON.stringify(gitSha),
    __BUILD_TIME__: JSON.stringify(builtAt),
  },
  // CSS Modules (*.module.scss): keep BOTH the original kebab key and a camelCase
  // alias, so static access reads as `styles.feedCard` while dynamically-built
  // class names (e.g. `styles[`feed-grid-c${cols}`]`) still resolve.
  css: {
    modules: { localsConvention: 'camelCase' },
  },
  server: {
    host: true, // listen on 0.0.0.0 so the dev server is reachable from outside a container
    port: Number(process.env.VITE_PORT || 3000),
    allowedHosts,
    hmr: hmrClientPort ? { clientPort: hmrClientPort } : undefined,
    proxy: {
      '/api': {
        target: process.env.API_TARGET || `http://localhost:${process.env.API_PORT || 3001}`,
        changeOrigin: true,
      },
      // The MCP gateway shares the API target so an agent can hit
      // `POST <dev-host>/mcp` in dev too — without this only `/api` is proxied
      // and `/mcp` falls through to Vite's own 404.
      '/mcp': {
        target: process.env.API_TARGET || `http://localhost:${process.env.API_PORT || 3001}`,
        changeOrigin: true,
      },
      // The OAuth connector facade lives on the backend too: discovery
      // (`/.well-known/oauth-*`) + the flow (`/oauth/*`). Without proxying them a
      // dev/tunnel host serves the SPA index for these and claude.ai's connector
      // discovery breaks. The issuer derives from the tunnel's X-Forwarded-*
      // headers, so no PUBLIC_BASE_URL is needed in this path.
      // Scoped to the OAuth discovery paths (not the whole /.well-known namespace,
      // which other consumers — security.txt, assetlinks — may claim).
      '/.well-known/oauth-protected-resource': {
        target: process.env.API_TARGET || `http://localhost:${process.env.API_PORT || 3001}`,
        changeOrigin: true,
      },
      '/.well-known/oauth-authorization-server': {
        target: process.env.API_TARGET || `http://localhost:${process.env.API_PORT || 3001}`,
        changeOrigin: true,
      },
      '/oauth': {
        target: process.env.API_TARGET || `http://localhost:${process.env.API_PORT || 3001}`,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    rollupOptions: {
      output: { manualChunks },
    },
  },
})
