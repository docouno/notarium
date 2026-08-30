import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type { ProviderCiphertextsPersistence, SecretKeyringPersistence } from '../metaDb'
import { SqliteMetaDb } from '../metaDb/sqliteMetaDb'
import { SECRET_FACET } from './consts'
import { CredentialKeyringService } from './credentialKeyring'
import { CredentialKeyring } from './keyring'

const AT = '2026-08-24T00:00:00.000Z'

describe('credential master-key rotation', () => {
  const roots: string[] = []

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  const harness = async (ciphertexts?: ProviderCiphertextsPersistence) => {
    const root = mkdtempSync(join(tmpdir(), 'notarium-credential-rotation-'))
    roots.push(root)
    const db = new SqliteMetaDb(join(root, 'meta.db'))
    const keyring = new CredentialKeyring(join(root, 'secret-keyring'), [])
    const service = new CredentialKeyringService({
      persistence: db.secretKeyring,
      keyring,
      ciphertexts: ciphertexts ?? db.providerCiphertexts,
      now: () => new Date(AT),
    })
    const active = await service.bootstrap()

    expect(active).not.toBeNull()
    return { root, db, keyring, service, active: active! }
  }

  const seed = async (
    db: SqliteMetaDb,
    service: CredentialKeyringService,
    active: { keyId: string; generation: number },
  ) => {
    const credentialSecret = await service.encrypt('credential-secret', {
      facet: SECRET_FACET.credential,
      recordId: 'credential-a',
      field: 'secret',
    })
    await db.credentials.create(
      {
        id: 'credential-a',
        owner: 'alice',
        name: 'Credential',
        kind: 'bearer',
        secret: credentialSecret.ciphertext,
        origin: 'https://provider.example',
        injection: { header: '', prefix: 'Bearer ' },
        disabledAt: null,
        rpm: null,
        tpm: null,
        consentEpoch: 3,
        runtimeEpoch: 5,
      },
      active,
    )
    const headers = Object.fromEntries(
      await Promise.all(
        [
          ['x-api-key', 'header-secret'],
          ['x-title', 'Notarium'],
        ].map(async ([field, value]) => [
          field,
          (
            await service.encrypt(value, {
              facet: SECRET_FACET.resource,
              recordId: 'resource-a',
              field,
            })
          ).ciphertext,
        ]),
      ),
    )
    await db.providerResources.create(
      {
        id: 'resource-a',
        owner: 'alice',
        name: 'Resource',
        wire: 'openai-compatible',
        baseUrl: 'https://provider.example/v1',
        headers,
        allowPrivateNetwork: false,
        purposes: ['chat'],
        models: [],
        defaultModel: null,
        credentialId: 'credential-a',
        consentEpoch: 7,
        runtimeEpoch: 11,
        disabledAt: null,
        lastCheck: {},
        firstByteTimeoutMs: 30_000,
        callTimeoutMs: 300_000,
      },
      active,
    )
  }

  it('keeps preview read-only even when the empty carrier set would let bootstrap repair state', async () => {
    const { db, keyring, service, active } = await harness()

    const mutation = async (): Promise<never> => {
      throw new Error('dry-run touched keyring persistence')
    }
    const readOnlyPersistence: SecretKeyringPersistence = {
      ...db.secretKeyring,
      admitReadable: mutation,
      projectActive: mutation,
      projectRotationActive: mutation,
      replaceNonRetiredWith: mutation,
    }
    const preview = new CredentialKeyringService({
      persistence: readOnlyPersistence,
      keyring,
      ciphertexts: db.providerCiphertexts,
      now: () => new Date(AT),
    })

    await expect(
      preview.rotate({ expectedKeyId: active.keyId, apply: false }),
    ).resolves.toMatchObject({
      applied: false,
      activeKeyId: active.keyId,
      references: { credentials: 0, headers: 0 },
    })
    await expect(
      service.rotate({ expectedKeyId: active.keyId, apply: true }),
    ).resolves.toMatchObject({
      applied: true,
      sourceKeyIds: [active.keyId],
      references: { credentials: 0, headers: 0 },
      retiredKeyIds: [active.keyId],
    })
    await db.close()
  })

  it('rewraps both carriers without changing field AAD or epochs and keeps the old key file', async () => {
    const { db, keyring, service, active } = await harness()
    await seed(db, service, active)
    const oldCredential = (await db.credentials.get('credential-a'))!
    const oldResource = (await db.providerResources.get('resource-a'))!
    const oldKeyPath = join(keyring.keysDir, `${active.keyId}.json`)

    await expect(
      service.rotate({ expectedKeyId: active.keyId, apply: false }),
    ).resolves.toMatchObject({
      applied: false,
      activeKeyId: active.keyId,
      references: { credentials: 1, headers: 2 },
    })
    expect(await db.credentials.get('credential-a')).toEqual(oldCredential)
    expect(await db.providerResources.get('resource-a')).toEqual(oldResource)

    await expect(
      service.rotate({ expectedKeyId: 'ck_000000000000000000000000', apply: true }),
    ).rejects.toThrow(/expected key id/)
    expect((await keyring.readActive())?.keyId).toBe(active.keyId)

    const rotated = await service.rotate({ expectedKeyId: active.keyId, apply: true })
    const credential = (await db.credentials.get('credential-a'))!
    const resource = (await db.providerResources.get('resource-a'))!

    expect(rotated).toMatchObject({
      applied: true,
      sourceKeyIds: [active.keyId],
      references: { credentials: 1, headers: 2 },
      rewrapped: { credentials: 1, headers: 2 },
      retiredKeyIds: [active.keyId],
    })
    expect(rotated.activeKeyId).not.toBe(active.keyId)
    expect(credential.secret).toMatch(new RegExp(`^v1\\.${rotated.activeKeyId}\\.`))
    expect(Object.values(resource.headers)).toEqual([
      expect.stringMatching(new RegExp(`^v1\\.${rotated.activeKeyId}\\.`)),
      expect.stringMatching(new RegExp(`^v1\\.${rotated.activeKeyId}\\.`)),
    ])
    await expect(
      service.decrypt(credential.secret, {
        facet: SECRET_FACET.credential,
        recordId: credential.id,
        field: 'secret',
      }),
    ).resolves.toBe('credential-secret')
    await expect(
      service.decrypt(resource.headers['x-api-key'], {
        facet: SECRET_FACET.resource,
        recordId: resource.id,
        field: 'x-api-key',
      }),
    ).resolves.toBe('header-secret')
    await expect(
      service.decrypt(resource.headers['x-api-key'], {
        facet: SECRET_FACET.resource,
        recordId: resource.id,
        field: 'x-title',
      }),
    ).rejects.toThrow()
    expect(credential).toMatchObject({ consentEpoch: 3, runtimeEpoch: 5 })
    expect(resource).toMatchObject({ consentEpoch: 7, runtimeEpoch: 11 })
    expect(existsSync(oldKeyPath)).toBe(true)
    expect(
      (await db.secretKeyring.list()).find((row) => row.keyId === active.keyId)?.retiredAt,
    ).toBe(AT)
    await db.close()
  })

  it('resumes from ciphertext after a committed batch without minting another target key', async () => {
    const first = await harness()
    await seed(first.db, first.service, first.active)
    let failed = false
    const faulting: ProviderCiphertextsPersistence = {
      ...first.db.providerCiphertexts,
      rewrapBatch: async (input) => {
        const result = await first.db.providerCiphertexts.rewrapBatch(input)

        if (!failed) {
          failed = true
          throw new Error('simulated process death after committed batch')
        }

        return result
      },
    }
    const interrupted = new CredentialKeyringService({
      persistence: first.db.secretKeyring,
      keyring: first.keyring,
      ciphertexts: faulting,
      now: () => new Date(AT),
    })
    await interrupted.bootstrap()

    await expect(
      interrupted.rotate({ expectedKeyId: first.active.keyId, apply: true, batchSize: 1 }),
    ).rejects.toThrow(/simulated process death/)
    const target = (await first.keyring.readActive())!
    expect(target.keyId).not.toBe(first.active.keyId)
    expect(await first.keyring.listKeys()).toHaveLength(2)

    const resumed = new CredentialKeyringService({
      persistence: first.db.secretKeyring,
      keyring: first.keyring,
      ciphertexts: first.db.providerCiphertexts,
      now: () => new Date(AT),
    })
    await resumed.bootstrap()
    const result = await resumed.rotate({ expectedKeyId: target.keyId, apply: true, batchSize: 1 })

    expect(result.activeKeyId).toBe(target.keyId)
    expect(result.sourceKeyIds).toEqual([first.active.keyId])
    expect(await first.keyring.listKeys()).toHaveLength(2)
    await expect(
      first.db.providerCiphertexts.countReferences(new Set([first.active.keyId])),
    ).resolves.toEqual({ credentials: 0, headers: 0 })
    await first.db.close()
  })
})
