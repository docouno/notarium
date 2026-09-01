import { describe, expect, it } from 'vitest'
import { ATTACHMENT_STATE, DEFAULT_CREDENTIAL_HEADER, MODEL_STATUS } from '@notarium/contract'

import { CREDENTIAL_KEY_STATE } from '../../packages/server/src/services/credentialKeyring'
import type {
  AuthPersistence,
  CredentialRecord,
  CredentialsPersistence,
  ProviderAttachmentLifecyclePersistence,
  ProviderAttachmentRecord,
  ProviderAttachmentsPersistence,
  ProviderCiphertextsPersistence,
  ProviderResourceRecord,
  ProviderResourcesPersistence,
  ProviderRetargetInput,
  ProviderRetargetResult,
  SecretKeyringPersistence,
  SpacesPersistence,
} from '../../packages/server/src/services/metaDb'
import { providerDisclosureOf } from '../../packages/server/src/services/providerRegistry'

const KEY = { keyId: 'ck_111111111111111111111111', generation: 1 }
const ciphertext = (field: string) => `v1.${KEY.keyId}.${Buffer.from(field).toString('base64url')}`

const fullModel = (
  name: string,
  ...capabilities: Array<'completion' | 'embedding'>
): ProviderResourceRecord['models'][number] => {
  const selected = capabilities.length ? capabilities : ['completion' as const]

  return {
    name,
    capabilities: selected,
    dimensions: null,
    statusByCapability: Object.fromEntries(
      selected.map((capability) => [capability, MODEL_STATUS.available]),
    ),
  }
}

const credential = (over: Partial<CredentialRecord> = {}): CredentialRecord => ({
  id: 'credential-a',
  owner: 'alice',
  name: 'Primary',
  kind: 'bearer',
  secret: ciphertext('credential'),
  origin: 'https://provider.example',
  injection: { header: '', prefix: 'Bearer ' },
  disabledAt: null,
  rpm: null,
  tpm: null,
  consentEpoch: 0,
  runtimeEpoch: 0,
  ...over,
})

const resource = (over: Partial<ProviderResourceRecord> = {}): ProviderResourceRecord => ({
  id: 'resource-a',
  owner: 'alice',
  name: 'Primary resource',
  wire: 'openai-compatible',
  baseUrl: 'https://provider.example/v1',
  headers: { 'x-title': ciphertext('header') },
  allowPrivateNetwork: false,
  models: [fullModel('model-a')],
  defaultModel: null,
  credentialId: 'credential-a',
  consentEpoch: 0,
  runtimeEpoch: 0,
  disabledAt: null,
  lastCheck: {},
  firstByteTimeoutMs: null,
  callTimeoutMs: null,
  ...over,
})

const attachment = (over: Partial<ProviderAttachmentRecord> = {}): ProviderAttachmentRecord => ({
  id: 'attachment-a',
  resourceId: 'resource-a',
  targetKind: 'space',
  targetId: 'space-a',
  targetSpace: 'space-a',
  state: ATTACHMENT_STATE.pending,
  resourceEpoch: null,
  credentialEpoch: null,
  disclosure: null,
  createdAt: '2026-08-23T00:00:00.000Z',
  expiresAt: '2026-09-06T00:00:00.000Z',
  ...over,
})

export type ProviderFacetsContractFactory = () => Promise<{
  secretKeyring: SecretKeyringPersistence
  credentials: CredentialsPersistence
  resources: ProviderResourcesPersistence
  attachments: ProviderAttachmentsPersistence
  lifecycle: ProviderAttachmentLifecyclePersistence
  ciphertexts: ProviderCiphertextsPersistence
  spaces: SpacesPersistence
  auth: Pick<AuthPersistence, 'createUser' | 'upsertMember' | 'grantsFor'>
  retargetProviderCredential(input: ProviderRetargetInput): Promise<ProviderRetargetResult>
  removeMemberAndProviderAttachments(space: string, username: string): Promise<void>
  purgeSpace(space: string): Promise<void>
  teardown?: () => Promise<void>
}>

const setup = async (factory: ProviderFacetsContractFactory) => {
  const subject = await factory()
  await subject.secretKeyring.replaceNonRetiredWith({
    ...KEY,
    canary: ciphertext('canary'),
    state: CREDENTIAL_KEY_STATE.active,
    createdAt: '2026-08-23T00:00:00.000Z',
    retiredAt: null,
  })
  await subject.spaces.upsert({
    id: 'space-a',
    slug: 'space-a',
    displayName: 'Space A',
    notesDir: 'space-a',
    aliases: [],
    createdAt: '2026-08-23T00:00:00.000Z',
    archivedAt: null,
    archivedBy: null,
  })
  await subject.auth.createUser({
    username: 'alice',
    displayName: 'Alice',
    passwordHash: null,
    admin: false,
    disabledAt: null,
    createdAt: '2026-08-23T00:00:00.000Z',
    personalSpace: null,
  })
  await subject.auth.upsertMember('space-a', 'alice', 'owner', '2026-08-23T00:00:00.000Z')
  return subject
}

