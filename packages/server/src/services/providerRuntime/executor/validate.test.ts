import { createServer, type RequestListener, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PROVIDER_CALL_OUTCOME,
  PROVIDER_DELIVERY_STATE,
  PROVIDER_STATUS,
  PURPOSE,
  WIRE,
} from '@notarium/contract'

import type { ProviderCallIntentInput, ProviderCallLogRecord } from '../../metaDb'
import { ProviderRuntime } from '../providerRuntime'
import { ProviderHostCapError } from '../rateLimiter'
import type { ProviderCallContext, ProviderEndpoint } from '../types'

const CALL: ProviderCallContext = {
  owner: 'alice',
  principal: 'user:alice',
  agent: null,
  resourceId: 'resource-a',
  credentialId: 'credential-a',
  spaces: [],
  job: null,
  rateLimit: { rpm: 1_000, tpm: null, inputUpperBound: 0, outputTokenBudget: 0 },
}

/** Counts the journal rows a probe opens: one per request that was allowed to leave,
 *  which is what makes the parameter ladder observable as TWO paid calls. */
const countingJournal = () => {
  const intents: ProviderCallIntentInput[] = []

  return {
    intents,
    intent: async (input: ProviderCallIntentInput) => {
      intents.push(input)
      return {
        status: 'recorded' as const,
        record: {
          ...input,
          spaces: [...input.spaces],
          jobId: null,
          jobCallKey: null,
          attemptNo: null,
          deliveryState: PROVIDER_DELIVERY_STATE.mayHaveSent,
          retrySafe: false,
          outcome: PROVIDER_CALL_OUTCOME.inFlight,
          usage: null,
          settledAt: null,
        } satisfies ProviderCallLogRecord,
      }
    },
    settle: async () => null,
  }
}

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

const bodyOf = async (request: Parameters<RequestListener>[0]): Promise<string> => {
  const chunks: Buffer[] = []

  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk))
  }

  return Buffer.concat(chunks).toString('utf8')
}

