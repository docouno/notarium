import { createServer, type RequestListener, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  PROVIDER_CALL_ERROR,
  PROVIDER_CALL_OUTCOME,
  PROVIDER_DELIVERY_STATE,
  WIRE,
} from '@notarium/contract'

import type {
  ProviderCallIntentInput,
  ProviderCallLogRecord,
  ProviderCallSettleInput,
} from '../../metaDb'
import { ProviderCallError } from '../errors'
import { ProviderRuntime } from '../providerRuntime'
import {
  PROVIDER_CALL_KIND,
  PROVIDER_RETRY_MODE,
  PROVIDER_TOKEN_LIMIT_FIELD,
  type ProviderCallContext,
  type ProviderEndpoint,
} from '../types'

const CALL: ProviderCallContext = {
  owner: 'alice',
  principal: 'user:alice',
  agent: null,
  resourceId: 'resource-a',
  credentialId: 'credential-a',
  spaces: [],
  job: null,
  rateLimit: {
    rpm: 1_000,
    tpm: null,
    inputUpperBound: 8,
    outputTokenBudget: 16,
  },
}

/** A journal double that records both phases. The real fence lives in the drivers and
 *  is proved by the meta-DB contract suite; what the executor owes is ORDER — an
 *  intent before every send, and exactly one outcome closing it. */
