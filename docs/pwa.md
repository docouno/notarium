# PWA: installable shell (#40)

Notarium installs as an app (a separate window, an icon on the home screen / in the launcher) and keeps an instant start thanks to static precache. The scope is **the shell only**: installability + a cache of static assets + an offline fallback of the shell itself. Offline **data** (reading/editing notes without a network, sync, conflicts) is NOT included here — that is #41, tied to our layer (#9/#12) and auth (#10); while the data is server-side, it is not cached in the SW.

## Tooling

`vite-plugin-pwa` (Workbox under the hood, `generateSW` mode). This is the only reliable way to precache Vite's content-hashed chunks: asset names are known only after the build, and the plugin generates the precache manifest from them. A manual SW would have to be fed a separate list of hashes. The config lives in `packages/web/vite.config.js`.

- `registerType: 'prompt'` — a new SW ALWAYS waits; the page never reloads under the user on its own. Only a "Reload" click activates it (see update-flow).
- `injectRegister: false` — we do the registration in React (`virtual:pwa-register/react`) so that the update prompt goes through the app's toast system rather than through a script embedded by the plugin.
- `disable: process.env.VITE_PWA === 'off'` — disables the plugin entirely (manifest + SW + the stub for the virtual module). The test build sets this flag (see below).

## Manifest

