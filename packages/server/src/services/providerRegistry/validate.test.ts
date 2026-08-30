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
      purposes: ['chat'],
      ...over,
    })

  it('records one outcome per purpose and materializes the measured width', async () => {
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
        purposes: ['chat', 'embedding'],
        models: [{ name: 'local/model', dimensions: null, status: MODEL_STATUS.available }],
        credentialId: credential.id,
      }),
    )
    const validate = (purpose: 'chat' | 'embedding') =>
      registry.validateResource({
        owner: 'alice',
        principal: 'user:alice',
        agent: null,
        admin: false,
        resourceId: resource.id,
        purpose,
        signal: AbortSignal.timeout(5_000),
      })

    await expect(validate('chat')).resolves.toMatchObject({
      saved: true,
      result: { status: PROVIDER_STATUS.ready, credentialProven: true },
    })
    await expect(validate('embedding')).resolves.toMatchObject({ saved: true })
    await expect(db.providerResources.get(resource.id)).resolves.toMatchObject({
      lastCheck: {
        chat: { status: PROVIDER_STATUS.ready, checkedAt: '2026-08-24T09:00:00.000Z' },
        embedding: { status: PROVIDER_STATUS.ready },
      },
      models: [{ name: 'local/model', dimensions: 1024, status: MODEL_STATUS.available }],
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
        models: [{ name: 'local/model', dimensions: null, status: MODEL_STATUS.available }],
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
      purpose: 'chat',
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
        models: [{ name: 'local/model', dimensions: null, status: MODEL_STATUS.available }],
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
        purpose: 'chat',
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
        models: [{ name: 'local/model', dimensions: null, status: MODEL_STATUS.available }],
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
        purpose: 'chat',
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
        models: [{ name: 'local/model', dimensions: null, status: MODEL_STATUS.available }],
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
        purpose: 'chat',
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
        models: [{ name: 'local/model', dimensions: null, status: MODEL_STATUS.available }],
        credentialId: credential.id,
      }),
    )
    const validating = registry.validateResource({
      owner: 'alice',
      principal: 'user:alice',
      agent: null,
      admin: false,
      resourceId: resource.id,
      purpose: 'chat',
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
        models: [{ name: 'local/model', dimensions: null, status: MODEL_STATUS.available }],
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
      purpose: 'chat',
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
        models: [{ name: 'local/model', dimensions: null, status: MODEL_STATUS.available }],
      }),
    )
    await registry.validateResource({
      owner: 'alice',
      principal: 'user:alice',
      agent: null,
      admin: false,
      resourceId: resource.id,
      purpose: 'chat',
      signal: AbortSignal.timeout(5_000),
    })
    const record = (await db.providerResources.get(resource.id))!

    expect(registry.resourceToWire(record, { owner: 'alice' }).lastCheck.chat).toMatchObject({
      status: PROVIDER_STATUS.unreachable,
      diagnostic: expect.stringContaining('ECONNREFUSED'),
    })
    expect(
      registry.resourceToWire(record, { owner: 'bob', admin: true }).lastCheck.chat,
    ).toMatchObject({ diagnostic: expect.stringContaining('ECONNREFUSED') })
    expect(registry.resourceToWire(record, { owner: 'bob' }).lastCheck.chat).toEqual({
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
        models: [{ name: 'openai/gpt-4.1-nano', dimensions: null, status: MODEL_STATUS.available }],
      }),
    )
    const record = (await db.providerResources.get(resource.id))!
    const withCheck = {
      ...record,
      lastCheck: {
        chat: {
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
    expect(registry.resourceToWire(withCheck, { owner: 'alice' }).lastCheck.chat).toMatchObject({
      status: PROVIDER_STATUS.credentialRejected,
      diagnostic: 'No auth credentials found',
    })
    expect(registry.resourceToWire(withCheck, { owner: 'bob' }).lastCheck.chat).toMatchObject({
      status: PROVIDER_STATUS.credentialRejected,
      diagnostic: null,
    })
    expect(
      registry.resourceToWire(
        {
          ...record,
          allowPrivateNetwork: true,
          baseUrl: `http://provider.test:${port}/api/v1`,
          lastCheck: {
            chat: {
              status: PROVIDER_STATUS.disabled,
              checkedAt: '2026-08-24T09:00:00.000Z',
              diagnostic: null,
              credentialProven: false,
            },
          },
        },
        { owner: 'bob' },
      ).lastCheck.chat,
    ).toMatchObject({ status: PROVIDER_STATUS.disabled })
  })

  it('answers nothing for a foreign resource and refuses an undeclared purpose', async () => {
    const port = await listen((_request, response) => {
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
        purpose: 'chat',
        signal: AbortSignal.timeout(5_000),
      }),
    ).resolves.toBeNull()
    await expect(
      registry.validateResource({
        owner: 'alice',
        principal: 'user:alice',
        agent: null,
        admin: false,
        resourceId: resource.id,
        purpose: 'embedding',
        signal: AbortSignal.timeout(5_000),
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_VALIDATION' })
  })
})