export const describeProviderFacetsContract = (
  name: string,
  factory: ProviderFacetsContractFactory,
): void => {
  describe(`Provider facets contract — ${name}`, { timeout: 15_000 }, () => {
    it('enforces owner-local credential names and the active-key writer fence', async () => {
      const subject = await setup(factory)

      try {
        await subject.credentials.create(credential(), KEY)
        await expect(
          subject.credentials.create(credential({ id: 'credential-duplicate' }), KEY),
        ).rejects.toThrow(/unique/i)
        await expect(
          subject.credentials.create(credential({ id: 'credential-neighbour', owner: 'bob' }), KEY),
        ).resolves.toBeUndefined()
        await expect(
          subject.credentials.create(credential({ id: 'credential-stale', name: 'Stale' }), {
            keyId: 'ck_222222222222222222222222',
            generation: 2,
          }),
        ).rejects.toMatchObject({ code: 'PROVIDER_STALE_CIPHERTEXT_KEY' })
      } finally {
        await subject.teardown?.()
      }
    })

    it('pages provider inventories by key before hydration and filters expired offers', async () => {
      const subject = await setup(factory)

      try {
        for (let index = 0; index < 4; index += 1) {
          const suffix = String(index).padStart(2, '0')
          await subject.credentials.create(
            credential({ id: `credential-${suffix}`, name: `Credential ${suffix}` }),
            KEY,
          )
          await subject.resources.create(
            resource({
              id: `resource-${suffix}`,
              name: `Resource ${suffix}`,
              credentialId: null,
              headers: {},
            }),
            null,
          )
          const offered = await subject.lifecycle.offerProviderAttachment(
            attachment({
              id: `attachment-${suffix}`,
              resourceId: `resource-${suffix}`,
              createdAt: `2026-08-23T00:00:${suffix}.000Z`,
            }),
            providerDisclosureOf,
          )
          expect(offered.status).toBe('offered')
          await subject.lifecycle.acceptProviderAttachment(
            {
              id: `attachment-${suffix}`,
              expectedResourceEpoch: 0,
              expectedCredentialEpoch: null,
              acceptedAt: '2026-08-24T00:00:00.000Z',
              manager: null,
            },
            providerDisclosureOf,
          )
        }
        await subject.auth.createUser({
          username: 'expiry-owner',
          displayName: 'Expiry Owner',
          passwordHash: null,
          admin: false,
          disabledAt: null,
          createdAt: '2026-08-23T00:00:00.000Z',
          personalSpace: null,
        })
        await subject.auth.upsertMember(
          'space-a',
          'expiry-owner',
          'writer',
          '2026-08-23T00:00:00.000Z',
        )
        await subject.resources.create(
          resource({
            id: 'resource-expired',
            owner: 'expiry-owner',
            name: 'Expired resource',
            credentialId: null,
            headers: {},
          }),
          null,
        )
        await subject.lifecycle.offerProviderAttachment(
          attachment({
            id: 'attachment-expired',
            resourceId: 'resource-expired',
            createdAt: '2026-08-24T00:00:00.000Z',
            expiresAt: '2026-08-25T00:00:00.000Z',
          }),
          providerDisclosureOf,
        )

        await expect(
          subject.credentials.pageIdsForOwner('alice', { after: null, limit: 2 }),
        ).resolves.toEqual({ ids: ['credential-00', 'credential-01'], total: 4 })
        await expect(
          subject.credentials.pageIdsForOwner('alice', {
            after: { sort: 'Credential 01', id: 'credential-01' },
            limit: 2,
          }),
        ).resolves.toEqual({ ids: ['credential-02', 'credential-03'], total: 4 })
        await expect(
          subject.resources.pageIdsForOwner('alice', {
            after: { sort: 'Resource 01', id: 'resource-01' },
            limit: 2,
          }),
        ).resolves.toEqual({ ids: ['resource-02', 'resource-03'], total: 4 })
        await expect(
          subject.resources.pageEffectiveIds('bob', ['space-a'], {
            after: { sort: 'Resource 01', id: 'resource-01' },
            limit: 2,
          }),
        ).resolves.toEqual({ ids: ['resource-02', 'resource-03'], total: 4 })
        await expect(
          subject.resources.scanEffectivePage('bob', ['space-a'], {
            after: { sort: 'Resource 01', id: 'resource-01' },
            limit: 2,
          }),
        ).resolves.toEqual({
          positions: [
            { sort: 'Resource 02', id: 'resource-02' },
            { sort: 'Resource 03', id: 'resource-03' },
          ],
          hasMore: false,
        })
        await expect(
          subject.attachments.pageIdsForSpace('space-a', '2026-08-26T00:00:00.000Z', {
            after: { sort: '2026-08-23T00:00:01.000Z', id: 'attachment-01' },
            limit: 2,
          }),
        ).resolves.toEqual({ ids: ['attachment-02', 'attachment-03'], total: 4 })
      } finally {
        await subject.teardown?.()
      }
    })

    it('uses the same bytewise cursor order for non-ASCII names', async () => {
      const subject = await setup(factory)
      const names = [
        ['emoji', '😀 Gamma'],
        ['zulu', 'Zulu'],
        ['aring', 'Ångström'],
        ['replacement', '� replacement'],
      ] as const

      try {
        for (const [id, resourceName] of names) {
          await subject.credentials.create(
            credential({ id: `credential-${id}`, name: resourceName }),
            KEY,
          )
          await subject.resources.create(
            resource({
              id: `resource-${id}`,
              name: resourceName,
              credentialId: null,
              headers: {},
            }),
            null,
          )
        }
        const expectedCredentials = [
          'credential-zulu',
          'credential-aring',
          'credential-replacement',
          'credential-emoji',
        ]
        const expectedResources = expectedCredentials.map((id) =>
          id.replace('credential', 'resource'),
        )

        await expect(
          subject.credentials.pageIdsForOwner('alice', { after: null, limit: 10 }),
        ).resolves.toEqual({ ids: expectedCredentials, total: 4 })
        await expect(
          subject.resources.pageIdsForOwner('alice', { after: null, limit: 10 }),
        ).resolves.toEqual({ ids: expectedResources, total: 4 })
        await expect(
          subject.resources.pageEffectiveIds('alice', [], {
            after: { sort: 'Ångström', id: 'resource-aring' },
            limit: 10,
          }),
        ).resolves.toEqual({ ids: expectedResources.slice(2), total: 4 })
        await expect(
          subject.resources.scanEffectivePage('alice', [], { after: null, limit: 2 }),
        ).resolves.toEqual({
          positions: [
            { sort: 'Zulu', id: 'resource-zulu' },
            { sort: 'Ångström', id: 'resource-aring' },
          ],
          hasMore: true,
        })
      } finally {
        await subject.teardown?.()
      }
    })

    it('enforces R1/R2, nullable credentials, and FK delete semantics', async () => {
      const subject = await setup(factory)

      try {
        await subject.credentials.create(credential(), KEY)
        await expect(subject.resources.create(resource(), KEY)).resolves.toBeUndefined()
        await expect(
          subject.resources.create(
            resource({ id: 'resource-other-owner', name: 'Other owner', owner: 'bob' }),
            KEY,
          ),
        ).rejects.toMatchObject({ code: 'PROVIDER_CREDENTIAL_NOT_OWNED' })
        await expect(
          subject.resources.create(
            resource({
              id: 'resource-other-origin',
              name: 'Other origin',
              baseUrl: 'https://other.example',
            }),
            KEY,
          ),
        ).rejects.toMatchObject({ code: 'PROVIDER_CREDENTIAL_ORIGIN_MISMATCH' })
        await expect(
          subject.resources.create(
            resource({
              id: 'resource-no-credential',
              name: 'No credential',
              baseUrl: 'https://other.example',
              credentialId: null,
              headers: {},
            }),
            null,
          ),
        ).resolves.toBeUndefined()
        await expect(
          subject.credentials.deleteIfUnreferenced('credential-a'),
        ).resolves.toMatchObject({
          status: 'referenced',
          references: [{ id: 'resource-a' }],
        })
      } finally {
        await subject.teardown?.()
      }
    })

    it('merges concurrent capability measurements without changing runtimeEpoch', async () => {
      const subject = await setup(factory)

      try {
        await subject.credentials.create(credential(), KEY)
        await subject.resources.create(
          resource({ headers: {}, models: [fullModel('multi', 'completion', 'embedding')] }),
          null,
        )
        await expect(subject.resources.get('resource-a')).resolves.toMatchObject({
          firstByteTimeoutMs: null,
          callTimeoutMs: null,
        })
        const check = {
          status: 'ready' as const,
          checkedAt: '2026-08-24T00:00:00.000Z',
          diagnostic: null,
          credentialProven: true,
        }
        const [first, second] = await Promise.all([
          subject.resources.recordLastCheck({
            resourceId: 'resource-a',
            capability: 'completion',
            lastCheck: check,
            measurement: { modelName: 'multi', status: MODEL_STATUS.available },
            expectedRuntimeEpoch: 0,
            expectedCredentialId: 'credential-a',
            expectedCredentialRuntimeEpoch: 0,
          }),
          subject.resources.recordLastCheck({
            resourceId: 'resource-a',
            capability: 'embedding',
            lastCheck: check,
            measurement: {
              modelName: 'multi',
              status: MODEL_STATUS.available,
              dimensions: 768,
            },
            expectedRuntimeEpoch: 0,
            expectedCredentialId: 'credential-a',
            expectedCredentialRuntimeEpoch: 0,
          }),
        ])
        expect(first.status).toBe('recorded')
        expect(second.status).toBe('recorded')
        expect(await subject.resources.get('resource-a')).toMatchObject({
          models: [
            {
              name: 'multi',
              dimensions: 768,
              statusByCapability: { completion: 'available', embedding: 'available' },
            },
          ],
          lastCheck: { completion: { status: 'ready' }, embedding: { status: 'ready' } },
        })
        expect((await subject.resources.get('resource-a'))?.runtimeEpoch).toBe(0)
      } finally {
        await subject.teardown?.()
      }
    })

    it('conditionally replaces a resource only at the runtime epoch the caller read', async () => {
      const subject = await setup(factory)

      try {
        await subject.credentials.create(credential(), KEY)
        await subject.resources.create(resource({ headers: {} }), null)
        await expect(
          subject.resources.replaceIfRuntimeEpoch(
            { ...resource({ headers: {} }), callTimeoutMs: 120_000, runtimeEpoch: 1 },
            null,
            0,
            'credential-a',
          ),
        ).resolves.toMatchObject({ status: 'replaced', record: { runtimeEpoch: 1 } })
        await expect(
          subject.resources.replaceIfRuntimeEpoch(
            { ...resource({ headers: {} }), firstByteTimeoutMs: 60_000, runtimeEpoch: 1 },
            null,
            0,
            'credential-a',
          ),
        ).resolves.toMatchObject({
          status: 'conflict',
          record: { callTimeoutMs: 120_000, runtimeEpoch: 1 },
        })
      } finally {
        await subject.teardown?.()
      }
    })

    it('preserves a concurrent measurement under an authored non-model patch', async () => {
      const subject = await setup(factory)

      try {
        await subject.credentials.create(credential(), KEY)
        await subject.resources.create(
          resource({
            headers: {},
            models: [fullModel('model-a', 'embedding')],
          }),
          null,
        )
        const stale = (await subject.resources.get('resource-a'))!

        await subject.resources.recordLastCheck({
          resourceId: 'resource-a',
          capability: 'embedding',
          lastCheck: {
            status: 'not-configured',
            checkedAt: '2026-08-24T00:00:00.000Z',
            diagnostic: null,
            credentialProven: false,
          },
          measurement: {
            modelName: 'model-a',
            dimensions: 1536,
            status: MODEL_STATUS.unavailable,
          },
          expectedRuntimeEpoch: 0,
          expectedCredentialId: 'credential-a',
          expectedCredentialRuntimeEpoch: 0,
        })
        await expect(
          subject.resources.replaceIfRuntimeEpoch(
            { ...stale, name: 'Renamed' },
            null,
            stale.runtimeEpoch,
            stale.credentialId,
          ),
        ).resolves.toMatchObject({
          status: 'replaced',
          record: {
            name: 'Renamed',
            models: [
              {
                name: 'model-a',
                dimensions: 1536,
                statusByCapability: { embedding: MODEL_STATUS.unavailable },
              },
            ],
          },
        })
      } finally {
        await subject.teardown?.()
      }
    })

    it('mutates credential epochs and invalidates references in one RMW', async () => {
      const subject = await setup(factory)

      try {
        await subject.credentials.create(credential(), KEY)
        await subject.resources.create(
          resource({
            lastCheck: {
              completion: {
                status: 'ready',
                checkedAt: '2026-08-24T00:00:00.000Z',
                diagnostic: null,
                credentialProven: true,
              },
            },
          }),
          KEY,
        )
        const validateReferences = (
          next: CredentialRecord,
          references: readonly ProviderResourceRecord[],
        ) =>
          references
            .filter((candidate) => {
              const header =
                next.injection.header || DEFAULT_CREDENTIAL_HEADER[next.kind][candidate.wire]
              return (
                new URL(candidate.baseUrl).origin !== next.origin ||
                Object.hasOwn(candidate.headers, header)
              )
            })
            .map((candidate) => candidate.id)

        await expect(
          subject.credentials.mutate({
            id: 'credential-a',
            expectedRuntimeEpoch: 0,
            changes: { origin: 'https://other.example' },
            ciphertext: null,
            runtimeChanged: true,
            consentChanged: true,
            validateReferences,
          }),
        ).resolves.toMatchObject({
          status: 'references-invalid',
          references: [{ id: 'resource-a' }],
        })
        await expect(subject.credentials.get('credential-a')).resolves.toMatchObject({
          origin: 'https://provider.example',
          runtimeEpoch: 0,
          consentEpoch: 0,
        })

        await expect(
          subject.credentials.mutate({
            id: 'credential-a',
            expectedRuntimeEpoch: 0,
            changes: { disabledAt: '2026-08-24T01:00:00.000Z' },
            ciphertext: null,
            runtimeChanged: true,
            consentChanged: false,
            validateReferences,
          }),
        ).resolves.toMatchObject({
          status: 'updated',
          record: { runtimeEpoch: 1, consentEpoch: 0 },
        })
        expect((await subject.resources.get('resource-a'))?.lastCheck).toEqual({})
      } finally {
        await subject.teardown?.()
      }
    })

    it('records a validate outcome per capability and applies its field delta at once', async () => {
      const subject = await setup(factory)

      try {
        await subject.credentials.create(credential(), KEY)
        await subject.resources.create(
          resource({
            models: [fullModel('multi-1', 'completion', 'embedding')],
          }),
          KEY,
        )
        await expect(
          subject.resources.recordLastCheck({
            resourceId: 'resource-a',
            capability: 'completion',
            lastCheck: {
              status: 'ready',
              checkedAt: '2026-08-24T00:00:00.000Z',
              diagnostic: null,
              credentialProven: true,
            },
            measurement: null,
            expectedRuntimeEpoch: 0,
            expectedCredentialId: 'credential-a',
            expectedCredentialRuntimeEpoch: 0,
          }),
        ).resolves.toMatchObject({ status: 'recorded' })
        await expect(
          subject.resources.recordLastCheck({
            resourceId: 'resource-a',
            capability: 'embedding',
            lastCheck: {
              status: 'unreachable',
              checkedAt: '2026-08-24T00:01:00.000Z',
              diagnostic: 'no embedding endpoint',
              credentialProven: false,
            },
            measurement: {
              modelName: 'multi-1',
              dimensions: 768,
              status: MODEL_STATUS.available,
            },
            expectedRuntimeEpoch: 0,
            expectedCredentialId: 'credential-a',
            expectedCredentialRuntimeEpoch: 0,
          }),
        ).resolves.toMatchObject({ status: 'recorded' })
        // The sibling capability survives: the column is a collection, and a blind
        // UPDATE of it would drop the other outcome.
        await expect(subject.resources.get('resource-a')).resolves.toMatchObject({
          lastCheck: {
            completion: { status: 'ready', credentialProven: true },
            embedding: { status: 'unreachable', diagnostic: 'no embedding endpoint' },
          },
          models: [{ name: 'multi-1', dimensions: 768 }],
        })
      } finally {
        await subject.teardown?.()
      }
    })

    it('refuses a validate outcome whose captured epochs moved on either row', async () => {
      const subject = await setup(factory)

      try {
        await subject.credentials.create(credential(), KEY)
        await subject.resources.create(resource({ models: [] }), KEY)
        const outcome = {
          status: 'ready' as const,
          checkedAt: '2026-08-24T00:00:00.000Z',
          diagnostic: null,
          credentialProven: true,
        }
        // A secret rotation moves NO resource field, so a resource-only condition
        // would let this stale outcome land on a credential that no longer exists.
        await expect(
          subject.credentials.mutate({
            id: 'credential-a',
            expectedRuntimeEpoch: 0,
            changes: { secret: ciphertext('rotated') },
            ciphertext: KEY,
            runtimeChanged: true,
            consentChanged: false,
            validateReferences: () => [],
          }),
        ).resolves.toMatchObject({ status: 'updated', record: { runtimeEpoch: 1 } })
        await expect(
          subject.resources.recordLastCheck({
            resourceId: 'resource-a',
            capability: 'embedding',
            lastCheck: outcome,
            measurement: {
              modelName: 'ghost',
              dimensions: 4,
              status: MODEL_STATUS.available,
            },
            expectedRuntimeEpoch: 0,
            expectedCredentialId: 'credential-a',
            expectedCredentialRuntimeEpoch: 0,
          }),
        ).resolves.toMatchObject({ status: 'stale' })
        const untouched = await subject.resources.get('resource-a')

        expect(untouched?.lastCheck).toEqual({})
        expect(untouched?.models).toEqual([])

        await expect(
          subject.resources.recordLastCheck({
            resourceId: 'resource-a',
            capability: 'completion',
            lastCheck: outcome,
            measurement: null,
            expectedRuntimeEpoch: 1,
            expectedCredentialId: 'credential-a',
            expectedCredentialRuntimeEpoch: 1,
          }),
        ).resolves.toMatchObject({ status: 'stale' })
        await expect(
          subject.resources.recordLastCheck({
            resourceId: 'missing-resource',
            capability: 'completion',
            lastCheck: outcome,
            measurement: null,
            expectedRuntimeEpoch: 0,
            expectedCredentialId: null,
            expectedCredentialRuntimeEpoch: null,
          }),
        ).resolves.toMatchObject({ status: 'missing' })
      } finally {
        await subject.teardown?.()
      }
    })

    it('keeps concurrent resource insert and credential delete free of dangling references', async () => {
      const subject = await setup(factory)

      try {
        await subject.credentials.create(credential(), KEY)
        const [created, deleted] = await Promise.allSettled([
          subject.resources.create(resource(), KEY),
          Promise.resolve().then(() => subject.credentials.deleteIfUnreferenced('credential-a')),
        ])
        const storedCredential = await subject.credentials.get('credential-a')
        const storedResource = await subject.resources.get('resource-a')

        if (storedResource) {
          expect(storedCredential).not.toBeNull()
          expect(deleted).toMatchObject({
            status: 'fulfilled',
            value: { status: 'referenced', references: [{ id: 'resource-a' }] },
          })
        } else {
          expect(storedCredential).toBeNull()
          expect(created.status).toBe('rejected')
          expect(deleted).toMatchObject({ status: 'fulfilled', value: { status: 'deleted' } })
        }
      } finally {
        await subject.teardown?.()
      }
    })

    it('rechecks credential injection at the persistence boundary', async () => {
      const subject = await setup(factory)

      try {
        await subject.credentials.create(
          credential({ injection: { header: 'x-api-key', prefix: '' } }),
          KEY,
        )
        await expect(
          subject.resources.create(
            resource({ headers: { 'x-api-key': ciphertext('header') } }),
            KEY,
          ),
        ).rejects.toMatchObject({ code: 'PROVIDER_CREDENTIAL_INJECTION_COLLISION' })
      } finally {
        await subject.teardown?.()
      }
    })

    it('serializes reverse injection validation against a referencing resource PATCH', async () => {
      const subject = await setup(factory)

      try {
        await subject.credentials.create(credential(), KEY)
        await subject.resources.create(resource({ headers: {} }), null)
        const validateReferences = (
          next: CredentialRecord,
          references: readonly ProviderResourceRecord[],
        ) =>
          references
            .filter((candidate) => {
              const header =
                next.injection.header || DEFAULT_CREDENTIAL_HEADER[next.kind][candidate.wire]
              return Object.hasOwn(candidate.headers, header)
            })
            .map((candidate) => candidate.id)
        const [credentialMutation, resourceMutation] = await Promise.allSettled([
          subject.credentials.mutate({
            id: 'credential-a',
            expectedRuntimeEpoch: 0,
            changes: { injection: { header: 'x-api-key', prefix: '' } },
            ciphertext: null,
            runtimeChanged: true,
            consentChanged: true,
            validateReferences,
          }),
          subject.resources.replaceIfRuntimeEpoch(
            resource({
              headers: { 'x-api-key': ciphertext('header') },
              runtimeEpoch: 1,
              lastCheck: {},
            }),
            KEY,
            0,
            'credential-a',
          ),
        ])
        const storedCredential = (await subject.credentials.get('credential-a'))!
        const storedResource = (await subject.resources.get('resource-a'))!

        expect(
          storedCredential.injection.header === 'x-api-key' &&
            Object.hasOwn(storedResource.headers, 'x-api-key'),
        ).toBe(false)
        if (
          credentialMutation.status === 'fulfilled' &&
          credentialMutation.value.status === 'updated'
        ) {
          expect(resourceMutation.status).toBe('rejected')
        } else {
          expect(credentialMutation).toMatchObject({
            status: 'fulfilled',
            value: { status: 'references-invalid' },
          })
          expect(resourceMutation).toMatchObject({
            status: 'fulfilled',
            value: { status: 'replaced' },
          })
        }
      } finally {
        await subject.teardown?.()
      }
    })

    it('deduplicates pending offers, cascades resource delete, and purges only space rows', async () => {
      const subject = await setup(factory)

      try {
        await subject.credentials.create(credential(), KEY)
        await subject.resources.create(resource({ headers: {} }), null)
        const first = await subject.lifecycle.offerProviderAttachment(
          attachment(),
          providerDisclosureOf,
        )
        const second = await subject.lifecycle.offerProviderAttachment(
          attachment({ id: 'attachment-duplicate', expiresAt: '2026-09-07T00:00:00.000Z' }),
          providerDisclosureOf,
        )

        if (first.status !== 'offered') {
          throw new Error(`expected initial provider offer, got ${first.status}`)
        }
        expect(second).toMatchObject({ status: 'offered', record: { id: first.record.id } })
        expect(await subject.attachments.listForResource('resource-a')).toHaveLength(1)

        await subject.purgeSpace('space-a')
        expect(await subject.attachments.listForSpace('space-a')).toEqual([])
        expect(await subject.resources.get('resource-a')).not.toBeNull()
        expect(await subject.credentials.get('credential-a')).not.toBeNull()

        await subject.spaces.upsert({
          id: 'space-b',
          slug: 'space-b',
          displayName: 'Space B',
          notesDir: 'space-b',
          aliases: [],
          createdAt: '2026-08-23T00:00:00.000Z',
          archivedAt: null,
          archivedBy: null,
        })
        await subject.lifecycle.offerProviderAttachment(
          attachment({
            id: 'attachment-after-purge',
            targetId: 'space-b',
            targetSpace: 'space-b',
          }),
          providerDisclosureOf,
        )
        await subject.resources.delete('resource-a')
        expect(await subject.attachments.listForResource('resource-a')).toEqual([])
      } finally {
        await subject.teardown?.()
      }
    })

    it('refuses a late offer after the target space purge fence', async () => {
      const subject = await setup(factory)

      try {
        await subject.credentials.create(credential(), KEY)
        await subject.resources.create(resource({ headers: {} }), null)
        await subject.purgeSpace('space-a')
        await expect(
          subject.lifecycle.offerProviderAttachment(attachment(), providerDisclosureOf),
        ).resolves.toEqual({ status: 'target-gone' })
      } finally {
        await subject.teardown?.()
      }
    })

    it('runs acceptance as a conditional automaton and preserves accepted evidence', async () => {
      const subject = await setup(factory)

      try {
        await subject.credentials.create(credential(), KEY)
        await subject.resources.create(resource({ headers: {} }), null)
        const offered = await subject.lifecycle.offerProviderAttachment(
          attachment(),
          providerDisclosureOf,
        )

        expect(offered).toMatchObject({ status: 'offered', record: { state: 'pending' } })
        await expect(
          subject.lifecycle.acceptProviderAttachment(
            {
              id: 'attachment-a',
              expectedResourceEpoch: 0,
              expectedCredentialEpoch: 0,
              acceptedAt: '2026-08-24T00:00:00.000Z',
              manager: 'bob',
            },
            providerDisclosureOf,
          ),
        ).resolves.toEqual({ status: 'owner-not-member' })
        const accepted = await subject.lifecycle.acceptProviderAttachment(
          {
            id: 'attachment-a',
            expectedResourceEpoch: 0,
            expectedCredentialEpoch: 0,
            acceptedAt: '2026-08-24T00:00:00.000Z',
            manager: 'alice',
          },
          providerDisclosureOf,
        )
        expect(accepted).toMatchObject({
          status: 'accepted',
          record: {
            state: 'active',
            resourceEpoch: 0,
            credentialEpoch: 0,
            disclosure: { baseUrl: 'https://provider.example/v1' },
          },
        })
        await expect(
          subject.lifecycle.acceptProviderAttachment(
            {
              id: 'attachment-a',
              expectedResourceEpoch: 0,
              expectedCredentialEpoch: 0,
              acceptedAt: '2026-08-24T00:00:00.000Z',
              manager: 'alice',
            },
            providerDisclosureOf,
          ),
        ).resolves.toMatchObject({ status: 'already-active' })
        const beforeRepeat = await subject.attachments.get('attachment-a')
        await expect(
          subject.lifecycle.offerProviderAttachment(
            attachment({ createdAt: '2026-08-24T01:00:00.000Z' }),
            providerDisclosureOf,
          ),
        ).resolves.toMatchObject({ status: 'already-attached' })
        await expect(subject.attachments.get('attachment-a')).resolves.toEqual(beforeRepeat)
      } finally {
        await subject.teardown?.()
      }
    })

    it('moves only accepted grants on a consent epoch bump and rejects stale acceptance', async () => {
      const subject = await setup(factory)

      try {
        await subject.credentials.create(credential(), KEY)
        await subject.resources.create(resource({ headers: {} }), null)
        await subject.lifecycle.offerProviderAttachment(attachment(), providerDisclosureOf)
        await subject.lifecycle.acceptProviderAttachment(
          {
            id: 'attachment-a',
            expectedResourceEpoch: 0,
            expectedCredentialEpoch: 0,
            acceptedAt: '2026-08-24T00:00:00.000Z',
            manager: 'alice',
          },
          providerDisclosureOf,
        )
        await subject.lifecycle.offerProviderAttachment(
          attachment({
            id: 'attachment-pending',
            targetKind: 'project',
            targetId: 'project-a',
          }),
          providerDisclosureOf,
        )
        await expect(
          subject.resources.replaceIfRuntimeEpoch(
            {
              ...resource({ headers: {} }),
              baseUrl: 'https://provider.example/v2',
              consentEpoch: 1,
              runtimeEpoch: 1,
              lastCheck: {},
            },
            null,
            0,
            'credential-a',
          ),
        ).resolves.toMatchObject({ status: 'replaced' })
        await expect(subject.attachments.get('attachment-a')).resolves.toMatchObject({
          state: 'awaiting-reconsent',
          disclosure: { baseUrl: 'https://provider.example/v1' },
        })
        await expect(subject.attachments.get('attachment-pending')).resolves.toMatchObject({
          state: 'pending',
        })
        await expect(
          subject.lifecycle.acceptProviderAttachment(
            {
              id: 'attachment-a',
              expectedResourceEpoch: 0,
              expectedCredentialEpoch: 0,
              acceptedAt: '2026-08-24T01:00:00.000Z',
              manager: 'alice',
            },
            providerDisclosureOf,
          ),
        ).resolves.toMatchObject({ status: 'epoch-conflict', resource: { consentEpoch: 1 } })
      } finally {
        await subject.teardown?.()
      }
    })

    it('keeps system writes and every named inert credential operation out of consent', async () => {
      const subject = await setup(factory)

      try {
        await subject.credentials.create(credential(), KEY)
        await subject.resources.create(resource({ headers: {} }), null)
        await subject.lifecycle.offerProviderAttachment(attachment(), providerDisclosureOf)
        await subject.lifecycle.acceptProviderAttachment(
          {
            id: 'attachment-a',
            expectedResourceEpoch: 0,
            expectedCredentialEpoch: 0,
            acceptedAt: '2026-08-24T00:00:00.000Z',
            manager: 'alice',
          },
          providerDisclosureOf,
        )
        await subject.resources.recordLastCheck({
          resourceId: 'resource-a',
          capability: 'completion',
          lastCheck: {
            status: 'ready',
            checkedAt: '2026-08-24T00:01:00.000Z',
            diagnostic: null,
            credentialProven: true,
          },
          measurement: { modelName: 'model-a', status: MODEL_STATUS.available },
          expectedRuntimeEpoch: 0,
          expectedCredentialId: 'credential-a',
          expectedCredentialRuntimeEpoch: 0,
        })
        for (const [changes, expectedRuntimeEpoch] of [
          [{ secret: ciphertext('rotated') }, 0],
          [{ rpm: 20 }, 1],
          [{ disabledAt: '2026-08-24T01:00:00.000Z' }, 2],
          [{ disabledAt: null }, 3],
        ] as const) {
          await expect(
            subject.credentials.mutate({
              id: 'credential-a',
              expectedRuntimeEpoch,
              changes,
              ciphertext: Object.hasOwn(changes, 'secret') ? KEY : null,
              runtimeChanged: true,
              consentChanged: false,
              validateReferences: () => [],
            }),
          ).resolves.toMatchObject({ status: 'updated', record: { consentEpoch: 0 } })
        }
        await expect(subject.attachments.get('attachment-a')).resolves.toMatchObject({
          state: 'active',
          resourceEpoch: 0,
          credentialEpoch: 0,
        })
      } finally {
        await subject.teardown?.()
      }
    })

    it('rejects an expired pending offer without rewriting it', async () => {
      const subject = await setup(factory)

      try {
        await subject.credentials.create(credential(), KEY)
        await subject.resources.create(resource({ headers: {} }), null)
        await subject.lifecycle.offerProviderAttachment(
          attachment({ expiresAt: '2026-08-23T01:00:00.000Z' }),
          providerDisclosureOf,
        )
        await expect(
          subject.lifecycle.acceptProviderAttachment(
            {
              id: 'attachment-a',
              expectedResourceEpoch: 0,
              expectedCredentialEpoch: 0,
              acceptedAt: '2026-08-24T00:00:00.000Z',
              manager: 'alice',
            },
            providerDisclosureOf,
          ),
        ).resolves.toMatchObject({ status: 'expired', record: { state: 'pending' } })
        await expect(subject.attachments.get('attachment-a')).resolves.toMatchObject({
          state: 'pending',
          disclosure: null,
        })
      } finally {
        await subject.teardown?.()
      }
    })

    it('retargets every reference atomically, resets checks, and increments epochs once', async () => {
      const subject = await setup(factory)

      try {
        await subject.credentials.create(credential(), KEY)
        for (const record of [
          resource({
            id: 'resource-a',
            name: 'A',
            lastCheck: {
              completion: {
                status: 'ready',
                checkedAt: '2026-08-24T00:00:00.000Z',
                diagnostic: null,
                credentialProven: true,
              },
            },
          }),
          resource({
            id: 'resource-b',
            name: 'B',
            lastCheck: {
              completion: {
                status: 'ready',
                checkedAt: '2026-08-24T00:00:00.000Z',
                diagnostic: null,
                credentialProven: true,
              },
            },
          }),
        ]) {
          await subject.resources.create(record, KEY)
          await subject.lifecycle.offerProviderAttachment(
            attachment({
              id: `attachment-${record.id}`,
              resourceId: record.id,
              targetKind: record.id === 'resource-a' ? 'space' : 'project',
              targetId: record.id === 'resource-a' ? 'space-a' : 'project-a',
            }),
            providerDisclosureOf,
          )
          await subject.lifecycle.acceptProviderAttachment(
            {
              id: `attachment-${record.id}`,
              expectedResourceEpoch: 0,
              expectedCredentialEpoch: 0,
              acceptedAt: '2026-08-24T00:00:00.000Z',
              manager: 'alice',
            },
            providerDisclosureOf,
          )
        }
        await expect(
          subject.retargetProviderCredential({
            owner: 'alice',
            credentialId: 'credential-a',
            expectedCredentialRuntimeEpoch: 0,
            origin: 'https://provider-next.example',
            resources: [
              {
                id: 'resource-a',
                expectedRuntimeEpoch: 0,
                baseUrl: 'https://provider-next.example/v1',
                detachCredential: false,
              },
              {
                id: 'resource-b',
                expectedRuntimeEpoch: 99,
                baseUrl: 'https://provider-next.example/api',
                detachCredential: false,
              },
            ],
          }),
        ).resolves.toEqual({ status: 'conflict' })
        await expect(subject.credentials.get('credential-a')).resolves.toMatchObject({
          origin: 'https://provider.example',
          consentEpoch: 0,
          runtimeEpoch: 0,
        })
        await expect(subject.resources.get('resource-a')).resolves.toMatchObject({
          baseUrl: 'https://provider.example/v1',
          consentEpoch: 0,
          runtimeEpoch: 0,
        })
        await expect(subject.attachments.get('attachment-resource-a')).resolves.toMatchObject({
          state: 'active',
        })
        await expect(
          subject.retargetProviderCredential({
            owner: 'alice',
            credentialId: 'credential-a',
            expectedCredentialRuntimeEpoch: 0,
            origin: 'https://provider-next.example',
            resources: [
              {
                id: 'resource-a',
                expectedRuntimeEpoch: 0,
                baseUrl: 'https://provider-next.example/v1',
                detachCredential: false,
              },
              {
                id: 'resource-b',
                expectedRuntimeEpoch: 0,
                baseUrl: 'https://provider-next.example/api',
                detachCredential: false,
              },
            ],
          }),
        ).resolves.toMatchObject({
          status: 'retargeted',
          credential: { origin: 'https://provider-next.example', consentEpoch: 1, runtimeEpoch: 1 },
          resources: [
            { id: 'resource-a', consentEpoch: 1, runtimeEpoch: 1, lastCheck: {} },
            { id: 'resource-b', consentEpoch: 1, runtimeEpoch: 1, lastCheck: {} },
          ],
        })
        await expect(subject.attachments.get('attachment-resource-a')).resolves.toMatchObject({
          state: 'awaiting-reconsent',
        })
        await expect(subject.attachments.get('attachment-resource-b')).resolves.toMatchObject({
          state: 'awaiting-reconsent',
        })
      } finally {
        await subject.teardown?.()
      }
    })

    it('removes only the departing resource owner attachments with the membership', async () => {
      const subject = await setup(factory)

      try {
        await subject.auth.createUser({
          username: 'bob',
          displayName: 'Bob',
          passwordHash: null,
          admin: false,
          disabledAt: null,
          createdAt: '2026-08-23T00:00:00.000Z',
          personalSpace: null,
        })
        await subject.auth.upsertMember('space-a', 'bob', 'reader', '2026-08-23T00:00:00.000Z')
        await subject.credentials.create(credential(), KEY)
        await subject.resources.create(resource({ headers: {} }), null)
        await subject.lifecycle.offerProviderAttachment(attachment(), providerDisclosureOf)

        await subject.removeMemberAndProviderAttachments('space-a', 'bob')
        await expect(subject.attachments.get('attachment-a')).resolves.not.toBeNull()
        await expect(subject.auth.grantsFor('bob')).resolves.toEqual([])

        await subject.removeMemberAndProviderAttachments('space-a', 'alice')
        await expect(subject.attachments.get('attachment-a')).resolves.toBeNull()
        await expect(subject.auth.grantsFor('alice')).resolves.toEqual([])
      } finally {
        await subject.teardown?.()
      }
    })

    it('purges every unreadable carrier and reference atomically as one system path', async () => {
      const subject = await setup(factory)

      try {
        await subject.credentials.create(credential(), KEY)
        await subject.resources.create(resource(), KEY)
        await subject.resources.create(
          resource({
            id: 'resource-header-only',
            name: 'Header only',
            credentialId: null,
            runtimeEpoch: 4,
          }),
          KEY,
        )

        await expect(subject.ciphertexts.hasCiphertext()).resolves.toBe(true)
        await expect(subject.ciphertexts.previewUnreadable(new Set())).resolves.toMatchObject({
          affected: expect.arrayContaining([
            expect.objectContaining({ kind: 'credential', recordId: 'credential-a' }),
            expect.objectContaining({ kind: 'header', recordId: 'resource-a' }),
            expect.objectContaining({ kind: 'header', recordId: 'resource-header-only' }),
          ]),
        })
        await subject.ciphertexts.purgeUnreadable(new Set(), '2026-08-23T01:00:00.000Z')

        expect(await subject.credentials.get('credential-a')).toBeNull()
        expect(await subject.resources.get('resource-a')).toMatchObject({
          credentialId: null,
          headers: {},
          disabledAt: '2026-08-23T01:00:00.000Z',
          runtimeEpoch: 1,
          lastCheck: {},
        })
        expect(await subject.resources.get('resource-header-only')).toMatchObject({
          headers: {},
          runtimeEpoch: 5,
        })
        await expect(subject.ciphertexts.hasCiphertext()).resolves.toBe(false)
      } finally {
        await subject.teardown?.()
      }
    })
  })
}
