import { execFile } from 'node:child_process'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

import { buildCaseWorld } from './build'

const exec = promisify(execFile)
const repoRoot = fileURLToPath(new URL('../../', import.meta.url))

const runSeed = async (caseName: string, dataDir: string) => {
  const world = buildCaseWorld(caseName)
  return exec(join(repoRoot, 'node_modules', '.bin', 'tsx'), [join(repoRoot, 'scripts/seed.ts')], {
    cwd: repoRoot,
    env: { ...process.env, CASE: caseName, DATA_DIR: dataDir, NOW: world.now },
  })
}

const readRuntimeValue = (caseName: string, flag: string) =>
  exec(join(repoRoot, 'node_modules', '.bin', 'tsx'), [join(repoRoot, 'scripts/seed.ts'), flag], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CASE: caseName,
      DATA_DIR: join(repoRoot, 'test-results', 'seed-config'),
    },
  }).then(({ stdout }) => stdout)

describe('the real provider seed applier', () => {
  it('mints the canonical keyring and persists every provider state as ciphertext', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'notarium-provider-seed-real-'))

    try {
      await expect(readRuntimeValue('providers', '--provider-enabled')).resolves.toBe('true')
      await expect(readRuntimeValue('providers', '--provider-private-origins')).resolves.toBe(
        'http://host.docker.internal:11434',
      )
      const { stdout } = await runSeed('providers', dataDir)
      expect(stdout).toContain('providers credentials=4 resources=10 attachments=5 served=true')
      const keys = await readdir(join(dataDir, 'secret-keyring', 'keys'))
      expect(keys).toHaveLength(1)
      expect(keys[0]).toMatch(/^ck_[0-9a-f]{24}\.json$/)

      const db = new DatabaseSync(join(dataDir, 'meta.db'), { readOnly: true })

      try {
        const credentials = db
          .prepare('SELECT name, secret FROM credentials ORDER BY name')
          .all() as Array<{ name: string; secret: string }>
        expect(credentials).toHaveLength(4)
        expect(credentials.every(({ secret }) => /^v1\.ck_[0-9a-f]{24}\./.test(secret))).toBe(true)
        expect(JSON.stringify(credentials)).not.toContain('seed-provider-value')

        const resources = db
          .prepare('SELECT name, base_url, headers FROM provider_resources ORDER BY name')
          .all() as Array<{ name: string; base_url: string; headers: string }>
        expect(resources).toHaveLength(10)
        expect(resources.find(({ name }) => name === 'Credential origin mismatch')?.base_url).toBe(
          'https://other.example/v1',
        )
        expect(
          JSON.parse(resources.find(({ name }) => name === 'Unreadable custom header')!.headers),
        ).toEqual({ 'x-seed-private': 'v1.ck_000000000000000000000000.AA' })
        expect(JSON.stringify(resources)).not.toContain('seed-provider-header-value')

        const attachmentStates = db
          .prepare('SELECT state, created_at, expires_at FROM provider_attachments')
          .all() as Array<{ state: string; created_at: string; expires_at: string }>
        expect(attachmentStates).toHaveLength(5)
        expect(attachmentStates.map(({ state }) => state)).toEqual(
          expect.arrayContaining(['active', 'awaiting-reconsent', 'pending']),
        )
        const pending = attachmentStates.find(({ state }) => state === 'pending')!
        expect(Date.parse(pending.expires_at) - Date.parse(pending.created_at)).toBe(5 * 60 * 1000)
        expect(
          db.prepare("SELECT archived_at FROM spaces WHERE slug = 'archive-target'").get(),
        ).toMatchObject({ archived_at: expect.any(String) })
        expect(
          db.prepare("SELECT disabled_at FROM users WHERE username = 'disabled-owner'").get(),
        ).toMatchObject({ disabled_at: expect.any(String) })
      } finally {
        db.close()
      }
    } finally {
      await rm(dataDir, { recursive: true, force: true })
    }
  }, 180_000)

  it('keeps encrypted provider rows when the served capability is disabled', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'notarium-provider-seed-disabled-real-'))

    try {
      await expect(readRuntimeValue('providers-disabled', '--provider-enabled')).resolves.toBe(
        'false',
      )
      await expect(
        readRuntimeValue('providers-disabled', '--provider-private-origins'),
      ).resolves.toBe('')
      const { stdout } = await runSeed('providers-disabled', dataDir)
      expect(stdout).toContain('providers credentials=1 resources=1 attachments=0 served=false')
      const db = new DatabaseSync(join(dataDir, 'meta.db'), { readOnly: true })

      try {
        expect(db.prepare('SELECT COUNT(*) AS n FROM credentials').get()).toEqual({ n: 1 })
        expect(db.prepare('SELECT COUNT(*) AS n FROM provider_resources').get()).toEqual({ n: 1 })
        expect(
          db.prepare('SELECT secret FROM credentials').get() as { secret: string },
        ).toMatchObject({ secret: expect.stringMatching(/^v1\.ck_/) })
      } finally {
        db.close()
      }
    } finally {
      await rm(dataDir, { recursive: true, force: true })
    }
  }, 180_000)
})
