import type { FastifyInstance } from 'fastify'
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createServer } from '../../packages/server/src/apps/server/server'
import { CREDENTIAL_KEY_TOPOLOGY } from '../../packages/server/src/services/credentialKeyring'

let root: string
const apps: FastifyInstance[] = []

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'notarium-credential-composition-'))
  await mkdir(join(root, 'spaces', 'main'), { recursive: true })
})

afterEach(async () => {
  for (const app of apps.splice(0)) {
    await app.close()
  }
  await rm(root, { recursive: true, force: true })
})

const boot = async (enabled: boolean): Promise<FastifyInstance> => {
  const app = await createServer({
    spaces: [
      {
        slug: 'main',
        engine: 'notarium',
        notesDir: join(root, 'spaces', 'main'),
      },
    ],
    metaDbUrl: `sqlite:${join(root, 'meta.db')}`,
    authMode: 'none',
    engineDataDir: join(root, 'engine'),
    jobsDataDir: join(root, 'jobs'),
    importStagingDir: join(root, 'jobs', 'imports'),
    spacesRoot: join(root, 'spaces'),
    pollIntervalMs: 0,
    providers: { enabled, privateOrigins: new Set() },
    credentialKeyring: {
      path: join(root, 'secret-keyring'),
      topology: CREDENTIAL_KEY_TOPOLOGY.canonicalLocal,
      packedRoots: [join(root, 'spaces'), join(root, 'jobs'), join(root, 'replay-keyring')],
    },
  })
  await app.ready()
  apps.push(app)
  return app
}

describe('createServer — provider credential keyring', () => {
  it('wires the provider ciphertext owner at both production roots', async () => {
    const [server, admin, publicApi] = await Promise.all([
      readFile('packages/server/src/apps/server/server.ts', 'utf8'),
      readFile('packages/server/src/apps/server/commands/admin/main.ts', 'utf8'),
      readFile('packages/server/src/services/credentialKeyring/index.ts', 'utf8'),
    ])

    expect(server).toContain('ciphertexts: metaDb.providerCiphertexts')
    expect(admin).toContain('ciphertexts: metaDb.providerCiphertexts')
    expect(server).not.toContain('NO_CIPHERTEXT_BEFORE_PROVIDER_FACETS')
    expect(admin).not.toContain('NO_CIPHERTEXT_BEFORE_PROVIDER_FACETS')
    expect(server).not.toContain('.setRecovery(')
    expect(publicApi).not.toMatch(
      /CredentialEnvelope|CredentialKeyMaterial|ActiveCredentialKey|StoredCredentialKeyMaterial/,
    )
  })

  it('does not create or advertise keyring state while providers are disabled', async () => {
    const app = await boot(false)

    await expect(stat(join(root, 'secret-keyring'))).rejects.toThrow(/ENOENT/)
    const about = (await app.inject({ method: 'GET', url: '/api/about' })).json()
    expect(about.admin).not.toHaveProperty('providers')
    expect(about.admin).not.toHaveProperty('credentialKeyring')
  })

  it('mints before public admission and exposes the ready admin diagnostic', async () => {
    const app = await boot(true)
    const files = await readdir(join(root, 'secret-keyring', 'keys'))

    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/^ck_[0-9a-f]{24}\.json$/)
    const about = (await app.inject({ method: 'GET', url: '/api/about' })).json()
    expect(about.admin).toMatchObject({
      providers: true,
      credentialKeyring: 'ready',
    })
  })
})
