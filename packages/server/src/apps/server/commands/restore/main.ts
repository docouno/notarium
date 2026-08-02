// Operator-only disaster restore CLI. The caller must keep the service stopped;
// the library additionally refuses anything except a fresh empty data root.

import { createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'

import { parseCommandLine } from '../../../../libs/commandLine'
import { createBackupInputLimiter, restoreDataBackup } from '../../../../libs/dataBackup'
import { loadEnv } from '../../../../libs/env'
import { backupLayoutFromEnv, backupRuntimeFromEnv } from '../dataBackupLayout'

loadEnv()

const main = async (): Promise<void> => {
  const parsed = parseCommandLine(process.argv.slice(2), { input: 'value' })

  if (parsed.positionals.length > 0) {
    throw new Error(`unexpected argument: ${parsed.positionals[0]}`)
  }
  const requestedInput = parsed.value('input')
  const runtime = backupRuntimeFromEnv()
  await mkdir(runtime.scratchDir ?? tmpdir(), { recursive: true })
  const work = requestedInput
    ? null
    : await mkdtemp(join(runtime.scratchDir ?? tmpdir(), 'notarium-restore-cli-'))
  const input = requestedInput ? resolve(requestedInput) : join(work as string, 'backup.zip')

  try {
    if (!requestedInput) {
      await pipeline(
        process.stdin,
        createBackupInputLimiter(runtime.maxArchiveBytes),
        createWriteStream(input, { flags: 'wx', mode: 0o600 }),
      )
      if ((await stat(input)).size === 0) {
        throw new Error('restore expected a backup archive on stdin')
      }
    }
    const result = await restoreDataBackup({
      layout: backupLayoutFromEnv(),
      input,
      maxArchiveBytes: runtime.maxArchiveBytes,
      maxArchiveEntries: runtime.maxArchiveEntries,
      maxMetadataBytes: runtime.maxMetadataBytes,
    })

    console.log(
      JSON.stringify({
        ...(requestedInput ? { input: result.input } : {}),
        dataDir: result.dataDir,
        createdAt: result.manifest.createdAt,
        files: result.manifest.files.length,
        engine: 'rebuild-on-start',
      }),
    )
  } finally {
    if (work) {
      await rm(work, { recursive: true, force: true })
    }
  }
}

main().catch((err) => {
  console.error(`restore failed: ${(err as Error).message}`)
  process.exitCode = 1
})
