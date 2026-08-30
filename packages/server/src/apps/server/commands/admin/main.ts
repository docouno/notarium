// Out-of-band admin CLI for account recovery and key maintenance. Individual
// key commands state their stricter operator preconditions.
// canon: docs/auth.md#access-recovery-admin-cli

import { randomBytes } from 'node:crypto'
import { createInterface } from 'node:readline'

import { AUTH_MODE, SPACE_ROLE } from '@notarium/contract'

import { parseCommandLine, type ParsedCommandLine } from '../../../../libs/commandLine'
import { loadEnv } from '../../../../libs/env'
import { createAuthService } from '../../../../services/auth'
import type { SpaceRole } from '../../../../services/authz'
import {
  CredentialKeyring,
  credentialKeyringConfigFromEnv,
  CredentialKeyringService,
} from '../../../../services/credentialKeyring'
import {
  InstallationReplayKey,
  ReplayKeyring,
  replayKeyringConfigFromEnv,
} from '../../../../services/installationReplayKey'
import { createMetaDb, describeMetaDbUrl } from '../../../../services/metaDb'
import { dataPathsFromEnv } from '../../dataPaths'
import { normalizeAdminArguments } from './arguments'
import { grantSpaceMember } from './grant'
import { resolveMetaDbUrl } from './resolveMetaDbUrl'

loadEnv()

