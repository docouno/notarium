// The ONE meta-DB URL classifier, plus the form that is safe to PRINT.
// canon: docs/architecture.md#data-root

import { META_DB, type MetaDb as MetaDbFlavour } from '@notarium/contract'

/** SQLite's sentinel for a non-file database — never a path to resolve or mkdir. */
export const IN_MEMORY_DB = ':memory:'

export const META_DB_TARGET_KIND = {
  postgres: 'postgres',
  /** A SQLite file on disk — the only target with a directory to create and probe. */
  file: 'file',
  memory: 'memory',
} as const

export type MetaDbTarget =
  | { kind: typeof META_DB_TARGET_KIND.postgres; url: string }
  | { kind: typeof META_DB_TARGET_KIND.file; path: string }
  | { kind: typeof META_DB_TARGET_KIND.memory }

/** A leading URI scheme. Two characters minimum on purpose: a one-letter scheme is
 *  a Windows drive, which must stay a path. Schemes are case-insensitive (RFC 3986). */
const SCHEME = /^([a-z][a-z0-9+.-]+):/i

/** A value carrying a credential rather than naming a path: userinfo, or a password
 *  written as an assignment (libpq takes one as a keyword or a query parameter). The
 *  userinfo half only matches at the start of the value or right after a `//` — the
 *  two places an authority can begin, which also catches a URL that lost the colon of
 *  its scheme. Matching a bare `…:…@` anywhere would instead call a dated directory
 *  holding a mail-shaped folder (`/data/2026:07/team@corp/`) a credential.
 *  A hit is never partially masked: where the password ENDS is exactly the guess that
 *  failed review nine times over. */
const CREDENTIAL_SHAPED =
  /(?:^|\/\/)[^/\s:@]*:[^/\s@]*@|\b(?:ssl)?(?:password|passwd|pass|pwd)\s*=/i

/** Classify a meta-DB URL: `postgres://…` / `postgresql://…`, `sqlite:<path>`, or a
 *  bare path (the local-run convenience). Only the SCHEME is ours to judge — a
 *  recognised one goes to its driver even when the rest is malformed, so the driver
 *  reports it out loud. An unknown scheme throws rather than degrading into a
 *  filename; so does an empty path, which would otherwise resolve to the cwd. */
export const metaDbTargetOf = (url: string): MetaDbTarget => {
  const scheme = SCHEME.exec(url)?.[1]?.toLowerCase()

  if (scheme === 'postgres' || scheme === 'postgresql') {
    return { kind: META_DB_TARGET_KIND.postgres, url }
  }
  if (scheme && scheme !== 'sqlite') {
    throw new Error(
      `unsupported meta-DB URL scheme "${scheme}:"\n` +
        '  Notarium reads postgres://… (or postgresql://…), sqlite:<path>, and a plain\n' +
        '  file path. A misspelt scheme is NOT taken as a filename: that would open an\n' +
        '  empty database instead of yours.',
    )
  }
  const path = scheme ? url.slice(scheme.length + 1) : url

  if (path === IN_MEMORY_DB) {
    return { kind: META_DB_TARGET_KIND.memory }
  }
  if (!path.trim()) {
    throw new Error(
      `meta-DB URL names no database: ${JSON.stringify(url)}. Give a file path (sqlite:/path/meta.db) or a postgres:// URL.`,
    )
  }

  return { kind: META_DB_TARGET_KIND.file, path }
}

/** Refuse a value the operator TYPED that carries a credential — a libpq keyword list,
 *  or a connection URL that lost its scheme. Taken as a path it becomes a DIRECTORY
 *  NAMED AFTER THE CREDENTIAL: created on disk, holding a fresh empty database, and
 *  printed by whatever reports paths — including messages nothing here formats, like an
 *  fs error naming the path it failed on. Belongs at the env edge, not in the
 *  classifier: the classifier also runs on paths this host DERIVES from DATA_DIR, and a
 *  data root that happens to hold a colon before an '@' is not a credential. */
export const assertNotConnectionString = (raw: string): void => {
  if (CREDENTIAL_SHAPED.test(raw)) {
    throw new Error(
      'META_DB_URL looks like a connection string, not a path. Postgres needs its scheme: postgres://user:password@host/database.',
    )
  }
}

/** Which driver backs a host, in the vocabulary `/api/about` publishes. Undefined ⇒
 *  the programmatic no-meta-DB configuration, where identity and history are
 *  ephemeral. Lives here so the wire answer and the driver choice cannot disagree. */
export const metaDbFlavourOf = (url: string | undefined): MetaDbFlavour => {
  if (!url) {
    return META_DB.none
  }

  return metaDbTargetOf(url).kind === META_DB_TARGET_KIND.postgres
    ? META_DB.postgres
    : META_DB.sqlite
}

/** How to NAME the meta-DB in output — this text goes to scrollback, `docker logs`
 *  and CI, where a secret does not expire. A path is named in full: it holds no
 *  credential, and it is the branch that matters, since the empty-database footgun
 *  this classifier exists for is a SQLite one. Anything with another scheme is named
 *  by its scheme alone. Nine review rounds went into printing a Postgres address
 *  without its password; every rule that tried to find where the credential ends was
 *  defeated by a password containing the character that rule called the end. Measured
 *  on random punctuation-bearing passwords, the last such rule still produced a WRONG
 *  address 4.5% of the time. The driver names host, database and user in its own
 *  connection error, so this gives up a diagnostic that was never reliable and was
 *  already available elsewhere. */
export const describeMetaDbUrl = (url: string): string => {
  const scheme = SCHEME.exec(url)?.[1]?.toLowerCase()

  // Any scheme but sqlite can carry credentials in an authority — and a value with no
  // authority to parse (`postgres:/…`, a keyword string, a URL missing its scheme) can
  // carry them just as well. Name the scheme; quote nothing.
  if (scheme && scheme !== 'sqlite') {
    return `${scheme}://…`
  }

  // A path — `sqlite:<path>`, a bare path, `:memory:`. Tested WITHOUT our own
  // `sqlite:` prefix: that colon would otherwise pair with any '@' in the path and
  // hide an ordinary local directory (`/home/ann@corp/notarium/meta.db`) behind a
  // marker that reads as "a secret was here". The env edge already refuses a typed
  // credential, so this is the belt for a value that arrived some other way.
  const path = scheme ? url.slice(scheme.length + 1) : url

  return CREDENTIAL_SHAPED.test(path) ? '… (hidden)' : url
}
