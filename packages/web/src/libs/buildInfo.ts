// Build identity of THIS SPA bundle (#97), injected by Vite `define` at build
// (see vite.config.js) and shown on the About settings tab next to the server's
// own build — a mismatch means a stale cached bundle is talking to a newer
// server. The same defines apply under `vite dev`, so these resolve there too;
// `typeof` guards keep a define-less context (a unit test) from throwing.
declare const __APP_VERSION__: string
declare const __GIT_SHA__: string
declare const __BUILD_TIME__: string

export const buildInfo = {
  version: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev',
  commit: typeof __GIT_SHA__ === 'string' && __GIT_SHA__ ? __GIT_SHA__ : null,
  builtAt: typeof __BUILD_TIME__ === 'string' && __BUILD_TIME__ ? __BUILD_TIME__ : null,
}