const recordingJournal = () => {
  const rows: Array<{
    id: string
    input: ProviderCallIntentInput
    outcome?: ProviderCallSettleInput
  }> = []
  let refuse: ProviderCallLogRecord | null = null

  return {
    rows,
    refuseWith: (record: ProviderCallLogRecord) => {
      refuse = record
    },
    intent: async (input: ProviderCallIntentInput) => {
      if (refuse) {
        return { status: 'blocked' as const, record: refuse }
      }
      const record = {
        ...input,
        spaces: [...input.spaces],
        jobId: input.job?.jobId ?? null,
        jobCallKey: input.job?.jobCallKey ?? null,
        attemptNo: input.job ? 1 : null,
        deliveryState: PROVIDER_DELIVERY_STATE.mayHaveSent,
        retrySafe: false,
        outcome: PROVIDER_CALL_OUTCOME.inFlight,
        usage: null,
        settledAt: null,
      } satisfies ProviderCallLogRecord
      rows.push({ id: input.id, input })
      return { status: 'recorded' as const, record }
    },
    settle: async (input: ProviderCallSettleInput) => {
      const row = rows.find((candidate) => candidate.id === input.id)

      if (row) {
        row.outcome = input
      }

      return null
    },
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

const endpoint = (port: number, wire: ProviderEndpoint['wire']): ProviderEndpoint => ({
  principalId: 'owner-1',
  wire,
  baseUrl:
    wire === WIRE.openaiCompatible
      ? `http://provider.test:${port}/v1`
      : `http://provider.test:${port}`,
  headers: new Map(),
  sensitiveValues: new Set(),
  allowPrivateNetwork: true,
  firstByteTimeoutMs: null,
  callTimeoutMs: null,
})

let journal = recordingJournal()

const runtime = (
  port: number,
  options: ConstructorParameters<typeof ProviderRuntime>[0]['executor'] = {},
) =>
  new ProviderRuntime({
    privateOrigins: new Set([`http://provider.test:${port}`]),
    callLog: journal,
    transport: { lookup: async () => [{ address: '127.0.0.1', family: 4 }] },
    executor: options,
  })

beforeEach(() => {
  journal = recordingJournal()
})

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

describe('provider executor', () => {
  it('journals an own-limit refusal without opening another upstream send', async () => {
    let requests = 0
    const port = await listen((_request, response) => {
      requests += 1
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ data: [] }))
    })
    const subject = runtime(port)
    const limited = {
      endpoint: endpoint(port, WIRE.openaiCompatible),
      operation: { kind: PROVIDER_CALL_KIND.models } as const,
      retryMode: PROVIDER_RETRY_MODE.none,
      call: { ...CALL, rateLimit: { ...CALL.rateLimit, rpm: 1 } },
    }

    await subject.execute({ ...limited, signal: new AbortController().signal })
    const controllers = Array.from({ length: 13 }, () => new AbortController())
    const waiting = controllers
      .slice(0, 12)
      .map((controller) => subject.execute({ ...limited, signal: controller.signal }))

    await expect(
      subject.execute({ ...limited, signal: controllers[12].signal }),
    ).rejects.toMatchObject({ code: PROVIDER_CALL_ERROR.notariumRateLimited })
    expect(requests).toBe(1)
    expect(journal.rows.at(-1)?.outcome).toMatchObject({
      deliveryState: PROVIDER_DELIVERY_STATE.notSent,
      outcome: PROVIDER_CALL_ERROR.notariumRateLimited,
    })

    for (const controller of controllers) {
      controller.abort(new Error('test cleanup'))
    }
    await Promise.allSettled(waiting)
  })

  it('refuses a token-bearing call whose caller omitted its estimator', async () => {
    let requests = 0
    const port = await listen((_request, response) => {
      requests += 1
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }))
    })
    const malformed = {
      ...CALL,
      rateLimit: {
        ...CALL.rateLimit,
        inputUpperBound: undefined,
      },
    } as unknown as ProviderCallContext

    await expect(
      runtime(port).execute({
        endpoint: endpoint(port, WIRE.openaiCompatible),
        operation: {
          kind: PROVIDER_CALL_KIND.chat,
          model: 'model-a',
          messages: [{ role: 'user', content: 'hello' }],
          stream: false,
          maxOutputTokens: 16,
        },
        retryMode: PROVIDER_RETRY_MODE.none,
        call: malformed,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: PROVIDER_CALL_ERROR.invalidRequest })
    expect(requests).toBe(0)
    expect(journal.rows).toHaveLength(0)
  })

  it.each([
    {
      name: 'zero estimator and output budget',
      rateLimit: { rpm: 10, tpm: 100, inputUpperBound: 0, outputTokenBudget: 0 },
      maxOutputTokens: 10,
    },
    {
      name: 'output reserve below the wire cap',
      rateLimit: { rpm: 10, tpm: 100, inputUpperBound: 10, outputTokenBudget: 1 },
      maxOutputTokens: 10,
    },
  ])('refuses $name before intent and send', async ({ rateLimit, maxOutputTokens }) => {
    let requests = 0
    const port = await listen((_request, response) => {
      requests += 1
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }))
    })

    await expect(
      runtime(port).execute({
        endpoint: endpoint(port, WIRE.openaiCompatible),
        operation: {
          kind: PROVIDER_CALL_KIND.chat,
          model: 'model-a',
          messages: [{ role: 'user', content: 'hello' }],
          stream: false,
          maxOutputTokens,
        },
        retryMode: PROVIDER_RETRY_MODE.none,
        call: { ...CALL, rateLimit },
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: PROVIDER_CALL_ERROR.invalidRequest })
    expect(requests).toBe(0)
    expect(journal.rows).toHaveLength(0)
  })

  it('charges one logical input reserve across two physical embedding batches', async () => {
    let requests = 0
    const port = await listen((_request, response) => {
      requests += 1
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          data: [{ embedding: [0.25] }],
          usage: { prompt_tokens: 40, total_tokens: 40 },
        }),
      )
    })
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(new Error('repeated logical reserve')), 100)

    try {
      await expect(
        runtime(port).execute({
          endpoint: endpoint(port, WIRE.openaiCompatible),
          operation: {
            kind: PROVIDER_CALL_KIND.embedding,
            model: 'embedding-model',
            input: ['first', 'second'],
            dimensions: null,
          },
          retryMode: PROVIDER_RETRY_MODE.none,
          call: {
            ...CALL,
            rateLimit: { rpm: 10, tpm: 100, inputUpperBound: 80, outputTokenBudget: 0 },
          },
          signal: controller.signal,
        }),
      ).resolves.toMatchObject({ embeddings: [[0.25], [0.25]] })
    } finally {
      clearTimeout(timeout)
    }
    expect(requests).toBe(2)
  })

  it('applies observed embedding excess before the next physical batch', async () => {
    let requests = 0
    const port = await listen((_request, response) => {
      requests += 1
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          data: [{ embedding: [0.25] }],
          usage: { prompt_tokens: 120, total_tokens: 120 },
        }),
      )
    })
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(new Error('observed TPM excess')), 100)

    try {
      await expect(
        runtime(port).execute({
          endpoint: endpoint(port, WIRE.openaiCompatible),
          operation: {
            kind: PROVIDER_CALL_KIND.embedding,
            model: 'embedding-model',
            input: ['first', 'second'],
            dimensions: null,
          },
          retryMode: PROVIDER_RETRY_MODE.none,
          call: {
            ...CALL,
            rateLimit: { rpm: 10, tpm: 100, inputUpperBound: 80, outputTokenBudget: 0 },
          },
          signal: controller.signal,
        }),
      ).rejects.toMatchObject({ code: PROVIDER_CALL_ERROR.canceled })
    } finally {
      clearTimeout(timeout)
    }
    expect(requests).toBe(1)
  })

  it('turns a limiter wait deadline into an own refusal before another send', async () => {
    let requests = 0
    const port = await listen((_request, response) => {
      requests += 1
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ data: [] }))
    })
    const subject = runtime(port)
    const limited = {
      endpoint: { ...endpoint(port, WIRE.openaiCompatible), firstByteTimeoutMs: 100 },
      operation: { kind: PROVIDER_CALL_KIND.models } as const,
      retryMode: PROVIDER_RETRY_MODE.none,
      call: { ...CALL, rateLimit: { ...CALL.rateLimit, rpm: 1 } },
    }

    await subject.execute({ ...limited, signal: new AbortController().signal })
    await expect(
      subject.execute({ ...limited, signal: AbortSignal.timeout(500) }),
    ).rejects.toMatchObject({ code: PROVIDER_CALL_ERROR.notariumRateLimited })
    expect(requests).toBe(1)
  })

  it('rechecks captured liveness after admission and before journal intent', async () => {
    let requests = 0
    const port = await listen((_request, response) => {
      requests += 1
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ data: [] }))
    })

    await expect(
      runtime(port).execute({
        endpoint: endpoint(port, WIRE.openaiCompatible),
        operation: { kind: PROVIDER_CALL_KIND.models },
        retryMode: PROVIDER_RETRY_MODE.none,
        call: CALL,
        signal: new AbortController().signal,
        beforeSend: async () => false,
      }),
    ).rejects.toMatchObject({
      code: PROVIDER_CALL_ERROR.canceled,
      deliveryState: PROVIDER_DELIVERY_STATE.notSent,
    })
    expect(requests).toBe(0)
    expect(journal.rows).toHaveLength(0)
  })

  it('charges observed tokens above reserve before admitting the next call', async () => {
    let requests = 0
    const port = await listen((_request, response) => {
      requests += 1
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
        }),
      )
    })
    const subject = runtime(port)
    const request = {
      endpoint: endpoint(port, WIRE.openaiCompatible),
      operation: {
        kind: PROVIDER_CALL_KIND.chat,
        model: 'model-a',
        messages: [{ role: 'user' as const, content: 'hello' }],
        stream: false,
        maxOutputTokens: 1,
      },
      retryMode: PROVIDER_RETRY_MODE.none,
    }

    await subject.execute({
      ...request,
      call: {
        ...CALL,
        rateLimit: { rpm: 10, tpm: 10, inputUpperBound: 1, outputTokenBudget: 1 },
      },
      signal: new AbortController().signal,
    })
    const controller = new AbortController()
    const waiting = subject.execute({
      ...request,
      call: {
        ...CALL,
        rateLimit: { rpm: 10, tpm: 10, inputUpperBound: 2, outputTokenBudget: 1 },
      },
      signal: controller.signal,
    })
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(requests).toBe(1)
    controller.abort(new Error('test timeout'))
    await expect(waiting).rejects.toMatchObject({ code: PROVIDER_CALL_ERROR.canceled })
  })

  it('streams OpenAI SSE, requests usage, and keeps absent counters unknown', async () => {
    let sentPayload: Record<string, unknown> = {}
    const port = await listen(async (request, response) => {
      sentPayload = JSON.parse(await bodyOf(request)) as Record<string, unknown>
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write('data: {"choices":[{"delta":{"content":"hel"},"finish_reason":null}]}\n\n')
      response.write('data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}\n\n')
      response.write(
        'data: {"choices":[],"usage":{"prompt_tokens":3,"cost":0.001,"is_byok":true,' +
          '"cost_details":{"upstream_inference_cost":0.0008},' +
          '"prompt_tokens_details":{"cached_tokens":2},' +
          '"completion_tokens_details":{"reasoning_tokens":1}}}\n\n',
      )
      response.end('data: [DONE]\n\n')
    })
    const chunks: string[] = []
    const result = await runtime(port).execute({
      endpoint: endpoint(port, WIRE.openaiCompatible),
      operation: {
        kind: PROVIDER_CALL_KIND.chat,
        model: 'model-a',
        messages: [{ role: 'user', content: 'hello' }],
        stream: true,
        maxOutputTokens: 16,
      },
      retryMode: PROVIDER_RETRY_MODE.none,
      call: CALL,
      signal: new AbortController().signal,
      onText: ({ text }) => {
        chunks.push(text)
      },
    })

    expect(result).toEqual({
      kind: PROVIDER_CALL_KIND.chat,
      text: 'hello',
      finishReason: 'stop',
      usage: {
        source: 'openai-compatible',
        promptTokens: 3,
        completionTokens: null,
        totalTokens: null,
        reasoningTokens: 1,
        cachedPromptTokens: 2,
        cost: 0.001,
        isByok: true,
        costDetails: { upstream_inference_cost: 0.0008 },
      },
    })
    expect(chunks).toEqual(['hel', 'lo'])
    expect(sentPayload).toMatchObject({ stream_options: { include_usage: true } })
  })

  it('serializes exactly the selected OpenAI token-limit field', async () => {
    const payloads: Array<Record<string, unknown>> = []
    const port = await listen(async (request, response) => {
      payloads.push(JSON.parse(await bodyOf(request)) as Record<string, unknown>)
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }),
      )
    })
    const subject = runtime(port)
    const call = (
      tokenLimitField?: (typeof PROVIDER_TOKEN_LIMIT_FIELD)[keyof typeof PROVIDER_TOKEN_LIMIT_FIELD],
    ) =>
      subject.execute({
        endpoint: endpoint(port, WIRE.openaiCompatible),
        operation: {
          kind: PROVIDER_CALL_KIND.chat,
          model: 'model-a',
          messages: [{ role: 'user', content: 'probe' }],
          stream: false,
          maxOutputTokens: 16,
          tokenLimitField,
        },
        retryMode: PROVIDER_RETRY_MODE.none,
        call: CALL,
        signal: new AbortController().signal,
      })

    await call()
    await call(PROVIDER_TOKEN_LIMIT_FIELD.maxCompletionTokens)
    expect(payloads[0]).toMatchObject({ max_tokens: 16 })
    expect(payloads[0]).not.toHaveProperty('max_completion_tokens')
    expect(payloads[1]).toMatchObject({ max_completion_tokens: 16 })
    expect(payloads[1]).not.toHaveProperty('max_tokens')
  })

  it('streams Ollama NDJSON and reads exact native counters from the final object', async () => {
    const port = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/x-ndjson' })
      response.write('{"message":{"content":"one"},"done":false}\n')
      response.end(
        '{"message":{"content":" two"},"done":true,"done_reason":"stop",' +
          '"total_duration":10,"load_duration":2,"prompt_eval_count":4,' +
          '"prompt_eval_duration":3,"eval_count":5,"eval_duration":6}\n',
      )
    })
    const chunks: string[] = []
    const result = await runtime(port).execute({
      endpoint: endpoint(port, WIRE.ollama),
      operation: {
        kind: PROVIDER_CALL_KIND.chat,
        model: 'local-a',
        messages: [{ role: 'user', content: 'hello' }],
        stream: true,
        maxOutputTokens: 16,
      },
      retryMode: PROVIDER_RETRY_MODE.none,
      call: CALL,
      signal: new AbortController().signal,
      onText: ({ text }) => {
        chunks.push(text)
      },
    })

    expect(result).toEqual({
      kind: PROVIDER_CALL_KIND.chat,
      text: 'one two',
      finishReason: 'stop',
      usage: {
        source: 'ollama-native',
        totalDurationNs: 10,
        loadDurationNs: 2,
        promptEvalCount: 4,
        promptEvalDurationNs: 3,
        evalCount: 5,
        evalDurationNs: 6,
      },
    })
    expect(chunks).toEqual(['one', ' two'])
  })

  it('normalizes Ollama non-stream chat, embedding, and discovery', async () => {
    const payloads = new Map<string, Record<string, unknown>>()
    const port = await listen(async (request, response) => {
      if (request.method === 'POST') {
        payloads.set(
          request.url ?? '',
          JSON.parse(await bodyOf(request)) as Record<string, unknown>,
        )
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      if (request.url === '/api/chat') {
        response.end(
          JSON.stringify({
            message: { content: 'chat-ok' },
            done: true,
            done_reason: 'stop',
            prompt_eval_count: 2,
            eval_count: 3,
          }),
        )
      } else if (request.url === '/api/embed') {
        response.end(
          JSON.stringify({
            embeddings: [
              [0.1, 0.2],
              [0.3, 0.4],
            ],
            prompt_eval_count: 4,
          }),
        )
      } else {
        response.end(JSON.stringify({ models: [{ model: 'local-a' }, { name: 'local-b' }] }))
      }
    })
    const subject = runtime(port)
    const target = endpoint(port, WIRE.ollama)
    const common = {
      endpoint: target,
      retryMode: PROVIDER_RETRY_MODE.none,
      call: CALL,
      signal: new AbortController().signal,
    } as const

    await expect(
      subject.execute({
        ...common,
        operation: {
          kind: PROVIDER_CALL_KIND.chat,
          model: 'local-a',
          messages: [{ role: 'user', content: 'probe' }],
          stream: false,
          maxOutputTokens: 9,
          tokenLimitField: PROVIDER_TOKEN_LIMIT_FIELD.maxCompletionTokens,
        },
      }),
    ).resolves.toMatchObject({ text: 'chat-ok', usage: { promptEvalCount: 2, evalCount: 3 } })
    await expect(
      subject.execute({
        ...common,
        operation: {
          kind: PROVIDER_CALL_KIND.embedding,
          model: 'embed-a',
          input: ['a', 'b'],
          dimensions: 2,
        },
      }),
    ).resolves.toMatchObject({
      embeddings: [
        [0.1, 0.2],
        [0.3, 0.4],
      ],
    })
    await expect(
      subject.execute({ ...common, operation: { kind: PROVIDER_CALL_KIND.models } }),
    ).resolves.toEqual({ kind: PROVIDER_CALL_KIND.models, models: ['local-a', 'local-b'] })
    expect(payloads.get('/api/chat')).toMatchObject({ options: { num_predict: 9 } })
    expect(payloads.get('/api/chat')).not.toHaveProperty('max_completion_tokens')
    expect(payloads.get('/api/embed')).toMatchObject({ input: ['a', 'b'], dimensions: 2 })
  })

  it('does one interactive retry only for a classified provider rate limit', async () => {
    let hits = 0
    const delays: number[] = []
    const port = await listen((_request, response) => {
      hits += 1
      if (hits === 1) {
        response.writeHead(429, { 'content-type': 'application/json', 'retry-after': '60' })
        response.end(
          JSON.stringify({
            error: { message: 'slow down', metadata: { error_type: 'rate_limit_exceeded' } },
          }),
        )
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
        }),
      )
    })
    const subject = runtime(port, {
      sleep: async (milliseconds) => {
        delays.push(milliseconds)
      },
      random: () => 0,
    })
    const target = { ...endpoint(port, WIRE.openaiCompatible), callTimeoutMs: 30_000 }
    const result = await subject.execute({
      endpoint: target,
      operation: {
        kind: PROVIDER_CALL_KIND.chat,
        model: 'model-a',
        messages: [{ role: 'user', content: 'hello' }],
        stream: false,
        maxOutputTokens: 16,
      },
      retryMode: PROVIDER_RETRY_MODE.interactive,
      call: CALL,
      signal: new AbortController().signal,
    })

    expect(result).toMatchObject({ kind: PROVIDER_CALL_KIND.chat, text: 'ok' })
    expect(hits).toBe(2)
    expect(delays).toEqual([30_000])
  })

  it('aborts the Retry-After wait without opening a second request', async () => {
    let hits = 0
    let entered!: () => void
    const waiting = new Promise<void>((resolve) => {
      entered = resolve
    })
    const port = await listen((_request, response) => {
      hits += 1
      response.writeHead(429, { 'content-type': 'application/json', 'retry-after': '60' })
      response.end(
        JSON.stringify({
          error: { message: 'slow down', metadata: { error_type: 'rate_limit_exceeded' } },
        }),
      )
    })
    const subject = runtime(port, {
      sleep: (_milliseconds, signal) =>
        new Promise((_resolve, reject) => {
          entered()
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        }),
    })
    const controller = new AbortController()
    const call = subject.execute({
      endpoint: endpoint(port, WIRE.openaiCompatible),
      operation: { kind: PROVIDER_CALL_KIND.models },
      retryMode: PROVIDER_RETRY_MODE.interactive,
      call: CALL,
      signal: controller.signal,
    })

    await waiting
    controller.abort(new Error('tab closed'))
    await expect(call).rejects.toMatchObject({ code: PROVIDER_CALL_ERROR.canceled })
    expect(hits).toBe(1)
  })

  it('uses jitter for an invalid Retry-After and the default abortable wait for zero', async () => {
    for (const [retryAfter, expectedDelay] of [
      ['tomorrow', 5_500],
      ['0', null],
    ] as const) {
      let hits = 0
      const delays: number[] = []
      const port = await listen((_request, response) => {
        hits += 1
        if (hits === 1) {
          response.writeHead(429, {
            'content-type': 'application/json',
            'retry-after': retryAfter,
          })
          response.end(
            JSON.stringify({
              error: {
                message: 'slow down',
                metadata: { error_type: 'rate_limit_exceeded' },
              },
            }),
          )
          return
        }
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end('{"data":null}')
      })
      const subject =
        expectedDelay === null
          ? runtime(port)
          : runtime(port, {
              sleep: async (milliseconds) => {
                delays.push(milliseconds)
              },
              random: () => 0.5,
            })

      await expect(
        subject.execute({
          endpoint: endpoint(port, WIRE.openaiCompatible),
          operation: { kind: PROVIDER_CALL_KIND.models },
          retryMode: PROVIDER_RETRY_MODE.interactive,
          call: CALL,
          signal: new AbortController().signal,
        }),
      ).resolves.toEqual({ kind: PROVIDER_CALL_KIND.models, models: [] })
      expect(hits).toBe(2)
      expect(delays).toEqual(expectedDelay === null ? [] : [expectedDelay])
    }
  })

  it('does not retry an unknown 429 body or a malformed 2xx response', async () => {
    for (const responseCase of [
      { status: 429, body: '{"error":{"message":"unknown limiter"}}', code: 'fallback' },
      { status: 200, body: '   ', code: 'malformed-response' },
    ] as const) {
      let hits = 0
      const port = await listen((_request, response) => {
        hits += 1
        response.writeHead(responseCase.status, { 'content-type': 'application/json' })
        response.end(responseCase.body)
      })
      const call = runtime(port).execute({
        endpoint: endpoint(port, WIRE.openaiCompatible),
        operation: {
          kind: PROVIDER_CALL_KIND.embedding,
          model: 'embed-a',
          input: ['probe'],
        },
        retryMode: PROVIDER_RETRY_MODE.interactive,
        call: CALL,
        signal: new AbortController().signal,
      })

      await expect(call).rejects.toMatchObject({ code: responseCase.code, retrySafe: false })
      expect(hits).toBe(1)
    }
  })

  it('classifies known failures from status and body together', async () => {
    const cases = [
      {
        status: 401,
        body: { error: { message: 'User not found.', code: 401 } },
        code: PROVIDER_CALL_ERROR.credentialRejected,
      },
      {
        status: 402,
        body: { error: { message: 'insufficient credits' } },
        code: PROVIDER_CALL_ERROR.quotaExhausted,
      },
      {
        status: 403,
        body: { error: { message: 'Key limit exceeded (total limit)' } },
        code: PROVIDER_CALL_ERROR.quotaExhausted,
      },
      {
        status: 400,
        body: { error: { message: 'model-a is not a valid model ID' } },
        code: PROVIDER_CALL_ERROR.modelUnavailable,
      },
      {
        status: 400,
        body: { error: { message: 'max_tokens parameter is not accepted' } },
        code: PROVIDER_CALL_ERROR.parametersRejected,
      },
      {
        status: 500,
        body: { error: { message: 'failed to load: cudaMalloc failed: out of memory' } },
        code: PROVIDER_CALL_ERROR.modelLoadFailed,
      },
    ] as const

    for (const item of cases) {
      const port = await listen((_request, response) => {
        response.writeHead(item.status, { 'content-type': 'application/json' })
        response.end(JSON.stringify(item.body))
      })

      await expect(
        runtime(port).execute({
          endpoint: endpoint(port, WIRE.openaiCompatible),
          operation: { kind: PROVIDER_CALL_KIND.models },
          retryMode: PROVIDER_RETRY_MODE.none,
          call: CALL,
          signal: new AbortController().signal,
        }),
      ).rejects.toMatchObject({ code: item.code, retrySafe: false })
    }
  })

  it('marks a connector failure not-sent but never retries a read timeout after send', async () => {
    const beforeSend = new ProviderRuntime({
      privateOrigins: new Set(),
      callLog: journal,
      transport: {
        lookup: async () => [{ address: '203.0.113.10', family: 4 }],
        connectorFactory: () => (_options, callback) => callback(new Error('connect failed'), null),
      },
    })
    await expect(
      beforeSend.execute({
        endpoint: {
          principalId: 'owner-1',
          wire: WIRE.openaiCompatible,
          baseUrl: 'https://api.vendor.test/v1',
          headers: new Map(),
          sensitiveValues: new Set(),
          allowPrivateNetwork: false,
          firstByteTimeoutMs: null,
          callTimeoutMs: null,
        },
        operation: { kind: PROVIDER_CALL_KIND.models },
        retryMode: PROVIDER_RETRY_MODE.none,
        call: CALL,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({
      code: PROVIDER_CALL_ERROR.unreachable,
      retrySafe: true,
      deliveryState: PROVIDER_DELIVERY_STATE.notSent,
    })

    let hits = 0
    const port = await listen((_request, response) => {
      hits += 1
      response.writeHead(200, { 'content-type': 'application/json' })
      response.write('{"data":')
    })
    await expect(
      runtime(port).execute({
        endpoint: { ...endpoint(port, WIRE.openaiCompatible), callTimeoutMs: 30 },
        operation: { kind: PROVIDER_CALL_KIND.models },
        retryMode: PROVIDER_RETRY_MODE.interactive,
        call: CALL,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({
      code: PROVIDER_CALL_ERROR.unreachable,
      retrySafe: false,
      deliveryState: PROVIDER_DELIVERY_STATE.mayHaveSent,
    })
    expect(hits).toBe(1)
  })

  it('maps policy, request-size, response-size, and empty embedding failures', async () => {
    const policy = new ProviderRuntime({
      privateOrigins: new Set(),
      callLog: journal,
      transport: { lookup: async () => [{ address: '203.0.113.10', family: 4 }] },
    })
    await expect(
      policy.execute({
        endpoint: {
          principalId: 'owner-1',
          wire: WIRE.openaiCompatible,
          baseUrl: 'http://api.vendor.test/v1',
          headers: new Map(),
          sensitiveValues: new Set(),
          allowPrivateNetwork: false,
          firstByteTimeoutMs: null,
          callTimeoutMs: null,
        },
        operation: { kind: PROVIDER_CALL_KIND.models },
        retryMode: PROVIDER_RETRY_MODE.none,
        call: CALL,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: PROVIDER_CALL_ERROR.policyDenied, retrySafe: true })

    let requestHits = 0
    const requestPort = await listen((_request, response) => {
      requestHits += 1
      response.end()
    })
    await expect(
      runtime(requestPort).execute({
        endpoint: endpoint(requestPort, WIRE.openaiCompatible),
        operation: {
          kind: PROVIDER_CALL_KIND.chat,
          model: 'model-a',
          messages: [{ role: 'user', content: 'x'.repeat(1024 * 1024) }],
          stream: false,
          maxOutputTokens: 16,
        },
        retryMode: PROVIDER_RETRY_MODE.none,
        call: CALL,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: PROVIDER_CALL_ERROR.invalidRequest, retrySafe: false })
    expect(requestHits).toBe(0)

    const responsePort = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"data":null}')
    })
    const responseRuntime = new ProviderRuntime({
      privateOrigins: new Set([`http://provider.test:${responsePort}`]),
      callLog: journal,
      transport: {
        lookup: async () => [{ address: '127.0.0.1', family: 4 }],
        limits: { nonStreamResponseBytes: 4 },
      },
    })
    await expect(
      responseRuntime.execute({
        endpoint: endpoint(responsePort, WIRE.openaiCompatible),
        operation: { kind: PROVIDER_CALL_KIND.models },
        retryMode: PROVIDER_RETRY_MODE.none,
        call: CALL,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({
      code: PROVIDER_CALL_ERROR.fallback,
      retrySafe: false,
      deliveryState: PROVIDER_DELIVERY_STATE.mayHaveSent,
    })

    await expect(
      runtime(responsePort).execute({
        endpoint: endpoint(responsePort, WIRE.openaiCompatible),
        operation: { kind: PROVIDER_CALL_KIND.embedding, model: 'embed-a', input: [] },
        retryMode: PROVIDER_RETRY_MODE.none,
        call: CALL,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: PROVIDER_CALL_ERROR.invalidRequest })
  })

  it('batches known-width embeddings below the measured response target', async () => {
    const batchSizes: number[] = []
    const port = await listen(async (request, response) => {
      const payload = JSON.parse(await bodyOf(request)) as { input: string[] }
      batchSizes.push(payload.input.length)
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          data: payload.input.map((_value, index) => ({ embedding: [index] })),
          usage: {
            prompt_tokens: payload.input.length,
            total_tokens: payload.input.length,
          },
        }),
      )
    })
    const input = Array.from({ length: 1_025 }, (_, index) => `item-${index}`)
    const result = await runtime(port).execute({
      endpoint: endpoint(port, WIRE.openaiCompatible),
      operation: {
        kind: PROVIDER_CALL_KIND.embedding,
        model: 'qwen/qwen3-embedding-8b',
        input,
        dimensions: 4_096,
      },
      retryMode: PROVIDER_RETRY_MODE.none,
      call: CALL,
      signal: new AbortController().signal,
    })

    expect(batchSizes).toEqual([1_024, 1])
    expect(result).toMatchObject({
      kind: PROVIDER_CALL_KIND.embedding,
      embeddings: { length: 1_025 },
      usage: {
        promptTokens: 1_025,
        completionTokens: null,
        totalTokens: 1_025,
        reasoningTokens: null,
        cachedPromptTokens: null,
        cost: null,
        isByok: null,
        costDetails: null,
      },
    })
  })

  it('redacts credential and header values before an error leaves the executor', async () => {
    const secret = 'sk-"secret-value'
    const authorization = `key=${secret}`
    const custom = 'private-header-value'
    const port = await listen((_request, response) => {
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({ error: { message: `echo ${authorization}; ${custom}; ${secret}` } }),
      )
    })
    const target = {
      ...endpoint(port, WIRE.openaiCompatible),
      headers: new Map([
        ['authorization', authorization],
        ['x-private', custom],
      ]),
      sensitiveValues: new Set([secret, custom]),
    }
    expect(JSON.stringify(target)).not.toContain(secret)
    expect(JSON.stringify(target)).not.toContain(custom)

    try {
      await runtime(port).execute({
        endpoint: target,
        operation: { kind: PROVIDER_CALL_KIND.models },
        retryMode: PROVIDER_RETRY_MODE.none,
        call: CALL,
        signal: new AbortController().signal,
      })
      throw new Error('expected provider call to fail')
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderCallError)
      expect(error).toMatchObject({ code: PROVIDER_CALL_ERROR.credentialRejected })
      const serialized = JSON.stringify(error)
      expect(serialized).not.toContain(secret)
      expect(serialized).not.toContain(JSON.stringify(secret).slice(1, -1))
      expect(serialized).not.toContain(custom)
      expect((error as ProviderCallError).diagnostic).toContain('[redacted]')
    }
  })

  it('redacts success, metadata, and secrets split across stream chunks', async () => {
    const secret = 'sk-success-secret'
    const authorization = `Bearer ${secret}`
    const custom = 'custom-private-value'
    const port = await listen(async (request, response) => {
      if (request.url === '/v1/models') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ data: [{ id: `model-${secret}` }] }))
        return
      }
      const payload = JSON.parse(await bodyOf(request)) as { stream?: boolean }

      if (!payload.stream) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify({
            choices: [
              {
                message: { content: `echo ${authorization} and ${custom}` },
                finish_reason: secret,
              },
            ],
            usage: { cost_details: { [`cost-${secret}`]: 1 } },
          }),
        )
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(
        'data: {"choices":[{"delta":{"content":"prefix Bearer sk-"},"finish_reason":null}]}\n\n',
      )
      response.write(
        'data: {"choices":[{"delta":{"content":"success-secret suffix"},"finish_reason":"stop"}]}\n\n',
      )
      response.end('data: [DONE]\n\n')
    })
    const target = {
      ...endpoint(port, WIRE.openaiCompatible),
      headers: new Map([
        ['authorization', authorization],
        ['x-private', custom],
      ]),
      sensitiveValues: new Set([secret, custom]),
    }
    const subject = runtime(port)
    const base = {
      endpoint: target,
      retryMode: PROVIDER_RETRY_MODE.none,
      call: CALL,
      signal: new AbortController().signal,
    } as const
    const nonStream = await subject.execute({
      ...base,
      operation: {
        kind: PROVIDER_CALL_KIND.chat,
        model: 'model-a',
        messages: [{ role: 'user', content: 'probe' }],
        stream: false,
        maxOutputTokens: 16,
      },
    })
    const models = await subject.execute({
      ...base,
      operation: { kind: PROVIDER_CALL_KIND.models },
    })
    const chunks: string[] = []
    const streamed = await subject.execute({
      ...base,
      operation: {
        kind: PROVIDER_CALL_KIND.chat,
        model: 'model-a',
        messages: [{ role: 'user', content: 'probe' }],
        stream: true,
        maxOutputTokens: 16,
      },
      onText: ({ text }) => {
        chunks.push(text)
      },
    })

    for (const value of [nonStream, models, streamed, chunks]) {
      expect(JSON.stringify(value)).not.toContain(secret)
      expect(JSON.stringify(value)).not.toContain(custom)
    }
    expect(nonStream).toMatchObject({
      text: 'echo [redacted] and [redacted]',
      finishReason: '[redacted]',
      usage: { costDetails: { 'cost-[redacted]': 1 } },
    })
    expect(models).toEqual({ kind: PROVIDER_CALL_KIND.models, models: ['model-[redacted]'] })
    expect(streamed).toMatchObject({ text: 'prefix [redacted] suffix' })
    expect(chunks.join('')).toBe('prefix [redacted] suffix')
  })

  it('accepts OpenAI data:null discovery and sanitizes hostile model names', async () => {
    let nullCase = true
    const port = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        nullCase
          ? '{"data":null}'
          : JSON.stringify({ data: [{ id: `model\r\nspoof-${'x'.repeat(10_000)}` }] }),
      )
      nullCase = false
    })
    const subject = runtime(port)
    const call = () =>
      subject.execute({
        endpoint: endpoint(port, WIRE.openaiCompatible),
        operation: { kind: PROVIDER_CALL_KIND.models },
        retryMode: PROVIDER_RETRY_MODE.none,
        call: CALL,
        signal: new AbortController().signal,
      })

    await expect(call()).resolves.toEqual({ kind: PROVIDER_CALL_KIND.models, models: [] })
    const result = await call()
    expect(result.kind).toBe(PROVIDER_CALL_KIND.models)
    if (result.kind === PROVIDER_CALL_KIND.models) {
      expect(result.models[0]).not.toMatch(/[\r\n]/u)
      expect(result.models[0].length).toBeLessThanOrEqual(512)
    }
  })

  it('classifies Ollama pre-stream 404 before entering the NDJSON parser', async () => {
    const port = await listen((_request, response) => {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end('{"error":"model local-missing not found, try pulling it first"}')
    })

    await expect(
      runtime(port).execute({
        endpoint: endpoint(port, WIRE.ollama),
        operation: {
          kind: PROVIDER_CALL_KIND.chat,
          model: 'local-missing',
          messages: [{ role: 'user', content: 'hello' }],
          stream: true,
          maxOutputTokens: 16,
        },
        retryMode: PROVIDER_RETRY_MODE.none,
        call: CALL,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: PROVIDER_CALL_ERROR.modelUnavailable, retrySafe: false })
  })

  it('rejects malformed and in-band Ollama responses on every parser path', async () => {
    const cases = [
      {
        operation: {
          kind: PROVIDER_CALL_KIND.chat,
          model: 'local-a',
          messages: [{ role: 'user', content: 'probe' }],
          stream: false,
          maxOutputTokens: 16,
        },
        body: '{"message":{"content":"partial"},"done":false}',
        code: PROVIDER_CALL_ERROR.malformedResponse,
      },
      {
        operation: {
          kind: PROVIDER_CALL_KIND.embedding,
          model: 'embed-a',
          input: ['probe'],
        },
        body: '{"embeddings":[]}',
        code: PROVIDER_CALL_ERROR.malformedResponse,
      },
      {
        operation: { kind: PROVIDER_CALL_KIND.models },
        body: '{"error":"runtime failed"}',
        code: PROVIDER_CALL_ERROR.fallback,
      },
      {
        operation: {
          kind: PROVIDER_CALL_KIND.chat,
          model: 'local-a',
          messages: [{ role: 'user', content: 'probe' }],
          stream: true,
          maxOutputTokens: 16,
        },
        body: 'not-json\n',
        code: PROVIDER_CALL_ERROR.malformedResponse,
      },
      {
        operation: {
          kind: PROVIDER_CALL_KIND.chat,
          model: 'local-a',
          messages: [{ role: 'user', content: 'probe' }],
          stream: true,
          maxOutputTokens: 16,
        },
        body: '{"error":"runtime failed"}\n',
        code: PROVIDER_CALL_ERROR.fallback,
      },
    ] as const

    for (const item of cases) {
      const port = await listen((_request, response) => {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(item.body)
      })

      await expect(
        runtime(port).execute({
          endpoint: endpoint(port, WIRE.ollama),
          operation: item.operation,
          retryMode: PROVIDER_RETRY_MODE.none,
          call: CALL,
          signal: new AbortController().signal,
        }),
      ).rejects.toMatchObject({ code: item.code, retrySafe: false })
    }
  })

  it('rejects malformed and in-band OpenAI stream events', async () => {
    for (const item of [
      { body: 'data: not-json\n\n', code: PROVIDER_CALL_ERROR.malformedResponse },
      {
        body: 'data: {"error":{"message":"provider failed"}}\n\n',
        code: PROVIDER_CALL_ERROR.fallback,
      },
    ] as const) {
      const port = await listen((_request, response) => {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end(item.body)
      })

      await expect(
        runtime(port).execute({
          endpoint: endpoint(port, WIRE.openaiCompatible),
          operation: {
            kind: PROVIDER_CALL_KIND.chat,
            model: 'model-a',
            messages: [{ role: 'user', content: 'probe' }],
            stream: true,
            maxOutputTokens: 16,
          },
          retryMode: PROVIDER_RETRY_MODE.none,
          call: CALL,
          signal: new AbortController().signal,
        }),
      ).rejects.toMatchObject({ code: item.code, retrySafe: false })
    }
  })

  it('returns an opened stream as incomplete and never retries it', async () => {
    let hits = 0
    const port = await listen((_request, response) => {
      hits += 1
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n')
    })
    const chunks: string[] = []

    await expect(
      runtime(port).execute({
        endpoint: endpoint(port, WIRE.openaiCompatible),
        operation: {
          kind: PROVIDER_CALL_KIND.chat,
          model: 'model-a',
          messages: [{ role: 'user', content: 'hello' }],
          stream: true,
          maxOutputTokens: 16,
        },
        retryMode: PROVIDER_RETRY_MODE.interactive,
        call: CALL,
        signal: new AbortController().signal,
        onText: ({ text }) => {
          chunks.push(text)
        },
      }),
    ).rejects.toMatchObject({
      code: PROVIDER_CALL_ERROR.streamInterrupted,
      retrySafe: false,
    })
    expect(chunks).toEqual(['partial'])
    expect(hits).toBe(1)
  })
})

