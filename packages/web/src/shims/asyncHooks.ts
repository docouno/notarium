// Build-time stand-in for `node:async_hooks` in the SPA bundle.
//
// `@notarium/core` has ONE entry, and it re-exports `libs/mutationCoordinator` —
// a server-side fence that tracks lease re-entrancy through `AsyncLocalStorage`
// (#327). The browser never coordinates a mutation, but the module still enters
// the bundle graph through that barrel, and a static import of a Node builtin
// fails the production build outright ("AsyncLocalStorage is not exported by
// __vite-browser-external"). The same shape as the `node:sqlite` shim in
// vitest.config.ts, and for the same reason: a bundler that cannot have the
// builtin needs something to resolve.
//
// It THROWS rather than no-ops: if a coordinator is ever really constructed in a
// browser, that is a layering mistake and it should say so, not silently run
// without a fence.
export class AsyncLocalStorage<T> {
  constructor() {
    throw new Error('AsyncLocalStorage is server-only — the SPA must not coordinate mutations')
  }

  getStore(): T | undefined {
    throw new Error('AsyncLocalStorage is server-only')
  }

  run<R>(): R {
    throw new Error('AsyncLocalStorage is server-only')
  }
}
