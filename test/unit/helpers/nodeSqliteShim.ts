// Vitest-only shim for `node:sqlite`: the pinned vite 5 doesn't know the
// prefix-only builtin (it strips `node:` and tries to resolve a "sqlite"
// package), so vitest.config.ts aliases the specifier here and we hand the
// real builtin over via the runtime API instead of a static import.
// Production code paths (tsx / node) import `node:sqlite` directly — this
// file exists for the test runner alone.

const sqlite = process.getBuiltinModule('node:sqlite')

export const DatabaseSync = sqlite.DatabaseSync
export const StatementSync = sqlite.StatementSync
export const backup = sqlite.backup
export const constants = sqlite.constants
export default sqlite
