// Out-of-band admin CLI for locked-out recovery (lost admin password, or the
// only admin left). Runs directly against the meta-DB, so it works while the
// server is stopped OR running (SQLite WAL tolerates a second writer; Postgres
// always does).
// canon: docs/auth.md#access-recovery-admin-cli

import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, resolve as resolvePath } from 'node:path'
import { createInterface } from 'node:readline'

import { AUTH_MODE, SPACE_ROLE } from '@notarium/contract'

import { parseCommandLine, type ParsedCommandLine } from '../../../../libs/commandLine'
import { loadEnv } from '../../../../libs/env'
import { createAuthService } from '../../../../services/auth'
import type { SpaceRole } from '../../../../services/authz'
import { createMetaDb, sqlitePathOf } from '../../../../services/metaDb'
import { dataPathsFromEnv } from '../../dataPaths'

loadEnv()

const die = (msg: string): never => {
  console.error(`error: ${msg}`)
  process.exit(1)
}

/** Resolves the server's meta-DB on the HOST. The implicit host default
 *  (~/.local/share/notarium/meta.db) is tried LAST on purpose: any bare
 *  `npm run server` materialises it, so preferring it would aim recovery at a
 *  throwaway DB while the real stand sits one directory up. For a sqlite target
 *  the file MUST already exist — the CLI never creates one (a silent empty DB is
 *  exactly how a misaimed run reads as "no users"). */
const resolveMetaDbUrl = (): string => {
  const explicit = process.env.META_DB_URL?.trim()

  if (explicit) {
    if (explicit.startsWith('postgres')) {
      return explicit
    }
    const path = sqlitePathOf(explicit) ?? explicit
    const abs = isAbsolute(path) ? path : resolvePath(process.cwd(), path)

    if (!existsSync(abs)) {
      die(`META_DB_URL points at ${abs}, which does not exist — refusing to create an empty DB`)
    }

    return `sqlite:${abs}`
  }
  // A NAMED root — the server would use it, so `admin` must too. Only when
  // DATA_DIR is explicitly set; its implicit default is deferred to last resort.
  const named = process.env.DATA_DIR?.trim()
    ? sqlitePathOf(dataPathsFromEnv(process.env).metaDbUrl)
    : null

  if (named && existsSync(named)) {
    return `sqlite:${named}`
  }
  let dir = process.cwd()

  for (;;) {
    for (const rel of [
      'docker/volumes/data/meta.db',
      'docker/volumes/notarium-state/meta.db',
      '.data/meta.db',
    ]) {
      const candidate = resolvePath(dir, rel)

      if (existsSync(candidate)) {
        return `sqlite:${candidate}`
      }
    }
    const parent = dirname(dir)

    if (parent === dir) {
      break
    }
    dir = parent
  }
  const implicit = sqlitePathOf(dataPathsFromEnv(process.env).metaDbUrl)

  if (implicit && existsSync(implicit)) {
    return `sqlite:${implicit}`
  }

  return die(
    'could not find a meta-DB. Point DATA_DIR at the data root, e.g.\n' +
      '  DATA_DIR="$(git rev-parse --show-toplevel)/docker/volumes/data" \\\n' +
      '    npm -w @notarium/server run admin -- list\n' +
      'or set META_DB_URL explicitly (external Postgres, or a meta.db outside the root).',
  )
}

const randomPassword = (): string => randomBytes(12).toString('base64url')

/** Prompt for a secret with terminal echo muted, so the password never appears
 *  on screen or in scrollback. */
const readSecret = (prompt: string): Promise<string> =>
  new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    const muted = rl as unknown as { _writeToOutput?: (s: string) => void }
    let primed = false

    muted._writeToOutput = (s: string) => {
      // Let the prompt itself print once; swallow every keystroke echo after.
      if (!primed) {
        process.stdout.write(prompt)
        primed = true
      } else if (s.includes('\n')) {
        process.stdout.write('\n')
      }
    }
    rl.question(prompt, (answer) => {
      rl.close()
      resolve(answer.trim())
    })
  })

const resolvePassword = async (
  parsed: ParsedCommandLine,
): Promise<{ password: string; generated: boolean }> => {
  const explicit = parsed.value('password')

  if (explicit) {
    return { password: explicit, generated: false }
  }
  if (parsed.has('random')) {
    return { password: randomPassword(), generated: true }
  }
  const typed = await readSecret('New password (min 8 chars): ')

  if (typed.length < 8) {
    die('password must be at least 8 characters')
  }

  return { password: typed, generated: false }
}

