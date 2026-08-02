// Operator-only online backup CLI. It is run inside the application container,
// alongside the live server, and never exposes a public HTTP administration API.

import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'

import { backupControlSocketFromEnv, requestBackupCheckpoint } from '../../../../libs/backupControl'
import { parseCommandLine } from '../../../../libs/commandLine'
import {
  createBackupInputLimiter,
  createOnlineDataBackup,
  verifyDataBackup,
} from '../../../../libs/dataBackup'
import { loadEnv } from '../../../../libs/env'
import { backupLayoutFromEnv, backupRuntimeFromEnv } from '../dataBackupLayout'

loadEnv()

const args = process.argv.slice(2)
const verifyMode = args[0] === 'verify'
const commandArgs = verifyMode ? args.slice(1) : args

const positiveInteger = (
  name: string,
  raw: string | undefined,
  fallback: number,
  minimum: number,
): number => {
  if (raw === undefined) {
    return fallback
  }
  const value = Number(raw)

  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`--${name} must be an integer >= ${minimum}`)
  }

  return value
}

const create = async (): Promise<void> => {
  const parsed = parseCommandLine(commandArgs, {
    output: 'value',
    'quiet-ms': 'value',
    'max-attempts': 'value',
  })

  if (parsed.positionals.length > 0) {
    throw new Error(`unexpected argument: ${parsed.positionals[0]}`)
  }
  const requestedOutput = parsed.value('output')
  const runtime = backupRuntimeFromEnv()
  await mkdir(runtime.scratchDir ?? tmpdir(), { recursive: true })
  const work = requestedOutput
    ? null
    : await mkdtemp(join(runtime.scratchDir ?? tmpdir(), 'notarium-backup-cli-'))
  const output = requestedOutput ? resolve(requestedOutput) : join(work as string, 'backup.zip')

  try {
    const result = await createOnlineDataBackup({
      layout: backupLayoutFromEnv(),
      output,
      quietMs: positiveInteger('quiet-ms', parsed.value('quiet-ms'), 750, 0),
      maxAttempts: positiveInteger('max-attempts', parsed.value('max-attempts'), 12, 1),
      checkpoint: () => requestBackupCheckpoint(backupControlSocketFromEnv()),
      ...runtime,
      onAttempt: (attempt) => console.error(`backup: consistency attempt ${attempt}`),
    })
    const summary = JSON.stringify({
      ...(requestedOutput ? { output: result.output } : {}),
      createdAt: result.manifest.createdAt,
      attempts: result.attempts,
      files: result.manifest.files.length,
      bytes: result.bytes,
    })

    if (requestedOutput) {
      console.log(summary)
    } else {
      // stdout is the archive transport: diagnostics and summary stay on stderr.
      await pipeline(createReadStream(output), process.stdout)
      console.error(`backup complete: ${summary}`)
    }
  } finally {
    if (work) {
      await rm(work, { recursive: true, force: true })
    }
  }
}

const verify = async (): Promise<void> => {
  const parsed = parseCommandLine(commandArgs, { input: 'value' })

  if (parsed.positionals.length > 0) {
    throw new Error(`unexpected argument: ${parsed.positionals[0]}`)
  }
  const requestedInput = parsed.value('input')
  const runtime = backupRuntimeFromEnv()
  await mkdir(runtime.scratchDir ?? tmpdir(), { recursive: true })
  const work = requestedInput
    ? null
    : await mkdtemp(join(runtime.scratchDir ?? tmpdir(), 'notarium-verify-cli-'))
  const input = requestedInput ? resolve(requestedInput) : join(work as string, 'backup.zip')

  try {
    if (!requestedInput) {
      await pipeline(
        process.stdin,
        createBackupInputLimiter(runtime.maxArchiveBytes),
        createWriteStream(input, { flags: 'wx', mode: 0o600 }),
      )
      if ((await stat(input)).size === 0) {
        throw new Error('backup verify expected an archive on stdin')
      }
    }
    const result = await verifyDataBackup({ input, ...runtime })

    console.log(
      JSON.stringify({
        valid: true,
        ...(requestedInput ? { input: result.input } : {}),
        formatVersion: result.manifest.formatVersion,
        createdAt: result.manifest.createdAt,
        notariumVersion: result.manifest.notariumVersion,
        files: result.manifest.files.length,
        bytes: result.bytes,
      }),
    )
  } finally {
    if (work) {
      await rm(work, { recursive: true, force: true })
    }
  }
}

const main = verifyMode ? verify : create

main().catch((err) => {
  console.error(`${verifyMode ? 'backup verify' : 'backup'} failed: ${(err as Error).message}`)
  process.exitCode = 1
})
