import { describe, expect, it } from 'vitest'

import { CREDENTIAL_KEY_STATE } from '../../packages/server/src/services/credentialKeyring'
import type {
  CredentialsPersistence,
  ProviderCiphertextCarrier,
  ProviderCiphertextsPersistence,
  ProviderResourcesPersistence,
  SecretKeyringPersistence,
} from '../../packages/server/src/services/metaDb'

const FIRST = { keyId: 'ck_111111111111111111111111', generation: 1 }
const SECOND = { keyId: 'ck_222222222222222222222222', generation: 2 }
const AT = '2026-08-24T00:00:00.000Z'
const ciphertext = (keyId: string, value: string) =>
  `v1.${keyId}.${Buffer.from(value).toString('base64url')}`

export type ProviderCiphertextsContractFactory = () => Promise<{
  secretKeyring: SecretKeyringPersistence
  credentials: CredentialsPersistence
  resources: ProviderResourcesPersistence
  ciphertexts: ProviderCiphertextsPersistence
  teardown?: () => Promise<void>
}>

export const describeProviderCiphertextsContract = (
  name: string,
  factory: ProviderCiphertextsContractFactory,
): void => {
  describe(`Provider ciphertexts contract — ${name}`, { timeout: 15_000 }, () => {
    it('rewraps deterministic batches and refuses retirement until both carriers are clear', async () => {
      const subject = await factory()

      try {
        await subject.secretKeyring.replaceNonRetiredWith({
          ...FIRST,
          canary: ciphertext(FIRST.keyId, 'canary-1'),
          state: CREDENTIAL_KEY_STATE.active,
          createdAt: AT,
          retiredAt: null,
        })
        await subject.credentials.create(
          {
            id: 'credential-a',
            owner: 'alice',
            name: 'Credential',
            kind: 'bearer',
            secret: ciphertext(FIRST.keyId, 'credential'),
            origin: 'https://provider.example',
            injection: { header: '', prefix: 'Bearer ' },
            disabledAt: null,
            rpm: null,
            tpm: null,
            consentEpoch: 3,
            runtimeEpoch: 5,
          },
          FIRST,
        )
        await subject.resources.create(
          {
            id: 'resource-a',
            owner: 'alice',
            name: 'Resource',
            wire: 'openai-compatible',
            baseUrl: 'https://provider.example/v1',
            headers: {
              'x-a': ciphertext(FIRST.keyId, 'header-a'),
              'x-b': ciphertext(FIRST.keyId, 'header-b'),
            },
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
          FIRST,
        )
        await subject.secretKeyring.admitReadable({
          ...SECOND,
          canary: ciphertext(SECOND.keyId, 'canary-2'),
          state: CREDENTIAL_KEY_STATE.readable,
          createdAt: AT,
          retiredAt: null,
        })
        await subject.secretKeyring.projectActive(SECOND)

        await expect(subject.ciphertexts.countReferences(new Set([FIRST.keyId]))).resolves.toEqual({
          credentials: 1,
          headers: 2,
        })
        await expect(
          subject.ciphertexts.retireKeys({
            active: SECOND,
            sourceKeyIds: new Set([FIRST.keyId]),
            retiredAt: AT,
          }),
        ).resolves.toEqual({
          status: 'references-remain',
          references: { credentials: 1, headers: 2 },
        })
        const seen: ProviderCiphertextCarrier[] = []

        const rewrap = async (carrier: ProviderCiphertextCarrier): Promise<string> => {
          seen.push(carrier)
          return ciphertext(SECOND.keyId, `${carrier.recordId}:${carrier.field}`)
        }

        await expect(
          subject.ciphertexts.rewrapBatch({
            active: SECOND,
            sourceKeyIds: new Set([FIRST.keyId]),
            limit: 2,
            rewrap,
          }),
        ).resolves.toEqual({ rewrapped: { credentials: 1, headers: 1 } })
        expect(seen.map(({ kind, field }) => `${kind}:${field}`)).toEqual([
          'credential:secret',
          'header:x-a',
        ])
        await expect(subject.ciphertexts.countReferences(new Set([FIRST.keyId]))).resolves.toEqual({
          credentials: 0,
          headers: 1,
        })
        await expect(
          subject.ciphertexts.retireKeys({
            active: SECOND,
            sourceKeyIds: new Set([FIRST.keyId]),
            retiredAt: AT,
          }),
        ).resolves.toEqual({
          status: 'references-remain',
          references: { credentials: 0, headers: 1 },
        })
        await subject.ciphertexts.rewrapBatch({
          active: SECOND,
          sourceKeyIds: new Set([FIRST.keyId]),
          limit: 2,
          rewrap,
        })
        await expect(
          subject.ciphertexts.retireKeys({
            active: SECOND,
            sourceKeyIds: new Set([FIRST.keyId]),
            retiredAt: AT,
          }),
        ).resolves.toEqual({
          status: 'retired',
          references: { credentials: 0, headers: 0 },
          retiredKeyIds: [FIRST.keyId],
        })
        expect(await subject.credentials.get('credential-a')).toMatchObject({
          consentEpoch: 3,
          runtimeEpoch: 5,
          secret: expect.stringMatching(new RegExp(`^v1\\.${SECOND.keyId}\\.`)),
        })
        expect(await subject.resources.get('resource-a')).toMatchObject({
          consentEpoch: 7,
          runtimeEpoch: 11,
          headers: {
            'x-a': expect.stringMatching(new RegExp(`^v1\\.${SECOND.keyId}\\.`)),
            'x-b': expect.stringMatching(new RegExp(`^v1\\.${SECOND.keyId}\\.`)),
          },
        })
        expect(
          (await subject.secretKeyring.list()).find((row) => row.keyId === FIRST.keyId)?.retiredAt,
        ).toBe(AT)
      } finally {
        await subject.teardown?.()
      }
    })
  })
}