`display: standalone`, `start_url: '/'`, `scope: '/'` (the router redirects `/` into the active space, so the start URL is correct under multi-space too), an explicit `id: '/'` (the app identity is decoupled from `start_url` — if the latter gains a path/parameter, the browser will not take it for a different app and will not duplicate the installation). `theme_color`/`background_color` = `#151517` — a static first-frame color for the default dark theme; the live `<meta name="theme-color">` is overridden at runtime for the chosen theme (see below). `orientation: 'any'` — the app is desktop+mobile, we do not force orientation. The iOS meta tags set `apple-mobile-web-app-status-bar-style: black` (NOT `black-translucent`): translucent places content UNDER the status bar and requires `env(safe-area-inset)` padding, which the shell does not have yet — edge-to-edge is a responsive pass (#26), whereas `black` keeps standalone without overlap.

## Icons

The full set is committed under `packages/web/public/` and is generated from a single source `public/favicon.svg` (the brand mark is the `IconBrain` brain glyph in white on the `#6d4ee0` accent; a placeholder aligned with the in-app brand, to be replaced once the branding/mascot #14/#92 arrives). Generation is done by `@vite-pwa/assets-generator` per `pwa-assets.config.ts`, once rather than on every build: the prod image (Docker) and `npm run build` do not pull in `sharp`. To regenerate after editing the source:

```
npm run pwa:assets -w @notarium/web
```

The set: `pwa-192x192.png`, `pwa-512x512.png` (purpose any), `maskable-icon-512x512.png` (edge-to-edge accent, glyph in the safe zone), `apple-touch-icon-180x180.png`, `favicon.ico`, `favicon.svg`. The manifest references 192/512/maskable; `index.html` carries the favicons and the apple-touch-icon (while `<link rel="manifest">` is injected by the plugin).

## Service worker: shell only

Build statics are precached (JS/CSS/HTML/icons/fonts per `globPatterns`). There is deliberately NO runtime cache for `/api`:

- **Privacy.** It is currently single-user/no-auth; any data cache in the SW would settle on the device and become a problem under multi-user. A data cache comes only after auth (#10), and lives in #41.
- **Correctness.** A second cache layer on top of the read-model (#60) is hard to invalidate and would show stale notes/graph.

`navigateFallback: '/index.html'` serves the shell for any navigation request offline, EXCEPT `navigateFallbackDenylist: [/^\/api(\/|$)/, /^\/mcp(\/|$)/]` (the `(\/|$)` boundary catches even a bare `/api`/`/mcp`, like the server-side SPA fallback) — the server surfaces (the entire data lane, including SSE #60, the agent-gateway #21, and the streaming ZIP export #17) are required to go to the network rather than receive `index.html` from the cache. Non-navigational `fetch('/api/...')` calls are not touched by the SW (there is no matching runtimeCaching) — offline they honestly fail with a network error, and the app shows its own error-state (#65); it does not substitute the data. `cleanupOutdatedCaches: true` cleans up the precache of previous versions.

## Bundle size and chunking <a id="bundle-size"></a>

Precache has a per-file wall: Workbox will not precache an asset larger than **2 MiB**. Workbox itself only warns and drops the file, but `vite-plugin-pwa` re-raises that warning as an error, so crossing the wall does not leave a hole in the offline shell — it fails the build outright, with no warning stage in between. The wall is written out in `packages/web/vite.config.js` (`maximumFileSizeToCacheInBytes`), at Workbox's own default value, because the budget below is defined as half of it.

That is a cliff, not a guardrail: it gives no headroom, and it is not there at all in a `VITE_PWA=off` build, which generates no service worker to check anything. Both gaps are what the budget below closes.

**The application graph follows visible surfaces.** The non-default Graph, Trash, Settings, Agents, workspace-management and document route families are data-router lazy branches under the static `AppShell`; the canonical Dashboard/auth surfaces remain in the entry graph. A lightweight static `hydrateFallbackElement` keeps the shell and a page-shaped skeleton visible while a cold top-level branch resolves. The editor is a component-level dynamic root rendered only by an editing surface, and the note inspector loads the force-graph canvas only when its Graph panel has renderable data. The full Graph page is already a route-level dynamic root. Live/draft view documents stay inside the document/editor demand path rather than widening the static shell. These boundaries do not move data into router loaders/actions and do not prefetch code on hover or idle.

`build.rollupOptions.output.manualChunks` keeps the two heavyweight families that are synchronous parts of Markdown rendering — `markdown-math` (KaTeX) and `syntax-highlighting` (highlight.js) — plus `view-carrier`, the YAML CST runtime shared by live and draft view documents. `view-carrier` is a named cache boundary but remains demand-bound to document/view surfaces and must not appear in the initial HTML modulepreloads. Editor and graph code use Rollup's natural chunks instead of manual families: claiming either family manually would also claim its dependency closure and could make a supposedly lazy surface an entry dependency again. Natural chunk names and counts are not a contract; every emitted JavaScript file is subject to the same hard budget below.

The host-agnostic `@notarium/core` package declares `sideEffects: false`: its root barrel exports pure building blocks, not import-time registration. That package-owned contract lets Rollup discard an unused server-side graph derivation instead of retaining Graphology in the SPA entry merely because the barrel can name it. A future core module with observable import-time work must revise the package metadata rather than rely on that work implicitly.

“Lazy” here describes the page's critical request/parse/evaluate path, not the complete service-worker transfer. Critical eager JavaScript is the module entry plus the static `modulepreload` links in `index.html`. In the production PWA, Workbox still precaches every emitted application JavaScript file for the offline shell, so route/editor/graph chunks may download in the background during service-worker install or update after the first render. The `VITE_PWA=off` browser build has no such background fetch and is the canonical way to prove page-initiated request timing. A persisted, visible local Graph panel is a real request for the graph surface; a closed inspector or another active tab is not.

**The hard floor sits at half the wall.** `scripts/checkWebBundleBudget.mjs` fails the build when any generated `packages/web/dist/assets/**/*.js` exceeds **1 MiB**, so a chunk that passes still has a full MiB of headroom before it would reach the wall. It hangs off the web workspace's `build` script, which is what the root build, the lean CI lane, the image builder and the `VITE_PWA=off` browser build all call — one contract, no separate job to bypass (see [ci.md](ci.md)). It stats the filesystem and never reads `sw.js`, so the SW-less build — the one with no wall behind it — is gated identically; it counts exact bytes, because raw bytes are what the precache wall counts; and a missing assets directory or an empty JS set fails closed rather than passing as a green no-op.

The budget bounds size, not shape: if a family silently stopped matching, its bytes would return to the entry and only the size verdict would notice — and only once they exceed the remaining headroom. A presence check is deliberately not added, because it would go red on a legitimate dependency removal.

## Update-flow

`PwaProvider` (`composers/PwaProvider`), via `useRegisterSW`, catches `needRefresh` (a new SW is waiting) and raises a sticky toast "A new version is available" with a "Reload" action. The click calls `updateServiceWorker(true)` → `skipWaiting` + a reload into the new version. The same action is duplicated by the "Reload to update" button in Settings → About. Nothing reloads without an explicit click.

## Install UX

`PwaProvider` is the single owner of the PWA lifecycle, mounted at the root (`main.tsx`, inside Toast/Dialog), because `beforeinstallprompt` fires once and early: if no one is listening at that moment, native installation can no longer be offered. The provider catches and hides the event, detects standalone (`display-mode: standalone` + iOS `navigator.standalone`) and `appinstalled`, and hands the state to two consumers: the update toast and the install section of Settings.

The install section lives in Settings → About (`pages/SettingsPage/AboutTab`) — "what this installation is". States: the "Install app" button (when the browser has given `beforeinstallprompt` and it is not installed) → the "Installed" status (in standalone) → the Add-to-Home-Screen instruction on iOS (there is no prompt there) → an honest hint for browsers without support. The pure helpers (`libs/pwa.ts`: `themeColor`/`isStandalone`/`isIOS`) are window-injectable and covered by a unit test.

## theme-color runtime

The manifest `theme_color` is static (a single first-frame color), whereas the theme in the app is switched at runtime. Therefore, on a theme change, `ChromeProvider` rewrites `<meta name="theme-color">` via `themeColor(theme)` (`dark #151517` / `light #ffffff`, which must match `--bg` in `tokens.scss`) — so that the browser/installed-window chrome matches the page background rather than flashing a foreign color.

## Tests and stand

- **e2e/visual** are built with `VITE_PWA=off` (`playwright.config.ts`): the prod build is run in a real browser against the fake backend (#18), and a controlling SW plus the offline-ready signal on the first load would introduce nondeterminism and disturb the visual references. The install UX does not depend on the plugin (it is driven by `PwaProvider`), so it is covered by e2e (`test/e2e/pwa.spec.ts`) via a synthetic `beforeinstallprompt`; the theme-color meta is checked there too on a theme switch. The SW itself is verified live.
- **dev (`make dev`)** runs WITHOUT a service worker (`devOptions.enabled: false`): a dev SW would intercept navigations and survive restarts, masking HMR and serving a stale shell, and there is no hash-asset precache in dev anyway. Statics (icons/favicon) are served in dev as usual (`public/`), but the manifest/SW are not. An honest check of the offline shell/precache/update is against the PROD build (`make up` on the same port).
- **Stand gotchas:** the dev container runs as root, prod (`USER node`, uid 1000) does not; on the shared bind-volume `docker/volumes/data` prod cannot write the meta-DB created by root ("attempt to write a readonly database"). Fixed by `chown -R 1000:1000 docker/volumes` (root in dev writes over it in any case). `public/` is mounted in `compose.dev.yml`, otherwise icons/manifest are not visible in dev without rebuilding the image.

## Deliberately NOT done (loose ends)

Offline data + sync — #41. Push notifications — after auth #10 (no point under single-user right now). Share target / file handlers — potentially tied to import #11, as a separate scope.
