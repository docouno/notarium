import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CREDENTIAL_KEYRING_STATUS } from '@notarium/contract'

import { SqliteMetaDb } from '../metaDb/sqliteMetaDb'
import type { ProviderCiphertextsPersistence, SecretKeyringPersistence } from '../metaDb/types'
import { CREDENTIAL_KEY_STATE } from './consts'
import { CredentialKeyringService, type CredentialKeyringServiceOptions } from './credentialKeyring'
import { credentialCanaryOf, CredentialEnvelope } from './envelope'
import { CredentialKeyring, type StoredCredentialKeyMaterial } from './keyring'
import type { UnreadableSecretPlan } from './types'

class CiphertextsFixture implements ProviderCiphertextsPersistence {
  ciphertext = false
  purges = 0
  plan: UnreadableSecretPlan = { affected: [] }

  async hasCiphertext(): Promise<boolean> {
    return this.ciphertext
  }

  async previewUnreadable(): Promise<UnreadableSecretPlan> {
    return structuredClone(this.plan)
  }

  async purgeUnreadable(): Promise<UnreadableSecretPlan> {
    this.purges += 1
    this.ciphertext = false
    return structuredClone(this.plan)
  }

  async countReferences() {
    return { credentials: 0, headers: 0 }
  }

  async rewrapBatch() {
    return { rewrapped: { credentials: 0, headers: 0 } }
  }

  async retireKeys() {
    return {
      status: 'retired' as const,
      references: { credentials: 0, headers: 0 },
      retiredKeyIds: [],
    }
  }
}

let root: string
let db: SqliteMetaDb
let keyring: CredentialKeyring
let ciphertexts: CiphertextsFixture

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'notarium-credential-service-'))
  db = new SqliteMetaDb(':memory:')
  keyring = new CredentialKeyring(join(root, 'secret-keyring'), [])
  ciphertexts = new CiphertextsFixture()
})

afterEach(async () => {
  await db.close()
  await rm(root, { recursive: true, force: true })
})

const service = (over: Partial<CredentialKeyringServiceOptions> = {}): CredentialKeyringService =>
  new CredentialKeyringService({
    persistence: db.secretKeyring,
    keyring,
    ciphertexts,
    now: () => new Date('2026-08-22T00:00:00.000Z'),
    ...over,
  })

const persistenceWith = (over: Partial<SecretKeyringPersistence>): SecretKeyringPersistence => ({
  ...db.secretKeyring,
  ...over,
})

const readableRecord = async (key: StoredCredentialKeyMaterial, generation: number) => {
  const envelope = new CredentialEnvelope(async (keyId) => keyring.readKey(keyId))
  return {
    keyId: key.keyId,
    canary: envelope.encrypt(credentialCanaryOf(key.secret).toString('base64url'), key, {
      facet: 'keyring' as const,
      recordId: key.keyId,
      field: 'canary',
    }),
    state: CREDENTIAL_KEY_STATE.readable,
    generation,
    createdAt: '2026-08-22T00:00:00.000Z',
    retiredAt: null,
  }
}

