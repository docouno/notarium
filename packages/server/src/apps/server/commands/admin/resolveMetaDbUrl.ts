// Where the admin CLI finds the server's meta-DB on the HOST.
// canon: docs/auth.md#access-recovery-admin-cli

import { statSync } from 'node:fs'
import { dirname, isAbsolute, resolve as resolvePath } from 'node:path'

import {
  assertNotConnectionString,
  META_DB_TARGET_KIND,
  metaDbTargetOf,
} from '../../../../services/metaDb'
import { dataPathsFromEnv } from '../../dataPaths'

/** Stand layouts to walk up to, newest first — the one-root docker bind, then the
 *  two layouts from before it: recovery must also reach a deployment nobody has
 *  migrated yet. */
const CHECKOUT_LAYOUTS = [
  'docker/volumes/data/meta.db',
  'docker/volumes/notarium-state/meta.db',
  '.data/meta.db',
]

/** Is there a database at this path? Injected so the search order can be tested
 *  against a fixed world: the walk climbs to the filesystem ROOT, so a test over the
 *  real disk would assert against directories no fixture owns. */
export type FileProbe = (path: string) => boolean

/** Non-empty and a regular file. A bare `touch meta.db` otherwise passes for a
 *  database, and the CLI then fills that empty file and answers from it — the very
 *  outcome the existence guard is here to prevent. */
const holdsDatabase: FileProbe = (path) => {
  try {
    const stat = statSync(path)

    return stat.isFile() && stat.size > 0
  } catch {
    return false
  }
}

/** The SQLite FILE behind a resolved URL, or null when the target is Postgres or
 *  `:memory:` — neither is a file to test for existence. */
const fileOf = (url: string): string | null => {
  const target = metaDbTargetOf(url)

  return target.kind === META_DB_TARGET_KIND.file ? target.path : null
}

/** Resolve the meta-DB the operator means, or THROW — this never opens a database it
 *  had to guess at. The implicit host default (~/.local/share/notarium/meta.db) is
 *  tried LAST because any bare `npm run server` materialises it: preferring it would
 *  aim recovery at a throwaway DB while the real stand sits one directory up. A
 *  sqlite target must already exist — a recovery tool that creates its own database
 *  reports "no users" instead of "wrong path". */
export const resolveMetaDbUrl = (
  env: NodeJS.ProcessEnv,
  cwd: string,
  exists: FileProbe = holdsDatabase,
): string => {
  const explicit = env.META_DB_URL?.trim()

  if (explicit) {
    const target = metaDbTargetOf(explicit)

    if (target.kind === META_DB_TARGET_KIND.postgres) {
      return target.url
    }
    // Only a value that classified as a PATH can be a connection string in disguise,
    // and it is the PATH that gets tested — our own `sqlite:` colon would otherwise
    // pair with an '@' in a relative path.
    assertNotConnectionString(target.kind === META_DB_TARGET_KIND.memory ? '' : target.path)
    if (target.kind === META_DB_TARGET_KIND.memory) {
      throw new Error(
        'META_DB_URL is an in-memory database — it holds no users to recover. Point it at the deployment’s meta.db.',
      )
    }
    const abs = isAbsolute(target.path) ? target.path : resolvePath(cwd, target.path)

    if (!exists(abs)) {
      throw new Error(
        `META_DB_URL points at ${abs}, which is not a database — refusing to create an empty one`,
      )
    }

    return `sqlite:${abs}`
  }
  // A NAMED root — the server would use it, so `admin` must too. Only when
  // DATA_DIR is explicitly set; its implicit default is deferred to last resort.
  const named = env.DATA_DIR?.trim() ? fileOf(dataPathsFromEnv(env).metaDbUrl) : null

  if (named && exists(named)) {
    return `sqlite:${named}`
  }
  let dir = cwd

  for (;;) {
    for (const rel of CHECKOUT_LAYOUTS) {
      const candidate = resolvePath(dir, rel)

      if (exists(candidate)) {
        return `sqlite:${candidate}`
      }
    }
    const parent = dirname(dir)

    if (parent === dir) {
      break
    }
    dir = parent
  }
  const implicit = fileOf(dataPathsFromEnv(env).metaDbUrl)

  if (implicit && exists(implicit)) {
    return `sqlite:${implicit}`
  }

  throw new Error(
    'could not find a meta-DB. Point DATA_DIR at the data root, e.g.\n' +
      '  DATA_DIR="$(git rev-parse --show-toplevel)/docker/volumes/data" \\\n' +
      '    npm -w @notarium/server run admin -- list\n' +
      'or set META_DB_URL explicitly (external Postgres, or a meta.db outside the root).',
  )
}
