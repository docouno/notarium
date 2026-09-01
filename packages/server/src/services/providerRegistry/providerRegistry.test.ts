import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CredentialCreateRequestSchema,
  CredentialPatchRequestSchema,
  MODEL_STATUS,
  PROVIDER_STATUS,
  ProviderResourceCreateRequestSchema,
} from '@notarium/contract'

import { CredentialKeyring, CredentialKeyringService, SECRET_FACET } from '../credentialKeyring'
import { SqliteMetaDb } from '../metaDb/sqliteMetaDb'
import { providerEmbedderId, ProviderRegistry } from './providerRegistry'

describe('provider registry', () => {
  let root: string
  let db: SqliteMetaDb
  let keyring: CredentialKeyringService
  let registry: ProviderRegistry

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'notarium-provider-registry-'))
    db = new SqliteMetaDb(join(root, 'meta.sqlite'))
    keyring = new CredentialKeyringService({
      persistence: db.secretKeyring,
      keyring: new CredentialKeyring(join(root, 'keyring'), []),
      ciphertexts: db.providerCiphertexts,
    })
    registry = new ProviderRegistry({
      credentials: db.credentials,
      resources: db.providerResources,
      attachments: db.providerAttachments,
      attachmentLifecycle: db,
      spaces: db.spaces,
      projects: db.projects,
      directory: db.auth,
      keyring,
      privateOrigins: new Set(['http://127.0.0.1:11434']),
    })
    await keyring.bootstrap()
  })

  afterEach(async () => {
    await db.close()
    rmSync(root, { recursive: true, force: true })
  })

  const createCredential = () =>
    registry.createCredential(
      'alice',
      CredentialCreateRequestSchema.parse({
        name: 'OpenRouter',
        kind: 'bearer',
        secret: 'sk-or-v1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        origin: 'https://openrouter.ai',
        injection: { header: '', prefix: 'Bearer ' },
      }),
    )

  const resourceInput = (over: Record<string, unknown> = {}) =>
    ProviderResourceCreateRequestSchema.parse({
      name: 'Main',
      wire: 'openai-compatible',
      baseUrl: 'https://openrouter.ai/api/v1',
      headers: {},
      models: [{ name: 'gpt-4o-mini', capabilities: ['completion'] }],
      ...over,
    })

  it('canonicalizes capability order without changing exact model identities or epochs', async () => {
    const created = await registry.createResource(
      'alice',
      resourceInput({
        models: [
          { name: ' model ', capabilities: ['embedding', 'completion'] },
          { name: 'model\tvariant', capabilities: ['completion'] },
        ],
        defaultModel: ' model ',
      }),
    )
    await db.providerResources.recordLastCheck({
      resourceId: created.resource.id,
      capability: 'embedding',
      lastCheck: {
        status: 'ready',
        checkedAt: '2026-08-31T00:00:00.000Z',
        diagnostic: null,
        credentialProven: true,
      },
      measurement: {
        modelName: ' model ',
        status: MODEL_STATUS.available,
        dimensions: 1536,
      },
      expectedRuntimeEpoch: 0,
      expectedCredentialId: null,
      expectedCredentialRuntimeEpoch: null,
    })
    await db.spaces.upsert({
      id: 'space-main',
      slug: 'main',
      displayName: 'Main',
      notesDir: 'main',
      aliases: [],
      createdAt: '2026-08-31T00:00:00.000Z',
      archivedAt: null,
      archivedBy: null,
    })
    await db.auth.createUser({
      username: 'alice',
      displayName: 'Alice',
      passwordHash: null,
      admin: false,
      disabledAt: null,
      createdAt: '2026-08-31T00:00:00.000Z',
      personalSpace: null,
    })
    await db.auth.upsertMember('space-main', 'alice', 'owner', '2026-08-31T00:00:00.000Z')
    const offered = await registry.offerAttachment({
      owner: 'alice',
      resourceId: created.resource.id,
      targetKind: 'space',
      targetId: 'space-main',
    })

    expect(offered.status).toBe('offered')
    if (offered.status !== 'offered') {
      return
    }
    await registry.acceptAttachment(
      offered.view.attachment.id,
      offered.view.currentEpochs,
      'alice',
      'alice',
    )
    const before = await db.providerResources.get(created.resource.id)
    const attachmentBefore = await db.providerAttachments.get(offered.view.attachment.id)
    const updated = await registry.updateResource('alice', created.resource.id, {
      models: [
        { name: ' model ', capabilities: ['completion', 'embedding'] },
        { name: 'model\tvariant', capabilities: ['completion'] },
      ],
      defaultModel: ' model ',
    })
    const after = await db.providerResources.get(created.resource.id)
    const attachmentAfter = await db.providerAttachments.get(offered.view.attachment.id)

    expect(created.resource.models.map(({ name }) => name)).toEqual([' model ', 'model\tvariant'])
    expect(created.resource.models[0].capabilities).toEqual(['completion', 'embedding'])
    expect(updated?.resource.defaultModel).toBe(' model ')
    expect(after).toEqual(before)
    expect(attachmentAfter).toEqual(attachmentBefore)
  })

  it('keeps automatic timeout profiles distinct from explicit overrides', async () => {
    const created = await registry.createResource('alice', resourceInput())

    expect(created.resource).toMatchObject({
      firstByteTimeoutMs: null,
      callTimeoutMs: null,
    })
    await expect(
      registry.updateResource('alice', created.resource.id, {
        firstByteTimeoutMs: 60_000,
        callTimeoutMs: 120_000,
      }),
    ).resolves.toMatchObject({
      resource: { firstByteTimeoutMs: 60_000, callTimeoutMs: 120_000 },
    })
    await expect(
      registry.updateResource('alice', created.resource.id, {
        firstByteTimeoutMs: null,
        callTimeoutMs: null,
      }),
    ).resolves.toMatchObject({
      resource: { firstByteTimeoutMs: null, callTimeoutMs: null },
    })
  })

  it('reloads and retries when rotation wins after encryption but before the DB writer fence', async () => {
    const original = db.credentials
    const expectedKeyId = (await db.secretKeyring.active())[0].keyId
    let rotated = false
    const racing = new ProviderRegistry({
      credentials: {
        ...original,
        create: async (record, ciphertext) => {
          if (!rotated) {
            rotated = true
            await keyring.rotate({ expectedKeyId, apply: true })
          }

          return original.create(record, ciphertext)
        },
      },
      resources: db.providerResources,
      attachments: db.providerAttachments,
      attachmentLifecycle: db,
      spaces: db.spaces,
      projects: db.projects,
      directory: db.auth,
      keyring,
      privateOrigins: new Set(),
    })

    await expect(
      racing.createCredential(
        'alice',
        CredentialCreateRequestSchema.parse({
          name: 'Racing key',
          kind: 'bearer',
          secret: 'sk-or-v1-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          origin: 'https://openrouter.ai',
          injection: { header: '', prefix: 'Bearer ' },
        }),
      ),
    ).resolves.toMatchObject({ name: 'Racing key' })
    const active = (await db.secretKeyring.active())[0]
    const stored = (await db.credentials.listForOwner('alice'))[0]

    expect(rotated).toBe(true)
    expect(active.keyId).not.toBe(expectedKeyId)
    expect(stored.secret).toMatch(new RegExp(`^v1\\.${active.keyId}\\.`))
  })

  it('canonicalizes and encrypts header values while returning names only', async () => {
    const created = await registry.createResource(
      'alice',
      resourceInput({
        headers: {
          'X-Api-Key': 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz',
          'X-Title': 'Notarium',
        },
      }),
    )
    expect(created.warnings).toEqual(['possible-secret'])
    expect(created.resource).toMatchObject({
      headerNames: ['x-api-key', 'x-title'],
      vendor: 'openrouter',
      hasCredentials: false,
    })
    expect(JSON.stringify(created.resource)).not.toContain('sk-ant-api03')

    const stored = await db.providerResources.get(created.resource.id)
    expect(Object.keys(stored?.headers ?? {})).toEqual(['x-api-key', 'x-title'])
    expect(stored?.headers['x-api-key']).toMatch(/^v1\.ck_[0-9a-f]{24}\./)
    await expect(
      keyring.decrypt(stored!.headers['x-api-key'], {
        facet: SECRET_FACET.resource,
        recordId: created.resource.id,
        field: 'x-api-key',
      }),
    ).resolves.toBe('sk-ant-api03-abcdefghijklmnopqrstuvwxyz')
  })

  it('rejects unconditional header and base-url hazards before persistence', async () => {
    await expect(
      registry.createResource(
        'alice',
        resourceInput({ headers: { 'X-Api-Key': 'a', 'x-api-key': 'b' } }),
      ),
    ).rejects.toThrow(/duplicated after canonicalization/)
    await expect(
      registry.createResource('alice', resourceInput({ headers: { Host: 'example.test' } })),
    ).rejects.toThrow(/controlled by the transport/)
    await expect(
      registry.createResource('alice', resourceInput({ headers: { 'x-a': 'v\r\nInjected: 1' } })),
    ).rejects.toThrow(/control characters/)
    await expect(
      registry.createResource(
        'alice',
        resourceInput({ baseUrl: 'https://user:pass@example.test' }),
      ),
    ).rejects.toThrow(/without credentials/)
  })

  it('requires both operator admission and resource opt-in for literal private targets', async () => {
    await expect(
      registry.createResource(
        'alice',
        resourceInput({ baseUrl: 'http://127.0.0.1:11434', allowPrivateNetwork: false }),
      ),
    ).rejects.toThrow(/operator admission and resource opt-in/)
    await expect(
      registry.createResource(
        'alice',
        resourceInput({ baseUrl: 'http://127.0.0.1:11434', allowPrivateNetwork: true }),
      ),
    ).resolves.toMatchObject({ resource: { allowPrivateNetwork: true } })
  })

  it('enforces credential owner, origin, and injection-header collision', async () => {
    const credential = await createCredential()
    await expect(
      registry.createResource(
        'alice',
        resourceInput({ credentialId: credential.id, headers: { Authorization: 'manual' } }),
      ),
    ).rejects.toThrow(/collides with credential injection/)
    await expect(
      registry.createResource(
        'bob',
        resourceInput({ credentialId: credential.id, name: 'Foreign' }),
      ),
    ).rejects.toThrow(/only its owner credential/)
    await expect(
      registry.createResource(
        'alice',
        resourceInput({
          credentialId: credential.id,
          name: 'Wrong origin',
          baseUrl: 'https://api.example.test/v1',
        }),
      ),
    ).rejects.toThrow(/origins differ/)
  })

  it('updates credential freshness separately from consent and resets every lastCheck', async () => {
    const credential = await createCredential()
    const first = await registry.createResource(
      'alice',
      resourceInput({ credentialId: credential.id, name: 'First' }),
    )
    const second = await registry.createResource(
      'alice',
      resourceInput({ credentialId: credential.id, name: 'Second' }),
    )
    const checkedAt = '2026-08-24T00:00:00.000Z'

    for (const id of [first.resource.id, second.resource.id]) {
      const current = (await db.providerResources.get(id))!
      await db.providerResources.replaceIfRuntimeEpoch(
        {
          ...current,
          runtimeEpoch: current.runtimeEpoch + 1,
          lastCheck: {
            completion: {
              status: PROVIDER_STATUS.ready,
              checkedAt,
              diagnostic: null,
              credentialProven: true,
            },
          },
        },
        null,
        current.runtimeEpoch,
        current.credentialId,
      )
    }

    const secret = await registry.updateCredential(
      'alice',
      credential.id,
      CredentialPatchRequestSchema.parse({
        secret: 'sk-or-v1-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      }),
    )
    expect(secret).toMatchObject({ credential: { runtimeEpoch: 1, consentEpoch: 0 } })
    await expect(db.providerResources.get(first.resource.id)).resolves.toMatchObject({
      lastCheck: {},
    })
    await expect(db.providerResources.get(second.resource.id)).resolves.toMatchObject({
      lastCheck: {},
    })

    const injection = await registry.updateCredential(
      'alice',
      credential.id,
      CredentialPatchRequestSchema.parse({ injection: { header: 'x-auth', prefix: '' } }),
    )
    expect(injection).toMatchObject({ credential: { runtimeEpoch: 2, consentEpoch: 1 } })
  })

  it('does not let a stale name-only resource PATCH restore a credential-invalidated check', async () => {
    const credential = await createCredential()
    const created = await registry.createResource(
      'alice',
      resourceInput({ credentialId: credential.id, headers: {} }),
    )
    const current = (await db.providerResources.get(created.resource.id))!
    await db.providerResources.replaceIfRuntimeEpoch(
      {
        ...current,
        runtimeEpoch: current.runtimeEpoch + 1,
        lastCheck: {
          completion: {
            status: PROVIDER_STATUS.ready,
            checkedAt: '2026-08-24T00:00:00.000Z',
            diagnostic: null,
            credentialProven: true,
          },
        },
      },
      null,
      current.runtimeEpoch,
      current.credentialId,
    )
    let resourceRead!: () => void
    let resumePatch!: () => void
    const read = new Promise<void>((resolve) => {
      resourceRead = resolve
    })
    const resume = new Promise<void>((resolve) => {
      resumePatch = resolve
    })
    let held = false
    const concurrent = new ProviderRegistry({
      credentials: db.credentials,
      resources: {
        ...db.providerResources,
        get: async (id) => {
          const record = await db.providerResources.get(id)

          if (id === created.resource.id && !held) {
            held = true
            resourceRead()
            await resume
          }

          return record
        },
      },
      attachments: db.providerAttachments,
      attachmentLifecycle: db,
      spaces: db.spaces,
      projects: db.projects,
      directory: db.auth,
      keyring,
      privateOrigins: new Set(),
    })
    const rename = concurrent.updateResource('alice', created.resource.id, { name: 'Renamed' })

    await read
    await registry.updateCredential(
      'alice',
      credential.id,
      CredentialPatchRequestSchema.parse({
        secret: 'sk-or-v1-cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      }),
    )
    resumePatch()
    await rename

    await expect(db.providerResources.get(created.resource.id)).resolves.toMatchObject({
      name: 'Renamed',
      lastCheck: {},
    })
  })

  it('lists incompatible references and never mutates or deletes through them', async () => {
    const credential = await createCredential()
    const first = await registry.createResource(
      'alice',
      resourceInput({ credentialId: credential.id, name: 'First' }),
    )
    const second = await registry.createResource(
      'alice',
      resourceInput({ credentialId: credential.id, name: 'Second' }),
    )

    await expect(
      registry.updateCredential(
        'alice',
        credential.id,
        CredentialPatchRequestSchema.parse({ origin: 'https://provider.example' }),
      ),
    ).rejects.toMatchObject({
      code: 'PROVIDER_CREDENTIAL_REFERENCED',
      references: [
        { kind: 'provider-resource', id: first.resource.id, name: 'First' },
        { kind: 'provider-resource', id: second.resource.id, name: 'Second' },
      ],
    })
    await expect(registry.deleteCredential('alice', credential.id)).rejects.toMatchObject({
      code: 'PROVIDER_CREDENTIAL_REFERENCED',
      references: [
        { kind: 'provider-resource', id: first.resource.id, name: 'First' },
        { kind: 'provider-resource', id: second.resource.id, name: 'Second' },
      ],
    })
    await expect(db.credentials.get(credential.id)).resolves.toMatchObject({
      origin: 'https://openrouter.ai',
    })
  })

  it('keeps @system credentials unreachable to a password principal', async () => {
    const system = await registry.createCredential(
      '@system',
      CredentialCreateRequestSchema.parse({
        name: 'System',
        kind: 'bearer',
        secret: 'system-secret',
        origin: 'https://provider.example',
      }),
    )

    await expect(registry.getCredential('alice', system.id)).resolves.toBeNull()
    await expect(
      registry.updateCredential(
        'alice',
        system.id,
        CredentialPatchRequestSchema.parse({ name: 'Taken' }),
      ),
    ).resolves.toBeNull()
    await expect(registry.deleteCredential('alice', system.id)).resolves.toBe(false)
    await expect(db.credentials.get(system.id)).resolves.not.toBeNull()
  })

  it('patches write-only headers without dropping untouched values', async () => {
    const created = await registry.createResource(
      'alice',
      resourceInput({
        headers: {
          'X-Old': 'secret-ish-value',
          'X-Keep': 'untouched-secret-value',
          'X-Delete': 'removed-secret-value',
        },
      }),
    )
    const updated = await registry.updateResource('alice', created.resource.id, {
      headers: {
        'X-Old': null,
        'X-New': 'secret-ish-value',
        'X-Delete': null,
      },
    })
    const stored = await db.providerResources.get(created.resource.id)
    expect(updated?.resource.headerNames).toEqual(['x-keep', 'x-new'])
    expect(stored?.headers).not.toHaveProperty('x-old')
    expect(stored?.headers).not.toHaveProperty('x-delete')
    await expect(
      keyring.decrypt(stored!.headers['x-keep'], {
        facet: SECRET_FACET.resource,
        recordId: created.resource.id,
        field: 'x-keep',
      }),
    ).resolves.toBe('untouched-secret-value')
    await expect(
      keyring.decrypt(stored!.headers['x-new'], {
        facet: SECRET_FACET.resource,
        recordId: created.resource.id,
        field: 'x-old',
      }),
    ).rejects.toThrow()
    await expect(
      keyring.decrypt(stored!.headers['x-new'], {
        facet: SECRET_FACET.resource,
        recordId: created.resource.id,
        field: 'x-new',
      }),
    ).resolves.toBe('secret-ish-value')
  })

  it('separates consent-manager addressee access from host-admin diagnostics', async () => {
    const created = await registry.createResource('alice', resourceInput())
    const stored = await db.providerResources.recordLastCheck({
      resourceId: created.resource.id,
      capability: 'completion',
      lastCheck: {
        status: 'quota-exhausted',
        checkedAt: '2026-08-30T00:00:00.000Z',
        diagnostic: 'organization ACME has 7 credits',
        credentialProven: true,
      },
      measurement: null,
      expectedRuntimeEpoch: 0,
      expectedCredentialId: null,
      expectedCredentialRuntimeEpoch: null,
    })

    expect(stored.status).toBe('recorded')
    if (stored.status !== 'recorded') {
      return
    }
    const manager = registry.resourceToWire(stored.record, {
      owner: 'bob',
      consentManager: true,
    })
    const admin = registry.resourceToWire(stored.record, { owner: 'bob', admin: true })

    expect(manager.baseUrl).toBe('https://openrouter.ai/api/v1')
    expect(manager.lastCheck.completion?.diagnostic).toBeNull()
    expect(admin.lastCheck.completion?.diagnostic).toBe('organization ACME has 7 credits')
  })

  it('derives embedder identity from model semantics, not the resource row id', () => {
    const semantic = {
      baseUrl: 'https://provider.example/v1',
      model: 'embed-a',
      dimensions: 768,
    }
    expect(providerEmbedderId(semantic)).toBe(providerEmbedderId({ ...semantic }))
    expect(providerEmbedderId({ ...semantic, dimensions: 1024 })).not.toBe(
      providerEmbedderId(semantic),
    )
  })

  it('keeps authored model capabilities separate from runtime facts', async () => {
    const created = await registry.createResource(
      'alice',
      resourceInput({
        models: [
          { name: 'embed-small', capabilities: ['embedding'] },
          { name: 'embed-large', capabilities: ['embedding'] },
        ],
      }),
    )
    expect(created.resource.models.map((model) => model.dimensions)).toEqual([null, null])
    expect(
      created.resource.models.some((model) => 'quantization' in model || 'kind' in model),
    ).toBe(false)
  })

  it('bounds provider-controlled model inventory before persistence', () => {
    expect(
      ProviderResourceCreateRequestSchema.safeParse({
        name: 'Too many models',
        wire: 'openai-compatible',
        baseUrl: 'https://provider.example/v1',
        models: Array.from({ length: 513 }, (_, index) => ({
          name: `model-${index}`,
          capabilities: ['completion'],
        })),
      }).success,
    ).toBe(false)
    expect(
      ProviderResourceCreateRequestSchema.safeParse({
        name: 'Oversized model',
        wire: 'openai-compatible',
        baseUrl: 'https://provider.example/v1',
        models: [{ name: 'x'.repeat(513), capabilities: ['completion'] }],
      }).success,
    ).toBe(false)
  })

  it('retries a concurrent PATCH so distinct configs get distinct runtime epochs', async () => {
    const created = await registry.createResource('alice', resourceInput({ headers: {} }))
    let reads = 0
    let release!: () => void
    const bothRead = new Promise<void>((resolve) => {
      release = resolve
    })
    const resources = {
      ...db.providerResources,
      get: async (id: string) => {
        const record = await db.providerResources.get(id)

        if (id === created.resource.id && reads < 2) {
          reads += 1
          if (reads === 2) {
            release()
          }
          await bothRead
        }

        return record
      },
    }
    const concurrent = new ProviderRegistry({
      credentials: db.credentials,
      resources,
      attachments: db.providerAttachments,
      attachmentLifecycle: db,
      spaces: db.spaces,
      projects: db.projects,
      directory: db.auth,
      keyring,
      privateOrigins: new Set(),
    })
    const results = await Promise.all([
      concurrent.updateResource('alice', created.resource.id, {
        baseUrl: 'https://openrouter.ai/api/v2',
      }),
      concurrent.updateResource('alice', created.resource.id, { callTimeoutMs: 120_000 }),
    ])
    const stored = await db.providerResources.get(created.resource.id)

    expect(results.map((result) => result?.resource.runtimeEpoch).sort()).toEqual([1, 2])
    expect(stored).toMatchObject({
      baseUrl: 'https://openrouter.ai/api/v2',
      callTimeoutMs: 120_000,
      runtimeEpoch: 2,
    })
  })
})