describe('credential keyring service', () => {
  it('mints once, persists the canary, and reopens with the same active key', async () => {
    const firstService = service()
    const first = await firstService.bootstrap()

    expect(first?.keyId).toMatch(/^ck_[0-9a-f]{24}$/)
    expect(firstService.diagnostic.status).toBe(CREDENTIAL_KEYRING_STATUS.ready)
    const encrypted = await firstService.encrypt('sk-live-secret', {
      facet: 'credential',
      recordId: 'credential-one',
      field: 'secret',
    })
    expect(encrypted).toMatchObject({
      keyId: first?.keyId,
      generation: first?.generation,
    })
    await expect(
      firstService.decrypt(encrypted.ciphertext, {
        facet: 'credential',
        recordId: 'credential-one',
        field: 'secret',
      }),
    ).resolves.toBe('sk-live-secret')
    expect(await db.secretKeyring.active()).toMatchObject([
      {
        keyId: first?.keyId,
        state: CREDENTIAL_KEY_STATE.active,
        generation: 1,
      },
    ])

    const reopened = await service().bootstrap()
    expect(reopened?.keyId).toBe(first?.keyId)
    expect(await db.secretKeyring.list()).toHaveLength(1)
  })

  it('recovers a crash after pointer publication from the prepublished readable row', async () => {
    const first = await service().bootstrap()
    const second = await keyring.createCandidate()
    await db.secretKeyring.admitReadable(await readableRecord(second, 2))
    await keyring.installActive(2, second)
    ciphertexts.ciphertext = true

    const recoveredService = service()
    const recovered = await recoveredService.bootstrap()

    expect(recovered?.keyId).toBe(second.keyId)
    expect(recovered?.keyId).not.toBe(first?.keyId)
    expect(await db.secretKeyring.active()).toMatchObject([{ keyId: second.keyId, generation: 2 }])
  })

  it('does not confuse a historical DB with a crash after pointer publication', async () => {
    const first = await service().bootstrap()
    const descendant = await keyring.createCandidate()
    await keyring.installActive(2, descendant)
    ciphertexts.ciphertext = true

    const restored = service()
    await expect(restored.bootstrap()).resolves.toBeNull()
    expect(restored.diagnostic.status).toBe(CREDENTIAL_KEYRING_STATUS.unreadable)
    expect(restored.errorMessage()).toMatch(/reconcile-credential-keyring/)

    await expect(
      restored.reconcileHistorical({ expectedKeyId: first!.keyId, apply: false }),
    ).resolves.toMatchObject({ applied: false, active: { keyId: first!.keyId } })
    await restored.reconcileHistorical({ expectedKeyId: first!.keyId, apply: true })
    expect((await keyring.readActive())?.keyId).toBe(first!.keyId)
    expect((await keyring.listKeys()).map((key) => key.keyId)).toContain(descendant.keyId)
    await expect(service().bootstrap()).resolves.toMatchObject({ keyId: first!.keyId })
  })

  it('degrades only the provider secrets when a published key file is changed', async () => {
    const first = await service().bootstrap()
    ciphertexts.ciphertext = true
    const path = join(keyring.keysDir, `${first!.keyId}.json`)
    const payload = JSON.parse(await readFile(path, 'utf8')) as {
      format: string
      formatVersion: number
      keyId: string
      secret: string
    }
    payload.secret = Buffer.alloc(32, 0x44).toString('base64url')
    await writeFile(path, `${JSON.stringify(payload)}\n`)

    const degraded = service()
    await expect(degraded.bootstrap()).resolves.toBeNull()
    expect(degraded.diagnostic.status).toBe(CREDENTIAL_KEYRING_STATUS.unreadable)
    expect(degraded.errorMessage()).toMatch(/does not match|authentication failed/)
    expect(await db.secretKeyring.active()).toHaveLength(1)
  })

  it('refuses partial loss of any non-retired generation', async () => {
    await service().bootstrap()
    const second = await keyring.createCandidate()
    await db.secretKeyring.admitReadable(await readableRecord(second, 2))
    await rm(join(keyring.keysDir, `${second.keyId}.json`))
    ciphertexts.ciphertext = true

    const degraded = service()
    await expect(degraded.bootstrap()).resolves.toBeNull()
    expect(degraded.errorMessage()).toContain('non-retired key file is missing')
  })

  it('reissues the witness after restore when no ciphertext exists', async () => {
    const first = await service().bootstrap()
    await rm(keyring.root, { recursive: true, force: true })

    const restored = await service().bootstrap()

    expect(restored?.keyId).not.toBe(first?.keyId)
    expect(await db.secretKeyring.list()).toMatchObject([
      { keyId: restored?.keyId, generation: 2, state: CREDENTIAL_KEY_STATE.active },
    ])
  })

  it('keeps complete-loss purge two-step and uses the DB active projection as witness', async () => {
    const first = await service().bootstrap()
    ciphertexts.ciphertext = true
    ciphertexts.plan = {
      affected: [
        {
          kind: 'credential',
          owner: 'user:alice',
          recordId: 'cred-one',
          disabledResourceIds: ['resource-one'],
        },
      ],
    }
    await rm(keyring.root, { recursive: true, force: true })

    await expect(
      service().purgeUnreadable({
        expectedKeyId: 'ck_ffffffffffffffffffffffff',
        apply: false,
      }),
    ).rejects.toThrow(/database names/)
    const dryRun = await service().purgeUnreadable({
      expectedKeyId: first!.keyId,
      apply: false,
    })
    expect(dryRun).toMatchObject({
      applied: false,
      previousKeyId: first!.keyId,
      plan: ciphertexts.plan,
    })
    expect(ciphertexts.purges).toBe(0)
    await expect(readFile(keyring.activePath)).rejects.toThrow(/ENOENT/)

    const applied = await service().purgeUnreadable({
      expectedKeyId: first!.keyId,
      apply: true,
    })
    expect(applied.applied).toBe(true)
    expect(applied.activeKeyId).not.toBe(first!.keyId)
    expect(ciphertexts.purges).toBe(1)
    await expect(readFile(keyring.activePath, 'utf8')).resolves.toContain(applied.activeKeyId)
  })

  it('does not mint over ciphertext when the pointer is completely missing', async () => {
    const first = await service().bootstrap()
    ciphertexts.ciphertext = true
    await rm(keyring.root, { recursive: true, force: true })
    await mkdir(keyring.root, { recursive: true })

    const degraded = service()
    await expect(degraded.bootstrap()).resolves.toBeNull()
    expect(degraded.errorMessage()).toContain('active pointer is missing')
    expect(await db.secretKeyring.active()).toMatchObject([{ keyId: first!.keyId }])
    await expect(readFile(keyring.activePath)).rejects.toThrow(/ENOENT/)
  })

  it('refuses ambiguous or mismatched recovery witnesses before mutation', async () => {
    await expect(
      service().reconcileHistorical({
        expectedKeyId: 'ck_111111111111111111111111',
        apply: false,
      }),
    ).rejects.toThrow(/exactly one active DB projection/)
    await expect(
      service().purgeUnreadable({
        expectedKeyId: 'ck_111111111111111111111111',
        apply: false,
      }),
    ).rejects.toThrow(/exactly one active DB projection/)

    const active = await service().bootstrap()
    await expect(
      service().reconcileHistorical({
        expectedKeyId: 'ck_ffffffffffffffffffffffff',
        apply: false,
      }),
    ).rejects.toThrow(/database names/)
    await expect(
      service().purgeUnreadable({ expectedKeyId: active!.keyId, apply: false }),
    ).rejects.toThrow(/requires a completely missing keyring/)

    await rm(join(keyring.keysDir, `${active!.keyId}.json`))
    await expect(
      service().reconcileHistorical({ expectedKeyId: active!.keyId, apply: false }),
    ).rejects.toThrow(/key file is missing/)
  })

  it('fails loudly when bootstrap conflicts never converge', async () => {
    const alwaysConflicts = persistenceWith({
      admitReadable: async () => ({ status: 'conflict' }),
    })

    await expect(service({ persistence: alwaysConflicts }).bootstrap()).rejects.toThrow(
      /did not converge/,
    )
  })

  it.each([
    {
      label: 'retired pointer target',
      persistence: () =>
        persistenceWith({
          list: async () =>
            (await db.secretKeyring.list()).map((record) => ({
              ...record,
              retiredAt: '2026-08-23T00:00:00.000Z',
            })),
        }),
      message: /names a retired key/,
    },
    {
      label: 'generation mismatch',
      persistence: () =>
        persistenceWith({
          list: async () =>
            (await db.secretKeyring.list()).map((record) => ({
              ...record,
              generation: record.generation + 1,
            })),
        }),
      message: /disagrees with database generation/,
    },
    {
      label: 'projection refusal',
      persistence: () =>
        persistenceWith({
          projectActive: async () => ({ status: 'missing' }),
        }),
      message: /active DB projection failed/,
    },
  ])('degrades on $label instead of admitting provider calls', async ({ persistence, message }) => {
    await service().bootstrap()
    ciphertexts.ciphertext = true
    const degraded = service({ persistence: persistence() })

    await expect(degraded.bootstrap()).resolves.toBeNull()
    expect(degraded.errorMessage()).toMatch(message)
  })

  it('distinguishes a decryptable but wrong canary value from an AEAD error', async () => {
    await service().bootstrap()
    ciphertexts.ciphertext = true
    const active = (await keyring.readActive())!
    const envelope = new CredentialEnvelope(async (keyId) => keyring.readKey(keyId))
    const wrongCanary = envelope.encrypt('wrong-value', active, {
      facet: 'keyring',
      recordId: active.keyId,
      field: 'canary',
    })
    const degraded = service({
      persistence: persistenceWith({
        projectActive: async (input) => {
          const projected = await db.secretKeyring.projectActive(input)
          return projected.status === 'projected'
            ? { ...projected, record: { ...projected.record, canary: wrongCanary } }
            : projected
        },
      }),
    })

    await expect(degraded.bootstrap()).resolves.toBeNull()
    expect(degraded.errorMessage()).toMatch(/canary value does not match/)
  })

  it('republishes a valid prepublication witness after a corrupt empty-set pointer', async () => {
    const active = await service().bootstrap()
    await writeFile(keyring.activePath, '{corrupt')

    await expect(service().bootstrap()).resolves.toMatchObject({ keyId: active!.keyId })
    await expect(readFile(keyring.activePath, 'utf8')).resolves.toContain(active!.keyId)
  })
})
