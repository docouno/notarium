import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type RequestListener, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ATTACHMENT_STATE,
  CredentialCreateRequestSchema,
  MODEL_STATUS,
  PROVIDER_CALL_ERROR,
  ProviderResourceCreateRequestSchema,
} from '@notarium/contract'

import { CredentialKeyring, CredentialKeyringService } from '../credentialKeyring'
import { SqliteMetaDb } from '../metaDb/sqliteMetaDb'
import { PROVIDER_CALL_KIND, PROVIDER_RETRY_MODE, ProviderRuntime } from '../providerRuntime'
import { providerDisclosureOf } from './attachments'
import { ProviderRegistry } from './providerRegistry'

const NOW = '2026-08-25T00:00:00.000Z'
const SPACE = 'space-main'
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

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('provider scope call', () => {
  let root: string
  let db: SqliteMetaDb
  let keyring: CredentialKeyringService

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'notarium-provider-scope-call-'))
    db = new SqliteMetaDb(join(root, 'meta.sqlite'))
    keyring = new CredentialKeyringService({
      persistence: db.secretKeyring,
      keyring: new CredentialKeyring(join(root, 'keyring'), []),
      ciphertexts: db.providerCiphertexts,
    })
    await keyring.bootstrap()
    await db.spaces.upsert({
      id: SPACE,
      slug: 'main',
      displayName: 'Main',
      notesDir: 'main',
      aliases: [],
      createdAt: NOW,
      archivedAt: null,
      archivedBy: null,
    })
    await db.auth.createUser({
      username: 'alice',
      displayName: 'Alice',
      passwordHash: null,
      admin: false,
      disabledAt: null,
      createdAt: NOW,
      personalSpace: null,
    })
    await db.auth.upsertMember(SPACE, 'alice', 'owner', NOW)
  })

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
    await db.close()
    rmSync(root, { recursive: true, force: true })
  })

  it.each(['resource', 'credential', 'resolution-read', 'model-status'] as const)(
    'rechecks the captured %s state after preparation and before intent/send',
    async (changed) => {
      let requests = 0
      const port = await listen((_request, response) => {
        requests += 1
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end(
          'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n' +
            'data: [DONE]\n\n',
        )
      })
      const origin = `http://provider.test:${port}`
      const runtime = new ProviderRuntime({
        privateOrigins: new Set([origin]),
        callLog: db.providerCallLog,
        transport: { lookup: async () => [{ address: '127.0.0.1', family: 4 }] },
      })
      const registry = new ProviderRegistry({
        credentials: db.credentials,
        resources: db.providerResources,
        attachments: db.providerAttachments,
        attachmentLifecycle: db,
        spaces: db.spaces,
        projects: db.projects,
        directory: db.auth,
        keyring,
        privateOrigins: new Set([origin]),
        runtime,
      })
      const credential = await registry.createCredential(
        'alice',
        CredentialCreateRequestSchema.parse({
          name: 'Local',
          kind: 'bearer',
          secret: 'sk-local-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          origin,
          injection: { header: '', prefix: 'Bearer ' },
        }),
      )
      const { resource } = await registry.createResource(
        'alice',
        ProviderResourceCreateRequestSchema.parse({
          name: 'Local',
          wire: 'openai-compatible',
          baseUrl: `${origin}/api/v1`,
          allowPrivateNetwork: true,
          credentialId: credential.id,
          models: [
            { name: 'local/model', capabilities: ['completion'] },
            { name: 'other/model', capabilities: ['completion'] },
          ],
        }),
      )
      await db.offerProviderAttachment(
        {
          id: 'attachment-1',
          resourceId: resource.id,
          targetKind: 'space',
          targetId: SPACE,
          targetSpace: SPACE,
          state: ATTACHMENT_STATE.active,
          resourceEpoch: 0,
          credentialEpoch: 0,
          disclosure: null,
          createdAt: NOW,
          expiresAt: '2026-09-08T00:00:00.000Z',
        },
        providerDisclosureOf,
      )
      const decryptStarted = deferred()
      const releaseDecrypt = deferred()
      const decrypt = keyring.decryptMany.bind(keyring)

      let firstDecrypt = true

      keyring.decryptMany = async (...args: Parameters<typeof keyring.decryptMany>) => {
        if (firstDecrypt) {
          firstDecrypt = false
          decryptStarted.resolve()
          await releaseDecrypt.promise
        }

        return decrypt(...args)
      }
      const calling = registry.executeForScope({
        space: SPACE,
        principal: 'user:alice',
        agent: null,
        resourceId: resource.id,
        operation: {
          kind: PROVIDER_CALL_KIND.chat,
          model: 'local/model',
          messages: [{ role: 'user', content: 'test' }],
          stream: true,
          maxOutputTokens: 16,
        },
        retryMode: PROVIDER_RETRY_MODE.none,
        job: { jobId: 'job-1', jobCallKey: 'reply' },
        rateLimit: { inputUpperBound: 4, outputTokenBudget: 16 },
        signal: AbortSignal.timeout(5_000),
      })

      await decryptStarted.promise
      if (changed === 'credential') {
        await registry.updateCredential('alice', credential.id, { rpm: 2 })
      } else if (changed === 'resource') {
        await registry.updateResource('alice', resource.id, { callTimeoutMs: 1_000 })
      } else if (changed === 'resolution-read') {
        db.providerAttachments.listForSpaces = async () => {
          throw new Error('meta db unavailable')
        }
      } else {
        await db.providerResources.recordLastCheck({
          resourceId: resource.id,
          capability: 'completion',
          lastCheck: {
            status: 'not-configured',
            checkedAt: NOW,
            diagnostic: null,
            credentialProven: true,
          },
          measurement: { modelName: 'local/model', status: MODEL_STATUS.unavailable },
          expectedRuntimeEpoch: 0,
          expectedCredentialId: credential.id,
          expectedCredentialRuntimeEpoch: 0,
        })
      }
      releaseDecrypt.resolve()

      await expect(calling).rejects.toMatchObject({
        code:
          changed === 'model-status'
            ? PROVIDER_CALL_ERROR.modelUnavailable
            : PROVIDER_CALL_ERROR.policyDenied,
        deliveryState: 'not-sent',
        ...(changed === 'model-status' ? {} : { retrySafe: true }),
      })
      expect(requests).toBe(0)
      expect(await db.providerCallLog.listForOwner('alice')).toEqual([])
      runtime.close()
    },
  )
})
