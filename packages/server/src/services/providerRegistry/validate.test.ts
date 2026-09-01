import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type RequestListener, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CredentialCreateRequestSchema,
  MODEL_STATUS,
  PROVIDER_CALL_ERROR,
  PROVIDER_STATUS,
  ProviderResourceCreateRequestSchema,
} from '@notarium/contract'

import { createMutationGate, type MutationGate } from '../../libs/mutationGate'
import { CredentialKeyring, CredentialKeyringService, SECRET_FACET } from '../credentialKeyring'
import { SqliteMetaDb } from '../metaDb/sqliteMetaDb'
import { ProviderRuntime } from '../providerRuntime'
import { ProviderRegistry } from './providerRegistry'

const servers: Server[] = []

const listen = async (handler: RequestListener): Promise<number> => {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return (server.address() as AddressInfo).port
}

const json = (response: Parameters<RequestListener>[1], status: number, body: unknown): void => {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

const bodyOf = async (request: Parameters<RequestListener>[0]): Promise<string> => {
  const chunks: Buffer[] = []

  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk))
  }

  return Buffer.concat(chunks).toString('utf8')
}

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('provider validate facade', () => {
  let root: string
  let db: SqliteMetaDb
  let keyring: CredentialKeyringService
  let gate: MutationGate

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'notarium-provider-validate-'))
    db = new SqliteMetaDb(join(root, 'meta.sqlite'))
    keyring = new CredentialKeyringService({
      persistence: db.secretKeyring,
      keyring: new CredentialKeyring(join(root, 'keyring'), []),
      ciphertexts: db.providerCiphertexts,
    })
    gate = createMutationGate()
    await keyring.bootstrap()
  })

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
    await db.close()
    rmSync(root, { recursive: true, force: true })
  })

  const registryFor = (port: number) => {
    const origin = `http://provider.test:${port}`

    return new ProviderRegistry({
      credentials: db.credentials,
      resources: db.providerResources,
      attachments: db.providerAttachments,
      attachmentLifecycle: db,
      spaces: db.spaces,
      projects: db.projects,
      directory: db.auth,
      keyring,
      privateOrigins: new Set([origin]),
      runtime: new ProviderRuntime({
        privateOrigins: new Set([origin]),
        callLog: db.providerCallLog,
        mutationGate: gate,
        transport: { lookup: async () => [{ address: '127.0.0.1', family: 4 }] },
      }),
      mutationGate: gate,
      now: () => new Date('2026-08-24T09:00:00.000Z'),
    })
  }

  const credentialInput = (port: number, over: Record<string, unknown> = {}) =>
    CredentialCreateRequestSchema.parse({
      name: 'Local',
      kind: 'bearer',
      secret: 'sk-local-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      origin: `http://provider.test:${port}`,
      injection: { header: '', prefix: 'Bearer ' },
      ...over,
    })

  const resourceInput = (port: number, over: Record<string, unknown> = {}) =>
    ProviderResourceCreateRequestSchema.parse({
      name: 'Local',
      wire: 'openai-compatible',
      baseUrl: `http://provider.test:${port}/api/v1`,
      allowPrivateNetwork: true,
      models: [{ name: 'local/model', capabilities: ['completion'] }],
      ...over,
    })

  it('records one outcome per capability and materializes the measured width', async () => {
    const port = await listen((request, response) => {
      if (request.url === '/api/v1/embeddings') {
        json(response, 200, { data: [{ embedding: Array.from({ length: 1024 }, () => 0.1) }] })
        return
      }
      json(response, 200, { choices: [{ message: { content: 'ok' }, finish_reason: 'length' }] })
    })
    const registry = registryFor(port)
    const credential = await registry.createCredential('alice', credentialInput(port))
    const { resource } = await registry.createResource(
      'alice',
      resourceInput(port, {
        models: [{ name: 'local/model', capabilities: ['completion', 'embedding'] }],
        credentialId: credential.id,
      }),
    )
    const validate = (capability: 'completion' | 'embedding') =>
      registry.validateResource({
        owner: 'alice',
        principal: 'user:alice',
        agent: null,
        admin: false,
        resourceId: resource.id,
        capability,
        signal: AbortSignal.timeout(5_000),
      })

    await expect(validate('completion')).resolves.toMatchObject({
      saved: true,
      result: { status: PROVIDER_STATUS.ready, credentialProven: true },
    })
    await expect(validate('embedding')).resolves.toMatchObject({ saved: true })
    await expect(db.providerResources.get(resource.id)).resolves.toMatchObject({
      lastCheck: {
        completion: { status: PROVIDER_STATUS.ready, checkedAt: '2026-08-24T09:00:00.000Z' },
        embedding: { status: PROVIDER_STATUS.ready },
      },
      models: [
        {
          name: 'local/model',
          capabilities: ['completion', 'embedding'],
          dimensions: 1024,
          statusByCapability: {
            completion: MODEL_STATUS.available,
            embedding: MODEL_STATUS.available,
          },
        },
      ],
    })
  })

  it('selects a capable default or the first capable row and sends the exact name', async () => {
    const seen: Array<{ path: string; model: string }> = []
    const port = await listen(async (request, response) => {
      const body = JSON.parse(await bodyOf(request)) as { model: string }
      seen.push({ path: request.url ?? '', model: body.model })
      if (request.url === '/api/v1/embeddings') {
        json(response, 200, { data: [{ embedding: [0.1, 0.2] }] })
        return
      }
      json(response, 200, { choices: [{ message: { content: 'ok' }, finish_reason: 'length' }] })
    })
    const registry = registryFor(port)
    const { resource } = await registry.createResource(
      'alice',
      resourceInput(port, {
        models: [
          { name: ' completion ', capabilities: ['completion'] },
          { name: 'embed\tmodel', capabilities: ['embedding'] },
        ],
        defaultModel: ' completion ',
      }),
    )
    const validate = (capability: 'completion' | 'embedding') =>
      registry.validateResource({
        owner: 'alice',
        principal: 'user:alice',
        agent: null,
        admin: false,
        resourceId: resource.id,
        capability,
        signal: AbortSignal.timeout(5_000),
      })

    await validate('embedding')
    await validate('completion')
    expect(seen).toEqual([
      { path: '/api/v1/embeddings', model: 'embed\tmodel' },
      { path: '/api/v1/chat/completions', model: ' completion ' },
    ])
  })

  it('marks only the failed capability on a multi-capability model', async () => {
    let available = false
    const port = await listen((request, response) => {
      if (!available) {
        json(response, 404, { error: { message: 'No endpoints found for multi' } })
        return
      }
      if (request.url === '/api/v1/embeddings') {
        json(response, 200, { data: [{ embedding: [0.1, 0.2] }] })
        return
      }
      json(response, 200, { choices: [{ message: { content: 'ok' }, finish_reason: 'length' }] })
    })
    const registry = registryFor(port)
    const { resource } = await registry.createResource(
      'alice',
      resourceInput(port, {
        models: [{ name: 'multi', capabilities: ['completion', 'embedding'] }],
      }),
    )

    await expect(
      registry.validateResource({
        owner: 'alice',
        principal: 'user:alice',
        agent: null,
        admin: false,
        resourceId: resource.id,
        capability: 'embedding',
        signal: AbortSignal.timeout(5_000),
      }),
    ).resolves.toMatchObject({ result: { status: PROVIDER_STATUS.notConfigured } })
    await expect(db.providerResources.get(resource.id)).resolves.toMatchObject({
      models: [
        {
          statusByCapability: {
            completion: MODEL_STATUS.available,
            embedding: MODEL_STATUS.unavailable,
          },
        },
      ],
      lastCheck: { embedding: { status: PROVIDER_STATUS.notConfigured } },
    })

    available = true
    await expect(
      registry.validateResource({
        owner: 'alice',
        principal: 'user:alice',
        agent: null,
        admin: false,
        resourceId: resource.id,
        capability: 'embedding',
        signal: AbortSignal.timeout(5_000),
      }),
    ).resolves.toMatchObject({
      saved: true,
      result: { status: PROVIDER_STATUS.ready },
    })
    await expect(db.providerResources.get(resource.id)).resolves.toMatchObject({
      models: [
        {
          dimensions: 2,
          statusByCapability: {
            completion: MODEL_STATUS.available,
            embedding: MODEL_STATUS.available,
          },
        },
      ],
      lastCheck: { embedding: { status: PROVIDER_STATUS.ready } },
    })
  })

  it('waits for a running backup checkpoint instead of writing past the gate', async () => {
    const port = await listen((_request, response) => {
      json(response, 200, { choices: [{ message: { content: 'ok' }, finish_reason: 'length' }] })
    })
    const registry = registryFor(port)
    const { resource } = await registry.createResource(
      'alice',
      resourceInput(port, {
        models: [{ name: 'local/model', capabilities: ['completion'] }],
      }),
    )
    const checkpointStarted = deferred()
    const checkpointDone = deferred()
    const checkpoint = gate.checkpoint(async () => {
      checkpointStarted.resolve()
      await checkpointDone.promise
    })
    await checkpointStarted.promise
    const validating = registry.validateResource({
      owner: 'alice',
      principal: 'user:alice',
      agent: null,
      admin: false,
      resourceId: resource.id,
      capability: 'completion',
      signal: AbortSignal.timeout(5_000),
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    // The network call is outside the barrier, but its write is not: an archive
    // snapshot must not see `last_check` drift under it.
    expect((await db.providerResources.get(resource.id))!.lastCheck).toEqual({})
    checkpointDone.resolve()
    await checkpoint
    await expect(validating).resolves.toMatchObject({ saved: true })
  })

  it('decides everything local without opening a socket', async () => {
    let requests = 0
    const port = await listen((_request, response) => {
      requests += 1
      json(response, 200, { choices: [{ message: { content: 'ok' }, finish_reason: 'length' }] })
    })
    const registry = registryFor(port)
    const credential = await registry.createCredential('alice', credentialInput(port))
    const { resource } = await registry.createResource(
      'alice',
      resourceInput(port, {
        models: [{ name: 'local/model', capabilities: ['completion'] }],
        credentialId: credential.id,
      }),
    )
    const validate = () =>
      registry.validateResource({
        owner: 'alice',
        principal: 'user:alice',
        agent: null,
        admin: false,
        resourceId: resource.id,
        capability: 'completion',
        signal: AbortSignal.timeout(5_000),
      })

    await registry.updateCredential('alice', credential.id, { disabled: true })
    await expect(validate()).resolves.toMatchObject({
      saved: true,
      result: { status: PROVIDER_STATUS.credentialDisabled, credentialProven: false },
    })
    await registry.updateCredential('alice', credential.id, { disabled: false })
    await registry.updateResource('alice', resource.id, { disabled: true })
    await expect(validate()).resolves.toMatchObject({
      result: { status: PROVIDER_STATUS.disabled },
    })
    expect(requests).toBe(0)
  })

  it('charges the host ceiling even when the outcome needs no socket', async () => {
    let requests = 0
    const port = await listen((_request, response) => {
      requests += 1
      json(response, 200, { choices: [{ message: { content: 'ok' }, finish_reason: 'length' }] })
    })
    const registry = registryFor(port)
    const { resource } = await registry.createResource(
      'alice',
      resourceInput(port, {
        models: [{ name: 'local/model', capabilities: ['completion'] }],
      }),
    )
    await registry.updateResource('alice', resource.id, { disabled: true })
    const validate = () =>
      registry.validateResource({
        owner: 'alice',
        principal: 'user:alice',
        agent: null,
        admin: false,
        resourceId: resource.id,
        capability: 'completion',
        signal: AbortSignal.timeout(5_000),
      })

    // A disabled resource opens no socket, but each call still WRITES its outcome.
    // Uncapped, that is an authenticated loop of meta-DB writes, and every one of
    // them moves `PRAGMA data_version` under an online backup's drift detector.
    for (let index = 0; index < 20; index += 1) {
      await expect(validate()).resolves.toMatchObject({
        result: { status: PROVIDER_STATUS.disabled },
      })
    }
    await expect(validate()).rejects.toMatchObject({
      code: PROVIDER_CALL_ERROR.notariumRateLimited,
    })
    expect(requests).toBe(0)
  })

  it('refuses to send when a ciphertext carrier will not decrypt', async () => {
    let requests = 0
    const port = await listen((_request, response) => {
      requests += 1
      json(response, 200, { choices: [{ message: { content: 'ok' }, finish_reason: 'length' }] })
    })
    const registry = registryFor(port)
    const { resource } = await registry.createResource(
      'alice',
      resourceInput(port, {
        headers: { 'x-title': 'notarium' },
        models: [{ name: 'local/model', capabilities: ['completion'] }],
      }),
    )
    const record = await db.providerResources.get(resource.id)
    // Same key, foreign AAD field: the envelope refuses it exactly as it refuses a
    // reshuffled ciphertext. Without the header the request would go out to a real
    // address unauthenticated, which is worse than not going at all.
    const foreign = await keyring.encrypt('notarium', {
      facet: SECRET_FACET.resource,
      recordId: resource.id,
      field: 'x-other',
    })
    await db.providerResources.replaceIfRuntimeEpoch(
      { ...record!, headers: { 'x-title': foreign.ciphertext } },
      foreign,
      record!.runtimeEpoch,
      record!.credentialId,
    )
    await expect(
      registry.validateResource({
        owner: 'alice',
        principal: 'user:alice',
        agent: null,
        admin: false,
        resourceId: resource.id,
        capability: 'completion',
        signal: AbortSignal.timeout(5_000),
      }),
    ).resolves.toMatchObject({ result: { status: PROVIDER_STATUS.secretUnreadable } })
    expect(requests).toBe(0)
  })

  it('drops an outcome whose credential rotated while the call was in flight', async () => {
    const inFlight = deferred()
    const release = deferred()
    const port = await listen(async (_request, response) => {
      inFlight.resolve()
      await release.promise
      json(response, 200, { choices: [{ message: { content: 'ok' }, finish_reason: 'length' }] })
    })
    const registry = registryFor(port)
    const credential = await registry.createCredential('alice', credentialInput(port))
    const { resource } = await registry.createResource(
      'alice',
      resourceInput(port, {
        models: [{ name: 'local/model', capabilities: ['completion'] }],
        credentialId: credential.id,
      }),
    )
    const validating = registry.validateResource({
      owner: 'alice',
      principal: 'user:alice',
      agent: null,
      admin: false,
      resourceId: resource.id,
      capability: 'completion',
      signal: AbortSignal.timeout(5_000),
    })
    await inFlight.promise
    // A secret rotation moves NO resource field. A resource-only condition would
    // let this `ready` land as the health of a credential that no longer exists.
    await registry.updateCredential('alice', credential.id, { secret: 'sk-local-rotated-value' })
    release.resolve()

    await expect(validating).resolves.toMatchObject({
      saved: false,
      result: { status: PROVIDER_STATUS.ready },
    })
    expect((await db.providerResources.get(resource.id))!.lastCheck).toEqual({})
  })

  it('refuses a stale credential snapshot before intent and send', async () => {
    let requests = 0
    const port = await listen((_request, response) => {
      requests += 1
      json(response, 200, { choices: [{ message: { content: 'ok' }, finish_reason: 'length' }] })
    })
    const registry = registryFor(port)
    const credential = await registry.createCredential('alice', credentialInput(port))
    const { resource } = await registry.createResource(
      'alice',
      resourceInput(port, {
        models: [{ name: 'local/model', capabilities: ['completion'] }],
        credentialId: credential.id,
      }),
    )
    const decryptStarted = deferred()
    const releaseDecrypt = deferred()
    const decrypt = keyring.decryptMany.bind(keyring)

    keyring.decryptMany = async (...args: Parameters<typeof keyring.decryptMany>) => {
      decryptStarted.resolve()
      await releaseDecrypt.promise
      return decrypt(...args)
    }
    const validating = registry.validateResource({
      owner: 'alice',
      principal: 'user:alice',
      agent: null,
      admin: false,
      resourceId: resource.id,
      capability: 'completion',
      signal: AbortSignal.timeout(5_000),
    })

    await decryptStarted.promise
    await registry.updateCredential('alice', credential.id, { rpm: 2 })
    releaseDecrypt.resolve()

    await expect(validating).rejects.toMatchObject({
      code: PROVIDER_CALL_ERROR.canceled,
      deliveryState: 'not-sent',
    })
    expect(requests).toBe(0)
    expect(await db.providerCallLog.listForOwner('alice')).toEqual([])
  })

  it('coarsens a private outcome for everyone except the owner and an admin', async () => {
    const port = await listen((_request, response) => {
      json(response, 502, { error: { message: 'connect ECONNREFUSED 10.0.0.5:8080' } })
    })
    const registry = registryFor(port)
    const { resource } = await registry.createResource(
      'alice',
      resourceInput(port, {
        models: [{ name: 'local/model', capabilities: ['completion'] }],
      }),
    )
    await registry.validateResource({
      owner: 'alice',
      principal: 'user:alice',
      agent: null,
      admin: false,
      resourceId: resource.id,
      capability: 'completion',
      signal: AbortSignal.timeout(5_000),
    })
    const record = (await db.providerResources.get(resource.id))!

    expect(registry.resourceToWire(record, { owner: 'alice' }).lastCheck.completion).toMatchObject({
      status: PROVIDER_STATUS.unreachable,
      diagnostic: expect.stringContaining('ECONNREFUSED'),
    })
    expect(
      registry.resourceToWire(record, { owner: 'bob', admin: true }).lastCheck.completion,
    ).toMatchObject({ diagnostic: expect.stringContaining('ECONNREFUSED') })
    expect(registry.resourceToWire(record, { owner: 'bob' }).lastCheck.completion).toEqual({
      status: PROVIDER_STATUS.unreachable,
      checkedAt: '2026-08-24T09:00:00.000Z',
      diagnostic: null,
      credentialProven: false,
    })
    // Withheld from a stranger, so `policy-denied` cannot be told apart from a
    // failed resolve — that difference is a sharper DNS oracle than timing.
    expect(registry.resourceToWire(record, {}).credentialId).toBeUndefined()
  })

  it('leaves a public address in full resolution and a local fact uncoarsened', async () => {
    const port = await listen((_request, response) => {
      json(response, 200, { choices: [{ message: { content: 'ok' }, finish_reason: 'length' }] })
    })
    const registry = registryFor(port)
    const { resource } = await registry.createResource(
      'alice',
      resourceInput(port, {
        baseUrl: 'https://openrouter.ai/api/v1',
        allowPrivateNetwork: false,
        models: [{ name: 'openai/gpt-4.1-nano', capabilities: ['completion'] }],
      }),
    )
    const record = (await db.providerResources.get(resource.id))!
    const withCheck = {
      ...record,
      lastCheck: {
        completion: {
          status: PROVIDER_STATUS.credentialRejected,
          checkedAt: '2026-08-24T09:00:00.000Z',
          diagnostic: 'No auth credentials found',
          credentialProven: false,
        },
      },
    }

    // The status survives at full resolution — a public address is collapsed by
    // nothing. The provider's sentence is a different question and travels only to
    // the owner: it is prose about the OWNER's account, not about the address.
    expect(
      registry.resourceToWire(withCheck, { owner: 'alice' }).lastCheck.completion,
    ).toMatchObject({
      status: PROVIDER_STATUS.credentialRejected,
      diagnostic: 'No auth credentials found',
    })
    expect(registry.resourceToWire(withCheck, { owner: 'bob' }).lastCheck.completion).toMatchObject(
      {
        status: PROVIDER_STATUS.credentialRejected,
        diagnostic: null,
      },
    )
    expect(
      registry.resourceToWire(
        {
          ...record,
          allowPrivateNetwork: true,
          baseUrl: `http://provider.test:${port}/api/v1`,
          lastCheck: {
            completion: {
              status: PROVIDER_STATUS.disabled,
              checkedAt: '2026-08-24T09:00:00.000Z',
              diagnostic: null,
              credentialProven: false,
            },
          },
        },
        { owner: 'bob' },
      ).lastCheck.completion,
    ).toMatchObject({ status: PROVIDER_STATUS.disabled })
  })

  it('refuses foreign or undeclared capabilities before admission, intent and network', async () => {
    let requests = 0
    const port = await listen((_request, response) => {
      requests += 1
      json(response, 200, { choices: [{ message: { content: 'ok' }, finish_reason: 'length' }] })
    })
    const registry = registryFor(port)
    const { resource } = await registry.createResource('alice', resourceInput(port))

    await expect(
      registry.validateResource({
        owner: 'bob',
        principal: 'user:bob',
        agent: null,
        admin: true,
        resourceId: resource.id,
        capability: 'completion',
        signal: AbortSignal.timeout(5_000),
      }),
    ).resolves.toBeNull()
    for (let index = 0; index < 20; index += 1) {
      await expect(
        registry.validateResource({
          owner: 'alice',
          principal: 'user:alice',
          agent: null,
          admin: false,
          resourceId: resource.id,
          capability: 'embedding',
          signal: AbortSignal.timeout(5_000),
        }),
      ).rejects.toMatchObject({ code: 'PROVIDER_VALIDATION' })
    }
    await expect(
      registry.validateResource({
        owner: 'alice',
        principal: 'user:alice',
        agent: null,
        admin: false,
        resourceId: resource.id,
        capability: 'completion',
        signal: AbortSignal.timeout(5_000),
      }),
    ).resolves.toMatchObject({ saved: true, result: { status: PROVIDER_STATUS.ready } })
    expect(requests).toBe(1)
    expect(await db.providerCallLog.listForOwner('alice')).toHaveLength(1)
  })
})
