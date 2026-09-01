import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

import {
  CREDENTIAL_KEY_STATE,
  CredentialKeyring,
  CredentialKeyringService,
  SECRET_FACET,
  SqliteMetaDb,
} from '@notarium/server'

const execute = promisify(execFile)

describe('credential keyring admin CLI carrier', () => {
  it('lists key rotation and both disaster-recovery commands in the image multicall usage', async () => {
    const { stdout } = await execute('sh', ['docker/notarium-cli', 'help', 'admin'])

    expect(stdout).toContain('rotate-credential-key --expected-key-id ID [--apply]')
    expect(stdout).toContain('reconcile-credential-keyring --expected-key-id ID [--apply]')
    expect(stdout).toContain('purge-unreadable-secrets --expected-key-id ID [--apply]')
  })

  // Spawns a cold `tsx` per step, so the default 5 s deadline is a load-dependent
  // flake rather than a real budget for this carrier.
  it('dry-runs and applies credential-key rotation through the real admin CLI', async () => {
    const root = mkdtempSync(join(tmpdir(), 'notarium-admin-provider-rotation-'))
    const metaDbUrl = join(root, 'meta.db')
    const db = new SqliteMetaDb(metaDbUrl)
    const keyring = new CredentialKeyring(join(root, 'secret-keyring'), [])
    const service = new CredentialKeyringService({
      persistence: db.secretKeyring,
      keyring,
      ciphertexts: db.providerCiphertexts,
    })

    try {
      const active = (await service.bootstrap())!
      const secret = await service.encrypt('credential-secret', {
        facet: SECRET_FACET.credential,
        recordId: 'credential-a',
        field: 'secret',
      })
      const header = await service.encrypt('header-secret', {
        facet: SECRET_FACET.resource,
        recordId: 'resource-a',
        field: 'x-api-key',
      })
      await db.credentials.create(
        {
          id: 'credential-a',
          owner: 'alice',
          name: 'Credential',
          kind: 'bearer',
          secret: secret.ciphertext,
          origin: 'https://provider.example',
          injection: { header: '', prefix: 'Bearer ' },
          disabledAt: null,
          rpm: null,
          tpm: null,
          consentEpoch: 0,
          runtimeEpoch: 0,
        },
        active,
      )
      await db.providerResources.create(
        {
          id: 'resource-a',
          owner: 'alice',
          name: 'Resource',
          wire: 'openai-compatible',
          baseUrl: 'https://provider.example/v1',
          headers: { 'x-api-key': header.ciphertext },
          allowPrivateNetwork: false,
          models: [],
          defaultModel: null,
          credentialId: 'credential-a',
          consentEpoch: 0,
          runtimeEpoch: 0,
          disabledAt: null,
          lastCheck: {},
          firstByteTimeoutMs: 30_000,
          callTimeoutMs: 300_000,
        },
        active,
      )
      await db.close()
      const env = { ...process.env, DATA_DIR: root, META_DB_URL: metaDbUrl }
      const dryRun = await execute(
        'npx',
        [
          'tsx',
          'packages/server/src/apps/server/commands/admin/main.ts',
          'rotate-credential-key',
          '--expected-key-id',
          active.keyId,
        ],
        { env },
      )

      expect(dryRun.stdout).toContain('1 credential and 1 header references will be rewrapped')
      const unchanged = new SqliteMetaDb(metaDbUrl)
      expect((await unchanged.secretKeyring.active())[0].keyId).toBe(active.keyId)
      await unchanged.close()

      const applied = await execute(
        'npx',
        [
          'tsx',
          'packages/server/src/apps/server/commands/admin/main.ts',
          'rotate-credential-key',
          '--expected-key-id',
          active.keyId,
          '--apply',
        ],
        { env },
      )

      expect(applied.stdout).toContain('rewrapped 1 credentials and 1 headers')
      expect(applied.stdout).toContain('immutable retired key files remain')
      const rotated = new SqliteMetaDb(metaDbUrl)
      const next = (await rotated.secretKeyring.active())[0]
      expect(next.keyId).not.toBe(active.keyId)
      expect((await rotated.credentials.get('credential-a'))?.secret).toMatch(
        new RegExp(`^v1\\.${next.keyId}\\.`),
      )
      expect((await rotated.providerResources.get('resource-a'))?.headers['x-api-key']).toMatch(
        new RegExp(`^v1\\.${next.keyId}\\.`),
      )
      expect(
        (await rotated.secretKeyring.list()).find((row) => row.keyId === active.keyId),
      ).toMatchObject({
        retiredAt: expect.any(String),
      })
      await rotated.close()
    } finally {
      await db.close()
      rmSync(root, { recursive: true, force: true })
    }
  }, 30_000)

  it('purges real provider carriers before the admin command publishes a replacement key', async () => {
    const root = mkdtempSync(join(tmpdir(), 'notarium-admin-provider-recovery-'))
    const keyId = 'ck_111111111111111111111111'
    const ciphertext = (value: string) => `v1.${keyId}.${Buffer.from(value).toString('base64url')}`
    const db = new SqliteMetaDb(join(root, 'meta.db'))

    try {
      await db.secretKeyring.replaceNonRetiredWith({
        keyId,
        canary: ciphertext('canary'),
        state: CREDENTIAL_KEY_STATE.active,
        generation: 1,
        createdAt: '2026-08-23T00:00:00.000Z',
        retiredAt: null,
      })
      await db.credentials.create(
        {
          id: 'credential-a',
          owner: 'alice',
          name: 'Credential',
          kind: 'bearer',
          secret: ciphertext('secret'),
          origin: 'https://provider.example',
          injection: { header: '', prefix: 'Bearer ' },
          disabledAt: null,
          rpm: null,
          tpm: null,
          consentEpoch: 0,
          runtimeEpoch: 0,
        },
        { keyId, generation: 1 },
      )
      await db.providerResources.create(
        {
          id: 'resource-a',
          owner: 'alice',
          name: 'Resource',
          wire: 'openai-compatible',
          baseUrl: 'https://provider.example/v1',
          headers: { 'x-title': ciphertext('header') },
          allowPrivateNetwork: false,
          models: [],
          defaultModel: null,
          credentialId: 'credential-a',
          consentEpoch: 0,
          runtimeEpoch: 0,
          disabledAt: null,
          lastCheck: {},
          firstByteTimeoutMs: 30_000,
          callTimeoutMs: 300_000,
        },
        { keyId, generation: 1 },
      )
      await db.close()

      const { stdout } = await execute(
        'npx',
        [
          'tsx',
          'packages/server/src/apps/server/commands/admin/main.ts',
          'purge-unreadable-secrets',
          '--expected-key-id',
          keyId,
          '--apply',
        ],
        { env: { ...process.env, DATA_DIR: root, META_DB_URL: join(root, 'meta.db') } },
      )
      expect(stdout).toContain('credential\talice\tcredential-a')
      expect(stdout).toContain('header\talice\tresource-a')
      expect(stdout).toContain('unreadable provider secrets purged')

      const reopened = new SqliteMetaDb(join(root, 'meta.db'))
      await expect(reopened.credentials.get('credential-a')).resolves.toBeNull()
      await expect(reopened.providerResources.get('resource-a')).resolves.toMatchObject({
        credentialId: null,
        headers: {},
        runtimeEpoch: 1,
      })
      const active = await reopened.secretKeyring.active()
      expect(active).toHaveLength(1)
      expect(active[0].keyId).not.toBe(keyId)
      await reopened.close()
    } finally {
      await db.close()
      rmSync(root, { recursive: true, force: true })
    }
  }, 30_000)
})