const json = (response: Parameters<RequestListener>[1], status: number, body: unknown): void => {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

const endpoint = (port: number, wire: ProviderEndpoint['wire']): ProviderEndpoint => ({
  principalId: 'user:alice',
  wire,
  baseUrl:
    wire === WIRE.openaiCompatible
      ? `http://provider.test:${port}/api/v1`
      : `http://provider.test:${port}`,
  headers: new Map([['authorization', 'Bearer sk-secret-value']]),
  sensitiveValues: new Set(['sk-secret-value']),
  allowPrivateNetwork: true,
  firstByteTimeoutMs: null,
  callTimeoutMs: null,
})

const runtime = (port: number, now?: () => number) => {
  const journal = countingJournal()
  const subject = new ProviderRuntime({
    privateOrigins: new Set([`http://provider.test:${port}`]),
    callLog: journal,
    transport: { lookup: async () => [{ address: '127.0.0.1', family: 4 }] },
    ...(now ? { rateLimiter: { now } } : {}),
  })

  return {
    journal,
    // Exactly the registry's order: admission bounds the operation, the probe runs
    // only after it.
    validate: async (owner: string, input: Parameters<ProviderRuntime['validate']>[0]) => {
      await subject.admitValidate(owner)
      return subject.validate(input)
    },
  }
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

describe('provider validate probe', () => {
  it('proves an openrouter key without paying for inference', async () => {
    const seen: string[] = []
    const port = await listen((request, response) => {
      seen.push(`${request.method} ${request.url}`)
      json(response, 200, { data: { limit_remaining: 6.21 } })
    })
    const outcome = await runtime(port).validate('alice', {
      endpoint: endpoint(port, WIRE.openaiCompatible),
      purpose: PURPOSE.chat,
      vendor: 'openrouter',
      call: CALL,
      model: 'openai/gpt-4.1-nano',
      signal: AbortSignal.timeout(5_000),
    })

    expect(seen).toEqual(['GET /api/v1/key'])
    expect(outcome).toMatchObject({ status: PROVIDER_STATUS.ready, credentialProven: true })
  })

  it('classifies a corrupted openrouter key rather than reporting a 4xx', async () => {
    const port = await listen((_request, response) => {
      json(response, 401, { error: { message: 'No auth credentials found' } })
    })
    const outcome = await runtime(port).validate('alice', {
      endpoint: endpoint(port, WIRE.openaiCompatible),
      purpose: PURPOSE.chat,
      vendor: 'openrouter',
      call: CALL,
      model: null,
      signal: AbortSignal.timeout(5_000),
    })

    expect(outcome).toMatchObject({
      status: PROVIDER_STATUS.credentialRejected,
      credentialProven: false,
    })
  })

  it('runs a minimal inference for any other openai-compatible vendor', async () => {
    let payload: Record<string, unknown> = {}
    const seen: string[] = []
    const port = await listen(async (request, response) => {
      seen.push(`${request.method} ${request.url}`)
      payload = JSON.parse(await bodyOf(request)) as Record<string, unknown>
      json(response, 200, {
        choices: [{ message: { content: 'ok' }, finish_reason: 'length' }],
      })
    })
    const outcome = await runtime(port).validate('alice', {
      endpoint: endpoint(port, WIRE.openaiCompatible),
      purpose: PURPOSE.chat,
      vendor: 'generic',
      call: CALL,
      model: 'local/model',
      signal: AbortSignal.timeout(5_000),
    })

    expect(seen).toEqual(['POST /api/v1/chat/completions'])
    expect(payload).toMatchObject({ model: 'local/model', max_tokens: 1, stream: false })
    expect(outcome).toMatchObject({ status: PROVIDER_STATUS.ready, credentialProven: true })
  })

  it('climbs exactly one rung to the alternative token-limit field', async () => {
    const fields: string[] = []
    const port = await listen(async (request, response) => {
      const payload = JSON.parse(await bodyOf(request)) as Record<string, unknown>
      const field = Object.hasOwn(payload, 'max_tokens') ? 'max_tokens' : 'max_completion_tokens'
      fields.push(field)
      if (field === 'max_tokens') {
        json(response, 400, { error: { message: 'Unsupported parameter: max_tokens' } })
        return
      }
      json(response, 200, { choices: [{ message: { content: 'ok' }, finish_reason: 'length' }] })
    })
    const outcome = await runtime(port).validate('alice', {
      endpoint: endpoint(port, WIRE.openaiCompatible),
      purpose: PURPOSE.chat,
      vendor: 'generic',
      call: CALL,
      model: 'local/model',
      signal: AbortSignal.timeout(5_000),
    })

    expect(fields).toEqual(['max_tokens', 'max_completion_tokens'])
    expect(outcome).toMatchObject({ status: PROVIDER_STATUS.ready })
  })

  it('stops at two paid calls and reports parameters-rejected, never a transient class', async () => {
    const fields: string[] = []
    const port = await listen(async (request, response) => {
      const payload = JSON.parse(await bodyOf(request)) as Record<string, unknown>
      fields.push(Object.hasOwn(payload, 'max_tokens') ? 'max_tokens' : 'max_completion_tokens')
      json(response, 400, { error: { message: 'Unsupported parameter for this model' } })
    })
    const subject = runtime(port)
    const outcome = await subject.validate('alice', {
      endpoint: endpoint(port, WIRE.openaiCompatible),
      purpose: PURPOSE.chat,
      vendor: 'generic',
      call: CALL,
      model: 'local/model',
      signal: AbortSignal.timeout(5_000),
    })

    expect(fields).toEqual(['max_tokens', 'max_completion_tokens'])
    expect(outcome.status).toBe(PROVIDER_STATUS.parametersRejected)
    expect(outcome.status).not.toBe(PROVIDER_STATUS.unreachable)
    // One click, two paid requests, two rows: the journal counts what LEFT, not
    // what the button did.
    expect(subject.journal.intents).toHaveLength(2)
  })

  it('measures the embedding width from the answer and never from the request', async () => {
    let payload: Record<string, unknown> = {}
    const port = await listen(async (request, response) => {
      payload = JSON.parse(await bodyOf(request)) as Record<string, unknown>
      json(response, 200, {
        data: [{ embedding: Array.from({ length: 768 }, () => 0.5) }],
        usage: { prompt_tokens: 6 },
      })
    })
    const outcome = await runtime(port).validate('alice', {
      endpoint: endpoint(port, WIRE.openaiCompatible),
      purpose: PURPOSE.embedding,
      vendor: 'openrouter',
      call: CALL,
      model: 'embed/model',
      signal: AbortSignal.timeout(5_000),
    })

    // Even at OpenRouter the embedding purpose pays for a real embed: `/key` does
    // not measure a vector, and measuring it is half the point of the row.
    expect(payload).toMatchObject({ model: 'embed/model' })
    expect(outcome).toMatchObject({ status: PROVIDER_STATUS.ready, dimensions: 768 })
  })

  it('checks ollama reachability only, and says so even with an arbitrary bearer', async () => {
    const seen: string[] = []
    const port = await listen((request, response) => {
      seen.push(`${request.method} ${request.url}`)
      json(response, 200, { models: [{ model: 'qwen' }] })
    })
    const outcome = await runtime(port).validate('alice', {
      endpoint: endpoint(port, WIRE.ollama),
      purpose: PURPOSE.chat,
      vendor: 'generic',
      call: CALL,
      model: 'qwen',
      signal: AbortSignal.timeout(5_000),
    })

    expect(seen).toEqual(['GET /api/tags'])
    expect(outcome).toMatchObject({ status: PROVIDER_STATUS.ready, credentialProven: false })
  })

  it('uses the ollama native embed endpoint, not the openai facade', async () => {
    const seen: string[] = []
    const port = await listen((request, response) => {
      seen.push(`${request.method} ${request.url}`)
      json(response, 200, { embeddings: [Array.from({ length: 768 }, () => 0.25)] })
    })
    const outcome = await runtime(port).validate('alice', {
      endpoint: endpoint(port, WIRE.ollama),
      purpose: PURPOSE.embedding,
      vendor: 'generic',
      call: CALL,
      model: 'embeddinggemma',
      signal: AbortSignal.timeout(5_000),
    })

    expect(seen).toEqual(['POST /api/embed'])
    expect(outcome).toMatchObject({
      status: PROVIDER_STATUS.ready,
      dimensions: 768,
      credentialProven: false,
    })
  })

  it('reports a vanished model against the model, leaving the record not-configured', async () => {
    const port = await listen((_request, response) => {
      json(response, 404, { error: { message: 'No endpoints found for openai/ghost' } })
    })
    const outcome = await runtime(port).validate('alice', {
      endpoint: endpoint(port, WIRE.openaiCompatible),
      purpose: PURPOSE.chat,
      vendor: 'generic',
      call: CALL,
      model: 'openai/ghost',
      signal: AbortSignal.timeout(5_000),
    })

    expect(outcome).toMatchObject({
      status: PROVIDER_STATUS.notConfigured,
      modelUnavailable: true,
    })
  })

  it('answers not-configured without a socket when no model serves the purpose', async () => {
    let requests = 0
    const port = await listen((_request, response) => {
      requests += 1
      json(response, 200, {})
    })
    const outcome = await runtime(port).validate('alice', {
      endpoint: endpoint(port, WIRE.openaiCompatible),
      purpose: PURPOSE.embedding,
      vendor: 'openrouter',
      call: CALL,
      model: null,
      signal: AbortSignal.timeout(5_000),
    })

    expect(requests).toBe(0)
    expect(outcome).toMatchObject({ status: PROVIDER_STATUS.notConfigured })
  })

  it('keeps the credential out of the diagnostic it persists', async () => {
    const port = await listen((_request, response) => {
      json(response, 403, {
        error: { message: 'rejected header authorization: Bearer sk-secret-value' },
      })
    })
    const outcome = await runtime(port).validate('alice', {
      endpoint: endpoint(port, WIRE.openaiCompatible),
      purpose: PURPOSE.chat,
      vendor: 'generic',
      call: CALL,
      model: 'local/model',
      signal: AbortSignal.timeout(5_000),
    })

    expect(outcome.diagnostic).toContain('[redacted]')
    expect(outcome.diagnostic).not.toContain('sk-secret-value')
  })

  it('refuses the twenty-first call in the window regardless of any user limit', async () => {
    let at = 1_700_000_000_000
    const port = await listen((_request, response) => {
      json(response, 200, { data: { limit_remaining: 1 } })
    })
    const subject = runtime(port, () => at)
    const call = () =>
      subject.validate('alice', {
        endpoint: endpoint(port, WIRE.openaiCompatible),
        purpose: PURPOSE.chat,
        vendor: 'openrouter',
        call: CALL,
        model: null,
        signal: AbortSignal.timeout(5_000),
      })

    for (let index = 0; index < 20; index += 1) {
      await expect(call()).resolves.toMatchObject({ status: PROVIDER_STATUS.ready })
    }
    await expect(call()).rejects.toBeInstanceOf(ProviderHostCapError)
    // A different owner has its own window; the ceiling is per agent owner.
    await expect(
      subject.validate('bob', {
        endpoint: endpoint(port, WIRE.openaiCompatible),
        purpose: PURPOSE.chat,
        vendor: 'openrouter',
        call: CALL,
        model: null,
        signal: AbortSignal.timeout(5_000),
      }),
    ).resolves.toMatchObject({ status: PROVIDER_STATUS.ready })

    at += 60 * 60 * 1000 + 1
    await expect(call()).resolves.toMatchObject({ status: PROVIDER_STATUS.ready })
  })
})
