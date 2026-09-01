import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it } from 'vitest'

import { CREDENTIAL_KEY_STATE } from '../credentialKeyring'
import {
  type ProviderCredentialCiphertexts,
  type ProviderResourceCiphertexts,
  providerUnreadablePlan,
} from './providerCiphertexts'
import { SqliteMetaDb } from './sqliteMetaDb'

const KEY = { keyId: 'ck_111111111111111111111111', generation: 1 }
const ciphertext = (value: string) => `v1.${KEY.keyId}.${Buffer.from(value).toString('base64url')}`

let root = ''
let db: SqliteMetaDb | undefined

afterEach(async () => {
  await db?.close()
  if (root) {
    rmSync(root, { recursive: true, force: true })
  }
})

it('builds the unreadable credential impact in one resources pass at 10k records', () => {
  const count = 10_000
  const credentials: ProviderCredentialCiphertexts[] = Array.from(
    { length: count },
    (_, index) => ({
      id: `credential-${index}`,
      owner: 'alice',
      secret: 'unreadable',
    }),
  )
  let credentialIdReads = 0
  const resources: ProviderResourceCiphertexts[] = Array.from({ length: count }, (_, index) => {
    const credentialId = `credential-${index}`

    return {
      id: `resource-${index}`,
      owner: 'alice',
      headers: {},
      get credentialId() {
        credentialIdReads += 1
        return credentialId
      },
    }
  })

  const plan = providerUnreadablePlan(credentials, resources, new Set())

  expect(plan.affected).toHaveLength(count)
  expect(plan.affected[9_999]).toMatchObject({
    kind: 'credential',
    recordId: 'credential-9999',
    disabledResourceIds: ['resource-9999'],
  })
  expect(credentialIdReads).toBe(count)
})

it('rolls the complete provider recovery back when a late credential delete fails', async () => {
  root = mkdtempSync(join(tmpdir(), 'notarium-provider-recovery-'))
  const path = join(root, 'meta.sqlite')
  db = new SqliteMetaDb(path)
  await db.secretKeyring.replaceNonRetiredWith({
    ...KEY,
    canary: ciphertext('canary'),
    state: CREDENTIAL_KEY_STATE.active,
    createdAt: '2026-08-23T00:00:00.000Z',
    retiredAt: null,
  })

  for (const suffix of ['a', 'b']) {
    await db.credentials.create(
      {
        id: `credential-${suffix}`,
        owner: 'alice',
        name: `Credential ${suffix}`,
        kind: 'bearer',
        secret: ciphertext(`secret-${suffix}`),
        origin: 'https://provider.example',
        injection: { header: '', prefix: 'Bearer ' },
        disabledAt: null,
        rpm: null,
        tpm: null,
        consentEpoch: 0,
        runtimeEpoch: 0,
      },
      KEY,
    )
    await db.providerResources.create(
      {
        id: `resource-${suffix}`,
        owner: 'alice',
        name: `Resource ${suffix}`,
        wire: 'openai-compatible',
        baseUrl: 'https://provider.example/v1',
        headers: { 'x-title': ciphertext(`header-${suffix}`) },
        allowPrivateNetwork: false,
        models: [
          {
            name: 'model-a',
            capabilities: ['completion'],
            dimensions: null,
            statusByCapability: { completion: 'available' },
          },
        ],
        defaultModel: null,
        credentialId: `credential-${suffix}`,
        consentEpoch: 0,
        runtimeEpoch: 0,
        disabledAt: null,
        lastCheck: {},
        firstByteTimeoutMs: 30_000,
        callTimeoutMs: 300_000,
      },
      KEY,
    )
  }
  const raw = new DatabaseSync(path)
  raw.exec(`
    CREATE TRIGGER fail_late_provider_recovery
    BEFORE DELETE ON credentials
    WHEN OLD.id = 'credential-b'
    BEGIN
      SELECT RAISE(ABORT, 'late provider recovery failure');
    END;
  `)
  raw.close()

  await expect(
    db.providerCiphertexts.purgeUnreadable(new Set(), '2026-08-23T01:00:00.000Z'),
  ).rejects.toThrow(/late provider recovery failure/)
  await expect(db.credentials.get('credential-a')).resolves.not.toBeNull()
  await expect(db.credentials.get('credential-b')).resolves.not.toBeNull()
  await expect(db.providerResources.get('resource-a')).resolves.toMatchObject({
    credentialId: 'credential-a',
    runtimeEpoch: 0,
    disabledAt: null,
  })
  await expect(db.providerResources.get('resource-b')).resolves.toMatchObject({
    credentialId: 'credential-b',
    runtimeEpoch: 0,
    disabledAt: null,
  })
})
