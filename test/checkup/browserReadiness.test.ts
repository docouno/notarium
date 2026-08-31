import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  cleanupRealStack,
  listenReadiness,
  nodeTsxArguments,
  realStackReady,
} from '../e2e-real/readiness'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('real browser producer readiness', () => {
  it('opens only after the same scan/index facts the UI folds into Synced', () => {
    expect(realStackReady({ scan: { phase: 'ready' }, engine: { indexing: 'idle' } })).toBe(true)
    expect(realStackReady({ scan: { phase: 'notes' }, engine: { indexing: 'idle' } })).toBe(false)
    expect(realStackReady({ scan: { phase: 'ready' }, engine: { indexing: 'busy' } })).toBe(false)
    expect(
      realStackReady({
        scan: { phase: 'ready' },
        engine: { indexing: 'idle', vector: { pending: 1 } },
      }),
    ).toBe(false)
  })

  it('starts every TSX child under the same no-Maglev runtime fence', () => {
    expect(nodeTsxArguments('server.ts')).toEqual(['--no-maglev', '--import', 'tsx', 'server.ts'])
  })

  it('awaits the real server before deleting its data root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'notarium-real-cleanup-'))
    const dataDir = join(root, 'data')
    const marker = join(root, 'server-stopped')
    roots.push(root)
    await mkdir(dataDir)
    const child = spawn(
      process.execPath,
      [
        '-e',
        `
          const fs = require('node:fs')
          process.on('SIGTERM', () => {
            setTimeout(() => {
              fs.writeFileSync(${JSON.stringify(marker)}, String(fs.existsSync(${JSON.stringify(dataDir)})))
              process.exit(0)
            }, 50)
          })
          process.send('ready')
          setInterval(() => {}, 1000)
        `,
      ],
      { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] },
    )
    await once(child, 'message')

    await cleanupRealStack({ server: child, readiness: null, dataDir })

    await expect(readFile(marker, 'utf8')).resolves.toBe('true')
    await expect(stat(dataDir)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(child.exitCode).toBe(0)
  })

  it('rejects an asynchronous readiness-port bind error', async () => {
    const occupied = createServer()
    await new Promise<void>((resolve) => occupied.listen(0, '127.0.0.1', resolve))
    const address = occupied.address()

    expect(address).not.toBeNull()
    if (!address || typeof address === 'string') {
      throw new Error('expected a TCP readiness fixture')
    }
    const readiness = createServer()

    try {
      await expect(listenReadiness(readiness, address.port)).rejects.toMatchObject({
        code: 'EADDRINUSE',
      })
    } finally {
      await new Promise<void>((resolve) => occupied.close(() => resolve()))
    }
  })
})
