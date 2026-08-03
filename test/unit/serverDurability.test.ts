// The composition root's durability rule: a password host may not run on a meta-DB
// that cannot outlive the process. `createAuthService` only knows whether a store is
// PRESENT — an in-memory one is, and then forgets every account on restart, which
// re-opens the public first-run screen to whoever reloads first.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import { createServer } from '../../packages/server/src/apps/server/server'

const roots: string[] = []
const apps: Array<{ close: () => Promise<void> }> = []

const boot = async (metaDbUrl: string, authMode?: 'password' | 'none') => {
  const root = await mkdtemp(join(tmpdir(), 'notarium-durability-'))
  roots.push(root)
  const app = await createServer({
    spaces: [],
    metaDbUrl,
    ...(authMode ? { authMode } : {}),
    engineDataDir: join(root, 'engine'),
    jobsDataDir: join(root, 'jobs'),
    importStagingDir: join(root, 'jobs', 'imports'),
    spacesRoot: root,
    pollIntervalMs: 0,
  })
  apps.push(app)

  return app
}

afterAll(async () => {
  await Promise.all(apps.map((a) => a.close().catch(() => {})))
  await Promise.all(roots.map((r) => rm(r, { recursive: true, force: true })))
})

describe('createServer — password mode needs a meta-DB that survives a restart', () => {
  it('refuses an in-memory meta-DB in password mode', async () => {
    await expect(boot('sqlite::memory:', 'password')).rejects.toThrow(/durable meta-DB/)
  })

  it('allows it in none mode, where there are no accounts to forget', async () => {
    // Not a loophole: 'none' is the single-principal opt-out — nothing is stored that
    // a restart could silently drop.
    await expect(boot('sqlite::memory:', 'none')).resolves.toBeTruthy()
  })

  it('applies the rule to an omitted authMode too — password is the default', async () => {
    // A programmatic host that never names a mode still gets password mode, so the
    // guard must read the same default the auth service does.
    await expect(boot('sqlite::memory:')).rejects.toThrow(/durable meta-DB/)
  })

  it('allows a file-backed meta-DB in password mode', async () => {
    const root = await mkdtemp(join(tmpdir(), 'notarium-durability-file-'))
    roots.push(root)

    await expect(boot(`sqlite:${join(root, 'meta.db')}`, 'password')).resolves.toBeTruthy()
  })
})
