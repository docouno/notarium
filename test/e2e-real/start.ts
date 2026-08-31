import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  cleanupRealStack,
  listenReadiness,
  nodeTsxArguments,
  realStackReady,
  stopChild,
} from './readiness'

const dataDir = mkdtempSync(join(tmpdir(), 'notarium-e2e-real-'))
const port = process.env.REAL_E2E_PORT || '8792'
const readyPort = process.env.REAL_E2E_READY_PORT || String(Number(port) + 1)
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
let setupChild: ChildProcess | null = null
let readiness: Server | null = null
let shutdownPromise: Promise<void> | null = null

const run = (entry: string): Promise<void> =>
  new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, nodeTsxArguments(entry), {
      env: environment,
      stdio: 'inherit',
    })

    setupChild = child

    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (setupChild === child) {
        setupChild = null
      }
      if (code === 0) {
        resolveRun()
      } else {
        reject(new Error(`${entry} exited with ${code ?? signal ?? 'unknown status'}`))
      }
    })
  })

const shutdown = ({ exitCode = 1, signal }: { exitCode?: number; signal?: NodeJS.Signals }) => {
  if (shutdownPromise) {
    return shutdownPromise
  }

  shutdownPromise = (async () => {
    let cleanupFailed = false

    try {
      await stopChild(setupChild)
      await cleanupRealStack({ server, readiness, dataDir })
    } catch (error) {
      cleanupFailed = true
      console.error(error)
    }

    if (signal) {
      process.kill(process.pid, signal)
      return
    }
    process.exitCode = cleanupFailed ? 1 : exitCode
  })()

  return shutdownPromise
}

const waitForReady = async () => {
  const deadline = Date.now() + 120_000

  while (Date.now() < deadline) {
    if (server?.exitCode != null || server?.signalCode) {
      throw new Error('real e2e server exited before the store became ready')
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/s/main/status`)

      if (response.ok && realStackReady(await response.json())) {
        return
      }
    } catch {
      // The server is still binding or the store has not published status yet.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100))
  }

  throw new Error('real e2e store did not become ready')
}

process.once('SIGINT', () => {
  void shutdown({ signal: 'SIGINT' })
})
process.once('SIGTERM', () => {
  void shutdown({ signal: 'SIGTERM' })
})

try {
  await run('scripts/seed.ts')
  server = spawn(process.execPath, nodeTsxArguments('packages/server/src/apps/server/main.ts'), {
    env: environment,
    stdio: 'inherit',
  })
  server.once('error', (error) => {
    if (!shutdownPromise) {
      console.error(error)
      void shutdown({ exitCode: 1 })
    }
  })
  server.once('exit', (code, signal) => {
    if (!shutdownPromise) {
      console.error(`real e2e server exited with ${code ?? signal ?? 'unknown status'}`)
      void shutdown({ exitCode: 1 })
    }
  })
  await waitForReady()
  readiness = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{"ok":true}')
  })
  await listenReadiness(readiness, Number(readyPort))
} catch (error) {
  console.error(error)
  await shutdown({ exitCode: 1 })
}