describe('provider call journal', () => {
  it('opens an intent before the send and closes it with the counted outcome', async () => {
    let seenIntents = 0
    const port = await listen((_request, response) => {
      // The row exists BEFORE the provider is reached: read at handler time, the
      // intent is already committed.
      seenIntents = journal.rows.length
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
        }),
      )
    })

    await runtime(port).execute({
      endpoint: endpoint(port, WIRE.openaiCompatible),
      operation: {
        kind: PROVIDER_CALL_KIND.chat,
        model: 'model-a',
        messages: [{ role: 'user', content: 'hello' }],
        stream: false,
        maxOutputTokens: 16,
      },
      retryMode: PROVIDER_RETRY_MODE.none,
      call: CALL,
      signal: new AbortController().signal,
    })

    expect(seenIntents).toBe(1)
    expect(journal.rows).toHaveLength(1)
    expect(journal.rows[0].input).toMatchObject({
      owner: 'alice',
      principal: 'user:alice',
      resourceId: 'resource-a',
      credentialId: 'credential-a',
      host: `provider.test:${port}`,
      job: null,
    })
    expect(journal.rows[0].outcome).toMatchObject({
      deliveryState: PROVIDER_DELIVERY_STATE.sent,
      retrySafe: false,
      outcome: PROVIDER_CALL_OUTCOME.ok,
      usage: { source: 'openai-compatible', totalTokens: 7 },
    })
  })

  it('records a refusal with its class instead of leaving silence', async () => {
    const port = await listen((_request, response) => {
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'User not found.', code: 401 } }))
    })

    await expect(
      runtime(port).execute({
        endpoint: endpoint(port, WIRE.openaiCompatible),
        operation: { kind: PROVIDER_CALL_KIND.key },
        retryMode: PROVIDER_RETRY_MODE.none,
        call: CALL,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: PROVIDER_CALL_ERROR.credentialRejected })

    expect(journal.rows).toHaveLength(1)
    expect(journal.rows[0].outcome).toMatchObject({
      deliveryState: PROVIDER_DELIVERY_STATE.sent,
      retrySafe: false,
      outcome: PROVIDER_CALL_ERROR.credentialRejected,
      // The refusal cost whatever it cost; the provider said nothing about it.
      usage: null,
    })
  })

  it('opens no intent for a policy refusal decided before physical send admission', async () => {
    const denied = new ProviderRuntime({
      privateOrigins: new Set(),
      callLog: journal,
      transport: { lookup: async () => [{ address: '127.0.0.1', family: 4 }] },
    })

    await expect(
      denied.execute({
        endpoint: {
          principalId: 'user:alice',
          wire: WIRE.openaiCompatible,
          baseUrl: 'http://provider.test:9/v1',
          headers: new Map(),
          sensitiveValues: new Set(),
          allowPrivateNetwork: false,
          firstByteTimeoutMs: null,
          callTimeoutMs: null,
        },
        operation: { kind: PROVIDER_CALL_KIND.models },
        retryMode: PROVIDER_RETRY_MODE.none,
        call: CALL,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: PROVIDER_CALL_ERROR.policyDenied })

    expect(journal.rows).toEqual([])
  })

  it('records the outcome of a stream that ended without its final chunk', async () => {
    const port = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end('data: {"choices":[{"delta":{"content":"half"}}]}\n\n')
    })

    await expect(
      runtime(port).execute({
        endpoint: endpoint(port, WIRE.openaiCompatible),
        operation: {
          kind: PROVIDER_CALL_KIND.chat,
          model: 'model-a',
          messages: [{ role: 'user', content: 'hello' }],
          stream: true,
          maxOutputTokens: 16,
        },
        retryMode: PROVIDER_RETRY_MODE.none,
        call: CALL,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: PROVIDER_CALL_ERROR.streamInterrupted })

    expect(journal.rows[0].outcome).toMatchObject({
      outcome: PROVIDER_CALL_ERROR.streamInterrupted,
      retrySafe: false,
      // Half an answer was paid for and the provider never said how much.
      usage: null,
    })
  })

  it('writes one row per request that left, ladder and batches included', async () => {
    const port = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }))
    })

    await runtime(port).execute({
      endpoint: endpoint(port, WIRE.openaiCompatible),
      operation: {
        kind: PROVIDER_CALL_KIND.embedding,
        model: 'embed-a',
        input: ['one', 'two'],
        // One vector per batch: two inputs are therefore two paid requests.
        dimensions: 4_000_000,
      },
      retryMode: PROVIDER_RETRY_MODE.none,
      call: { ...CALL, job: { jobId: 'job-1', jobCallKey: 'embed' } },
      signal: new AbortController().signal,
    })

    expect(journal.rows).toHaveLength(2)
    // Each batch is its own logical call, or batch two would be refused by batch
    // one's own success — and the suffix is derived, so a re-claim recomputes it.
    expect(journal.rows.map((row) => row.input.job)).toEqual([
      { jobId: 'job-1', jobCallKey: 'embed#0' },
      { jobId: 'job-1', jobCallKey: 'embed#1' },
    ])
  })

  it('does not send when the intent cannot be written', async () => {
    let requests = 0
    const port = await listen((_request, response) => {
      requests += 1
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ data: [] }))
    })
    const refusing = new ProviderRuntime({
      privateOrigins: new Set([`http://provider.test:${port}`]),
      callLog: {
        intent: async () => {
          throw new Error('journal is unavailable')
        },
        settle: async () => null,
      },
      transport: { lookup: async () => [{ address: '127.0.0.1', family: 4 }] },
    })

    await expect(
      refusing.execute({
        endpoint: endpoint(port, WIRE.openaiCompatible),
        operation: { kind: PROVIDER_CALL_KIND.models },
        retryMode: PROVIDER_RETRY_MODE.none,
        call: CALL,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/journal is unavailable/)

    expect(requests).toBe(0)
  })

  it('refuses a durable resend the fence blocked and opens no request for it', async () => {
    let requests = 0
    const port = await listen((_request, response) => {
      requests += 1
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ data: [] }))
    })
    journal.refuseWith({
      id: 'call-earlier',
      owner: 'alice',
      principal: 'user:alice',
      agent: null,
      resourceId: 'resource-a',
      credentialId: 'credential-a',
      host: 'provider.test',
      spaces: [],
      jobId: 'job-1',
      jobCallKey: 'embed',
      attemptNo: 1,
      deliveryState: PROVIDER_DELIVERY_STATE.mayHaveSent,
      retrySafe: false,
      outcome: PROVIDER_CALL_OUTCOME.inFlight,
      usage: null,
      createdAt: '2026-08-24T00:00:00.000Z',
      settledAt: null,
    })

    await expect(
      runtime(port).execute({
        endpoint: endpoint(port, WIRE.openaiCompatible),
        operation: { kind: PROVIDER_CALL_KIND.models },
        retryMode: PROVIDER_RETRY_MODE.none,
        call: { ...CALL, job: { jobId: 'job-1', jobCallKey: 'embed' } },
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({
      code: PROVIDER_CALL_ERROR.outcomeUnknown,
      retrySafe: false,
      deliveryState: PROVIDER_DELIVERY_STATE.mayHaveSent,
    })

    expect(requests).toBe(0)
  })

  it('reports a blocked resend by the class the previous attempt carried', async () => {
    const port = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ data: [] }))
    })
    const previous = {
      id: 'call-earlier',
      owner: 'alice',
      principal: 'user:alice',
      agent: null,
      resourceId: 'resource-a',
      credentialId: 'credential-a',
      host: 'provider.test',
      spaces: [],
      jobId: 'job-1',
      jobCallKey: 'embed',
      attemptNo: 1,
      deliveryState: PROVIDER_DELIVERY_STATE.sent,
      retrySafe: false,
      usage: null,
      createdAt: '2026-08-24T00:00:00.000Z',
      settledAt: '2026-08-24T00:00:01.000Z',
    }
    const resend = () =>
      runtime(port).execute({
        endpoint: endpoint(port, WIRE.openaiCompatible),
        operation: { kind: PROVIDER_CALL_KIND.models },
        retryMode: PROVIDER_RETRY_MODE.none,
        call: { ...CALL, job: { jobId: 'job-1', jobCallKey: 'embed' } },
        signal: new AbortController().signal,
      })

    // A named outcome travels: the caller learns WHY, not merely that it happened.
    journal.refuseWith({ ...previous, outcome: PROVIDER_CALL_ERROR.credentialRejected })
    await expect(resend()).rejects.toMatchObject({
      code: PROVIDER_CALL_ERROR.credentialRejected,
    })

    // A success does not, because the journal keeps no answer to hand back — the
    // honest report is that it already happened and cannot be repeated.
    journal.refuseWith({ ...previous, outcome: PROVIDER_CALL_OUTCOME.ok })
    await expect(resend()).rejects.toMatchObject({
      code: PROVIDER_CALL_ERROR.outcomeUnknown,
    })
  })

  it('leaves no open intent behind when the stream consumer itself throws', async () => {
    const port = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n')
      response.end('data: [DONE]\n\n')
    })

    await expect(
      runtime(port).execute({
        endpoint: endpoint(port, WIRE.openaiCompatible),
        operation: {
          kind: PROVIDER_CALL_KIND.chat,
          model: 'model-a',
          messages: [{ role: 'user', content: 'hello' }],
          stream: true,
          maxOutputTokens: 16,
        },
        retryMode: PROVIDER_RETRY_MODE.none,
        call: CALL,
        signal: new AbortController().signal,
        onText: () => {
          throw new Error('the consumer of the stream broke')
        },
      }),
    ).rejects.toMatchObject({ code: PROVIDER_CALL_ERROR.unreachable })

    // Whoever broke, the row closes: an intent nothing ever settled reads as a call
    // that may have been paid for, and the next attempt of the same job is fenced out
    // by it. The delivery state stays ambiguous because the request had already left.
    expect(journal.rows[0].outcome).toMatchObject({
      outcome: PROVIDER_CALL_ERROR.unreachable,
      deliveryState: PROVIDER_DELIVERY_STATE.mayHaveSent,
      retrySafe: false,
    })
  })

  it('opens no ambiguous intent when cancellation lands during DNS admission', async () => {
    let lookupReached!: () => void
    const started = new Promise<void>((resolve) => {
      lookupReached = resolve
    })
    const controller = new AbortController()
    const stalled = new ProviderRuntime({
      privateOrigins: new Set(['http://provider.test:11434']),
      callLog: journal,
      transport: {
        lookup: async () => {
          lookupReached()
          return new Promise(() => {})
        },
      },
    })
    const call = stalled.execute({
      endpoint: endpoint(11434, WIRE.ollama),
      operation: { kind: PROVIDER_CALL_KIND.models },
      retryMode: PROVIDER_RETRY_MODE.none,
      call: { ...CALL, job: { jobId: 'job-1', jobCallKey: 'discover' } },
      signal: controller.signal,
    })

    await started
    controller.abort(new Error('the process is shutting down'))
    await expect(call).rejects.toMatchObject({ code: PROVIDER_CALL_ERROR.canceled })

    // No durable evidence is needed before transport admission: absence itself
    // proves there was no send, so a recovered job may try normally.
    expect(journal.rows).toEqual([])
  })

  it('keeps the answer when the journal cannot close the row it opened', async () => {
    const port = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ data: [{ id: 'model-a' }] }))
    })
    let intents = 0
    const unclosable = new ProviderRuntime({
      privateOrigins: new Set([`http://provider.test:${port}`]),
      callLog: {
        intent: async (input) => {
          intents += 1
          return journal.intent(input)
        },
        settle: async () => {
          throw new Error('the journal is unavailable')
        },
      },
      transport: { lookup: async () => [{ address: '127.0.0.1', family: 4 }] },
    })

    // The provider has answered and the call is already on the bill. Losing the answer
    // to our own bookkeeping would make the owner click again and pay twice; the row
    // that stayed open is the model's own way of saying nothing observed this end.
    await expect(
      unclosable.execute({
        endpoint: endpoint(port, WIRE.openaiCompatible),
        operation: { kind: PROVIDER_CALL_KIND.models },
        retryMode: PROVIDER_RETRY_MODE.none,
        call: CALL,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ kind: PROVIDER_CALL_KIND.models })

    expect(intents).toBe(1)
    expect(journal.rows[0].outcome).toBeUndefined()
  })

  it('takes the online-backup barrier for both phases', async () => {
    const entered: string[] = []
    const port = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ data: [] }))
    })
    const gated = new ProviderRuntime({
      privateOrigins: new Set([`http://provider.test:${port}`]),
      callLog: journal,
      // The route is out of the barrier so the provider's thinking time holds
      // nothing; every SHORT persisting step still enters it, exactly like `/mcp`.
      mutationGate: {
        run: async (task) => {
          entered.push('enter')
          return task()
        },
      },
      transport: { lookup: async () => [{ address: '127.0.0.1', family: 4 }] },
    })

    await gated.execute({
      endpoint: endpoint(port, WIRE.openaiCompatible),
      operation: { kind: PROVIDER_CALL_KIND.models },
      retryMode: PROVIDER_RETRY_MODE.none,
      call: CALL,
      signal: new AbortController().signal,
    })

    expect(entered).toEqual(['enter', 'enter'])
  })
})