const main = async (): Promise<void> => {
  const parsed = parseCommandLine(process.argv.slice(2), {
    password: 'value',
    random: 'boolean',
    display: 'value',
  })
  const [command, ...rest] = parsed.positionals
  const allowedByCommand: Record<string, readonly string[]> = {
    list: [],
    passwd: ['password', 'random'],
    'create-admin': ['password', 'random', 'display'],
    grant: [],
  }

  if (command && !Object.hasOwn(allowedByCommand, command)) {
    die(`unknown admin command: ${command}`)
  }
  const allowed = allowedByCommand[command ?? ''] ?? []

  for (const option of parsed.provided) {
    if (!allowed.includes(option)) {
      die(`option --${option} is not valid for admin ${command ?? '(no command)'}`)
    }
  }
  if (parsed.has('password') && parsed.has('random')) {
    die('choose exactly one of --password or --random')
  }
  const metaDbUrl = resolveMetaDbUrl()

  // Always say which DB we touched — a wrong target is the one real footgun.
  console.error(`meta-db: ${metaDbUrl}`)
  const metaDb = createMetaDb(metaDbUrl)
  // The service owns hashing + session-kill semantics; the CLI just drives it.
  const auth = createAuthService({ mode: AUTH_MODE.password, persistence: metaDb.auth })

  try {
    switch (command) {
      case 'list': {
        if (rest.length > 0) {
          die('usage: list')
        }
        const users = await auth.listUsers()

        if (!users.length) {
          console.log('(no users — run create-admin, or the server’s first-run setup)')
          break
        }
        for (const u of users) {
          const flags = [
            u.admin ? 'admin' : 'user',
            u.disabled ? 'DISABLED' : null,
            u.hasPassword ? null : 'no-password',
          ]
            .filter(Boolean)
            .join(', ')
          console.log(`${u.username}\t${u.displayName}\t[${flags}]`)
        }
        break
      }

      case 'passwd': {
        const username = rest[0] ?? die('usage: passwd <username> [--password <pw> | --random]')

        if (rest.length > 1) {
          die('usage: passwd <username> [--password <pw> | --random]')
        }
        const existing = await metaDb.auth.getUser(username)

        if (!existing) {
          die(`no such user: ${username}`)
        }
        const { password, generated } = await resolvePassword(parsed)
        await auth.setPassword(username, password)
        console.log(`✓ password set for ${username} (all existing sessions revoked)`)
        if (generated) {
          console.log(`  password: ${password}`)
        }
        break
      }

      case 'create-admin': {
        const username =
          rest[0] ??
          die('usage: create-admin <username> [--password <pw> | --random] [--display "Name"]')

        if (rest.length > 1) {
          die('usage: create-admin <username> [--password <pw> | --random] [--display "Name"]')
        }
        if (await metaDb.auth.getUser(username)) {
          die(`user already exists: ${username}`)
        }
        const { password, generated } = await resolvePassword(parsed)
        await auth.createAdmin(username, password, parsed.value('display'))
        console.log(`✓ admin created: ${username}`)
        if (generated) {
          console.log(`  password: ${password}`)
        }
        console.log('  grant it spaces with: admin grant ' + username + ' <space> owner')
        break
      }

      case 'grant': {
        const [username, space, roleArg] = rest

        if (!username || !space || !roleArg || rest.length !== 3) {
          die('usage: grant <username> <space> <owner|writer|reader>')
        }
        const roles: SpaceRole[] = [SPACE_ROLE.owner, SPACE_ROLE.writer, SPACE_ROLE.reader]
        const role = roles.find((r) => r === roleArg) ?? die('role must be owner, writer or reader')

        if (!(await metaDb.auth.getUser(username))) {
          die(`no such user: ${username}`)
        }
        await metaDb.auth.upsertMember(space, username, role, new Date().toISOString())
        console.log(`✓ ${username} is now ${role} of ${space}`)
        break
      }

      default:
        console.log(
          [
            'notarium admin CLI (#10)',
            '',
            '  list                                      list users',
            '  passwd <username> [--password|--random]   set a password (revokes sessions)',
            '  create-admin <username> [...]             create an admin (locked-out recovery)',
            '  grant <username> <space> <role>           set space membership',
            '',
            `meta-db: ${metaDbUrl}`,
          ].join('\n'),
        )
    }
  } finally {
    await metaDb.close().catch(() => {})
  }
}

main().catch((err) => {
  console.error(`admin failed: ${(err as Error).message}`)
  process.exitCode = 1
})
