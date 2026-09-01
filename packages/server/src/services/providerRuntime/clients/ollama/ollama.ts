import { type ProviderOllamaUsage } from '@notarium/contract'

import { type ProviderTransport } from '../../transport/transport'
import type { ProviderTransportResponse } from '../../transport/types'
import { PROVIDER_CALL_KIND } from '../../types'
import type { ProviderCallResult, ProviderChatResult, ProviderEmbeddingResult } from '../../types'
import { bodyText, finiteNumber, jsonObject, ollamaUsage, ProviderLineDecoder } from '../helpers'
import type { ProviderClientFailure, ProviderClientOutcome, ProviderClientRequest } from '../types'

type Parsed<T> = { ok: true; value: T } | { ok: false }

const responseFailure = (
  response: ProviderTransportResponse,
  body: string,
  kind: ProviderClientFailure['kind'] = 'response',
): ProviderClientOutcome => ({
  ok: false,
  failure: {
    kind,
    statusCode: response.statusCode,
    headers: response.headers,
    bodyText: body,
    effectiveCallTimeoutMs: response.effectiveCallTimeoutMs,
  },
})

const chatOf = (value: Record<string, unknown>): Parsed<ProviderChatResult> => {
  const message = value.message

  if (typeof message !== 'object' || message === null || Array.isArray(message)) {
    return { ok: false }
  }
  const content = (message as Record<string, unknown>).content

  if (typeof content !== 'string' || value.done !== true) {
    return { ok: false }
  }

  return {
    ok: true,
    value: {
      kind: PROVIDER_CALL_KIND.chat,
      text: content,
      finishReason: typeof value.done_reason === 'string' ? value.done_reason : null,
      usage: ollamaUsage(value),
    },
  }
}

const embeddingsOf = (
  value: Record<string, unknown>,
  expectedCount: number,
): Parsed<ProviderEmbeddingResult> => {
  if (!Array.isArray(value.embeddings)) {
    return { ok: false }
  }
  const embeddings: number[][] = []

  for (const embedding of value.embeddings) {
    if (
      !Array.isArray(embedding) ||
      embedding.length === 0 ||
      embedding.some((entry) => finiteNumber(entry) === null)
    ) {
      return { ok: false }
    }
    embeddings.push(embedding as number[])
  }
  if (
    embeddings.length !== expectedCount ||
    embeddings.some((embedding) => embedding.length !== embeddings[0]?.length)
  ) {
    return { ok: false }
  }

  return {
    ok: true,
    value: {
      kind: PROVIDER_CALL_KIND.embedding,
      embeddings,
      usage: ollamaUsage(value),
    },
  }
}

const nonStream = async (
  response: ProviderTransportResponse,
  request: ProviderClientRequest,
): Promise<ProviderClientOutcome> => {
  const raw = await bodyText(response.body)
  const parsed = jsonObject(raw)

  if (!parsed) {
    return responseFailure(response, raw, 'malformed')
  }
  if (parsed.error !== undefined) {
    return responseFailure(response, raw)
  }
  let result: Parsed<ProviderCallResult>

  if (request.operation.kind === PROVIDER_CALL_KIND.chat) {
    result = chatOf(parsed)
  } else {
    result = embeddingsOf(parsed, request.operation.input.length)
  }

  return result.ok
    ? { ok: true, result: result.value }
    : responseFailure(response, raw, 'malformed')
}

const streamChat = async (
  response: ProviderTransportResponse,
  request: ProviderClientRequest,
): Promise<ProviderClientOutcome> => {
  const decoder = new ProviderLineDecoder()
  const text: string[] = []
  let finishReason: string | null = null
  let usage: ProviderOllamaUsage | null = null
  let done = false

  const line = async (raw: string): Promise<ProviderClientOutcome | null> => {
    if (!raw.trim()) {
      return null
    }
    const parsed = jsonObject(raw)

    if (!parsed) {
      return responseFailure(response, raw, 'malformed')
    }
    if (parsed.error !== undefined) {
      return responseFailure(response, raw)
    }
    const message = parsed.message
    const content =
      typeof message === 'object' && message !== null && !Array.isArray(message)
        ? (message as Record<string, unknown>).content
        : undefined

    if (typeof content === 'string' && content) {
      text.push(content)
      await request.onText?.(content)
    }
    if (parsed.done === true) {
      done = true
      finishReason = typeof parsed.done_reason === 'string' ? parsed.done_reason : null
      usage = ollamaUsage(parsed)
    }

    return null
  }

  for await (const chunk of response.body) {
    for (const rawLine of decoder.push(chunk)) {
      const outcome = await line(rawLine.replace(/\r$/u, ''))

      if (outcome) {
        return outcome
      }
    }
  }
  for (const rawLine of decoder.finish()) {
    if (!rawLine.trim()) {
      continue
    }
    const outcome = await line(rawLine.replace(/\r$/u, ''))

    if (outcome) {
      return outcome
    }
  }
  if (!done) {
    return responseFailure(
      response,
      'provider stream ended before the final native object',
      'stream-interrupted',
    )
  }

  return {
    ok: true,
    result: { kind: PROVIDER_CALL_KIND.chat, text: text.join(''), finishReason, usage },
  }
}

export const callOllama = (
  transport: ProviderTransport,
  request: ProviderClientRequest,
): Promise<ProviderClientOutcome> => {
  const { endpoint, operation } = request
  const base = new URL(endpoint.baseUrl)
  const origin = base.origin

  const path = operation.kind === PROVIDER_CALL_KIND.chat ? '/api/chat' : '/api/embed'
  const target = new URL(path, origin)
  const stream = operation.kind === PROVIDER_CALL_KIND.chat && operation.stream
  const payload =
    operation.kind === PROVIDER_CALL_KIND.chat
      ? {
          model: operation.model,
          messages: operation.messages,
          stream,
          options: { num_predict: operation.maxOutputTokens },
        }
      : {
          model: operation.model,
          input: operation.input,
          ...(operation.dimensions == null ? {} : { dimensions: operation.dimensions }),
        }

  return transport.request(
    {
      principalId: endpoint.principalId,
      target,
      trustedOrigin: origin,
      allowPrivateNetwork: endpoint.allowPrivateNetwork,
      method: 'POST',
      headers: {
        accept: stream ? 'application/x-ndjson' : 'application/json',
        'content-type': 'application/json',
        ...Object.fromEntries(endpoint.headers),
      },
      body: JSON.stringify(payload),
      stream,
      firstByteTimeoutMs: endpoint.firstByteTimeoutMs,
      callTimeoutMs: endpoint.callTimeoutMs,
      signal: request.signal,
      beforeSend: request.beforeSend,
    },
    async (response) => {
      if (response.statusCode < 200 || response.statusCode >= 300) {
        return responseFailure(response, await bodyText(response.body))
      }

      return stream ? streamChat(response, request) : nonStream(response, request)
    },
  )
}