const die = (msg: string): never => {
  console.error(`error: ${msg}`)
  process.exit(1)
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
  const parsed = parseCommandLine(normalizeAdminArguments(process.argv.slice(2)), {
    password: 'value',
    random: 'boolean',
    display: 'value',
    'expected-key-id': 'value',
    apply: 'boolean',
  })
  const [command, ...rest] = parsed.positionals
  const allowedByCommand: Record<string, readonly string[]> = {
    list: [],
    passwd: ['password', 'random'],
    'create-admin': ['password', 'random', 'display'],
    grant: [],
    'recover-replay-key': ['expected-key-id', 'apply'],
    'rotate-credential-key': ['expected-key-id', 'apply'],
    'purge-unreadable-secrets': ['expected-key-id', 'apply'],
    'reconcile-credential-keyring': ['expected-key-id', 'apply'],
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
  const metaDbUrl = ((): string => {
    try {
      return resolveMetaDbUrl(process.env, process.cwd())
    } catch (err) {
      return die((err as Error).message)
    }
  })()
  // Always say which DB we touched — a wrong target is the one real footgun. The
  // password is masked: this line lands in scrollback and CI logs.
  const shownUrl = describeMetaDbUrl(metaDbUrl)

  console.error(`meta-db: ${shownUrl}`)
  const metaDb = createMetaDb(metaDbUrl)
  // The service owns hashing + session-kill semantics; the CLI just drives it.
  const auth = createAuthService({
    mode: AUTH_MODE.password,
    persistence: metaDb.auth,
    removeMemberAndProviderAttachments: (space, username) =>
      metaDb.removeMemberAndProviderAttachments(space, username),
  })

  const credentialRecovery = (): CredentialKeyringService => {
    const paths = dataPathsFromEnv(process.env)
    const replay = replayKeyringConfigFromEnv(paths.dataDir, metaDbUrl, process.env)
    const config = credentialKeyringConfigFromEnv(
      {
        dataDir: paths.dataDir,
        metaDbUrl,
        packedRoots: [paths.defaultSpacesRoot, paths.jobsDataDir, replay.path],
      },
      process.env,
    )
    return new CredentialKeyringService({
      persistence: metaDb.secretKeyring,
      keyring: new CredentialKeyring(config.path, config.packedRoots),
      ciphertexts: metaDb.providerCiphertexts,
    })
  }

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

        const record = await grantSpaceMember(
          {
            auth: metaDb.auth,
            spaces: metaDb.spaces,
            grantMemberToActiveSpace: (...args) => metaDb.grantMemberToActiveSpace(...args),
          },
          { username, space, role },
        ).catch((err) => die((err as Error).message))
        console.log(`✓ ${username} is now ${role} of ${record.slug}`)
        break
      }

      case 'recover-replay-key': {
        if (rest.length > 0) {
          die('usage: recover-replay-key --expected-key-id <stable-id> [--apply]')
        }
        const expectedKeyId =
          parsed.value('expected-key-id') ??
          die('usage: recover-replay-key --expected-key-id <stable-id> [--apply]')
        const config = (() => {
          try {
            return replayKeyringConfigFromEnv(
              dataPathsFromEnv(process.env).dataDir,
              metaDbUrl,
              process.env,
            )
          } catch (err) {
            return die((err as Error).message)
          }
        })()
        const recovery = new InstallationReplayKey({
          persistence: metaDb.installationGeneration,
          keyring: new ReplayKeyring(config.path),
          topology: config.topology,
        })
        const result = await recovery
          .recoverMissingExternal({ expectedKeyId, apply: parsed.has('apply') })
          .catch((err) => die((err as Error).message))

        if (!result.applied) {
          console.log(
            `dry-run: stable ${result.previousKeyId} at generation ${result.generation} is eligible for complete-loss recovery`,
          )
          console.log('stop every serving process, recheck the topology, then repeat with --apply')
        } else {
          console.log(
            `✓ replay key recovered: ${result.previousKeyId} → ${result.activeKeyId} (generation ${result.generation})`,
          )
        }
        break
      }

      case 'reconcile-credential-keyring': {
        if (rest.length > 0) {
          die(
            'usage: reconcile-credential-keyring --expected-key-id <database-active-id> [--apply]',
          )
        }
        const expectedKeyId =
          parsed.value('expected-key-id') ??
          die(
            'usage: reconcile-credential-keyring --expected-key-id <database-active-id> [--apply]',
          )
        const result = await credentialRecovery()
          .reconcileHistorical({ expectedKeyId, apply: parsed.has('apply') })
          .catch((err) => die((err as Error).message))

        if (result.applied) {
          console.log(`✓ credential keyring pointer reconciled to ${result.active.keyId}`)
        } else {
          console.log(
            `dry-run: database-active credential key ${result.active.keyId} at generation ${result.active.generation} is readable`,
          )
          console.log(
            'stop every serving process, recheck the snapshot pair, then repeat with --apply',
          )
        }
        break
      }

      case 'rotate-credential-key': {
        if (rest.length > 0) {
          die('usage: rotate-credential-key --expected-key-id <active-id> [--apply]')
        }
        const expectedKeyId =
          parsed.value('expected-key-id') ??
          die('usage: rotate-credential-key --expected-key-id <active-id> [--apply]')
        const result = await credentialRecovery()
          .rotate({ expectedKeyId, apply: parsed.has('apply') })
          .catch((err) => die((err as Error).message))

        if (!result.applied) {
          console.log(
            `dry-run: credential key ${result.activeKeyId}; ${result.references.credentials} credential and ${result.references.headers} header references will be rewrapped`,
          )
          console.log(
            'stop every serving process, recheck the active key id, then repeat with --apply',
          )
        } else {
          console.log(
            `✓ credential key rotated to ${result.activeKeyId}; rewrapped ${result.rewrapped.credentials} credentials and ${result.rewrapped.headers} headers`,
          )
          console.log(`  retired keys: ${result.retiredKeyIds.join(', ') || 'none'}`)
          console.log(
            '  immutable retired key files remain in secret-keyring for historical backups; do not delete files still covered by backup retention',
          )
        }
        break
      }

      case 'purge-unreadable-secrets': {
        if (rest.length > 0) {
          die('usage: purge-unreadable-secrets --expected-key-id <database-active-id> [--apply]')
        }
        const expectedKeyId =
          parsed.value('expected-key-id') ??
          die('usage: purge-unreadable-secrets --expected-key-id <database-active-id> [--apply]')
        const result = await credentialRecovery()
          .purgeUnreadable({ expectedKeyId, apply: parsed.has('apply') })
          .catch((err) => die((err as Error).message))

        if (!result.plan.affected.length) {
          console.log('(no unreadable credential or header rows)')
        }
        for (const impact of result.plan.affected) {
          console.log(
            [
              impact.kind,
              impact.owner,
              impact.recordId,
              impact.disabledResourceIds.length
                ? `disabled resources: ${impact.disabledResourceIds.join(',')}`
                : 'disabled resources: none',
            ].join('\t'),
          )
        }
        if (result.applied) {
          console.log(
            `✓ unreadable provider secrets purged; credential key ${result.previousKeyId} replaced by ${result.activeKeyId}`,
          )
        } else {
          console.log(
            `dry-run: complete loss of credential key ${result.previousKeyId} confirmed; no rows changed`,
          )
          console.log(
            'stop every serving process, review the affected owners, then repeat with --apply',
          )
        }
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
            '  recover-replay-key --expected-key-id ID   dry-run shared-keyring recovery',
            '  rotate-credential-key --expected-key-id ID',
            '                                             dry-run credential-key rotation',
            '  reconcile-credential-keyring --expected-key-id ID',
            '                                             dry-run historical-keyring reconcile',
            '  purge-unreadable-secrets --expected-key-id ID',
            '                                             dry-run lost-secret purge',
            '',
            `meta-db: ${shownUrl}`,
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
