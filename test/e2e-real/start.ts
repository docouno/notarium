import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const dataDir = mkdtempSync(join(tmpdir(), 'notarium-e2e-real-'))
const tsx = resolve('node_modules/.bin/tsx')
const port = process.env.REAL_E2E_PORT || '8792'
const environment = {
  ...process.env,
  AUTH_MODE: 'none',
  CASE: 'trash-recovery',
  DATA_DIR: dataDir,
  NOW: '2026-08-13T12:00:00.000Z',
  PORT: port,
  SCALE: '1',
  SEED: 'real-e2e',
  SYNC_POLL_SECONDS: '0',
  VECTOR_SEARCH: 'off',
}

let server: ChildProcess | null = null
let cleaned = false

const cleanup = () => {
  if (!cleaned) {
    cleaned = true
    rmSync(dataDir, { recursive: true, force: true })
  }
}

const run = (entry: string): Promise<void> =>
  new Promise((resolveRun, reject) => {
    const child = spawn(tsx, [entry], { env: environment, stdio: 'inherit' })

    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolveRun()
      } else {
        reject(new Error(`${entry} exited with ${code ?? signal ?? 'unknown status'}`))
      }
    })
  })

const stop = (signal: NodeJS.Signals) => {
  const child = server

  if (child && child.exitCode == null && child.signalCode == null) {
    child.kill(signal)
  }
}

process.once('SIGINT', () => stop('SIGINT'))
process.once('SIGTERM', () => stop('SIGTERM'))
process.once('exit', cleanup)

try {
  await run('scripts/seed.ts')
  server = spawn(tsx, ['packages/server/src/apps/server/main.ts'], {
    env: environment,
    stdio: 'inherit',
  })
  server.once('error', (error) => {
    console.error(error)
    cleanup()
    process.exit(1)
  })
  server.once('exit', (code, signal) => {
    cleanup()
    process.exitCode = code ?? (signal ? 1 : 0)
  })
} catch (error) {
  console.error(error)
  cleanup()
  process.exit(1)
}
