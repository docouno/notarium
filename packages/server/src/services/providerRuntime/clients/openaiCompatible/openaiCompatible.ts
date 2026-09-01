import type { ProviderOpenAiUsage } from '@notarium/contract'

import { type ProviderTransport } from '../../transport/transport'
import type { ProviderTransportResponse } from '../../transport/types'
import { PROVIDER_CALL_KIND, PROVIDER_TOKEN_LIMIT_FIELD } from '../../types'
import type { ProviderCallResult, ProviderChatResult, ProviderEmbeddingResult } from '../../types'
import {
  bodyText,
  endpointAt,
  finiteNumber,
  jsonObject,
  openAiUsage,
  ProviderLineDecoder,
} from '../helpers'
import type { ProviderClientFailure, ProviderClientOutcome, ProviderClientRequest } from '../types'

type Parsed<T> = { ok: true; value: T } | { ok: false }

const failure = async (
  response: ProviderTransportResponse,
  kind: ProviderClientFailure['kind'] = 'response',
): Promise<ProviderClientOutcome> => ({
  ok: false,
  failure: {
    kind,
    statusCode: response.statusCode,
    headers: response.headers,
    bodyText: await bodyText(response.body),
    effectiveCallTimeoutMs: response.effectiveCallTimeoutMs,
  },
})

const malformed = (response: ProviderTransportResponse, body: string): ProviderClientOutcome => ({
  ok: false,
  failure: {
    kind: 'malformed',
    statusCode: response.statusCode,
    headers: response.headers,
    bodyText: body,
    effectiveCallTimeoutMs: response.effectiveCallTimeoutMs,
  },
})

const chatOf = (value: Record<string, unknown>): Parsed<ProviderChatResult> => {
  const choices = value.choices

  if (!Array.isArray(choices) || choices.length === 0) {
    return { ok: false }
  }
  const choice = choices[0]

  if (typeof choice !== 'object' || choice === null || Array.isArray(choice)) {
    return { ok: false }
  }
  const record = choice as Record<string, unknown>
  const message = record.message

  if (typeof message !== 'object' || message === null || Array.isArray(message)) {
    return { ok: false }
  }
  const content = (message as Record<string, unknown>).content

  if (content !== null && typeof content !== 'string') {
    return { ok: false }
  }
  const finishReason = record.finish_reason

  if (finishReason !== null && finishReason !== undefined && typeof finishReason !== 'string') {
    return { ok: false }
  }

  return {
    ok: true,
    value: {
      kind: PROVIDER_CALL_KIND.chat,
      text: content ?? '',
      finishReason: finishReason ?? null,
      usage: openAiUsage(value.usage),
    },
  }
}

const embeddingsOf = (
  value: Record<string, unknown>,
  expectedCount: number,
): Parsed<ProviderEmbeddingResult> => {
  if (!Array.isArray(value.data)) {
    return { ok: false }
  }
  const embeddings: number[][] = []

  for (const item of value.data) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      return { ok: false }
    }
    const embedding = (item as Record<string, unknown>).embedding

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
      usage: openAiUsage(value.usage),
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
    return malformed(response, raw)
  }
  let result: Parsed<ProviderCallResult>

  if (request.operation.kind === PROVIDER_CALL_KIND.chat) {
    result = chatOf(parsed)
  } else {
    result = embeddingsOf(parsed, request.operation.input.length)
  }

  return result.ok ? { ok: true, result: result.value } : malformed(response, raw)
}

const streamChat = async (
  response: ProviderTransportResponse,
  request: ProviderClientRequest,
): Promise<ProviderClientOutcome> => {
  const decoder = new ProviderLineDecoder()
  const text: string[] = []
  let finishReason: string | null = null
  let usage: ProviderOpenAiUsage | null = null
  let done = false

  const line = async (rawLine: string): Promise<ProviderClientOutcome | null> => {
    const value = rawLine.trim()

    if (!value.startsWith('data:')) {
      return null
    }
    const data = value.slice(5).trim()

    if (data === '[DONE]') {
      done = true
      return null
    }
    const parsed = jsonObject(data)

    if (!parsed) {
      return malformed(response, data)
    }
    if (parsed.error !== undefined) {
      return {
        ok: false,
        failure: {
          kind: 'response',
          statusCode: response.statusCode,
          headers: response.headers,
          bodyText: data,
          effectiveCallTimeoutMs: response.effectiveCallTimeoutMs,
        },
      }
    }
    usage = openAiUsage(parsed.usage) ?? usage
    const choices = parsed.choices

    if (!Array.isArray(choices)) {
      return malformed(response, data)
    }
    for (const choice of choices) {
      if (typeof choice !== 'object' || choice === null || Array.isArray(choice)) {
        return malformed(response, data)
      }
      const record = choice as Record<string, unknown>
      const delta = record.delta
      const chunk =
        typeof delta === 'object' && delta !== null && !Array.isArray(delta)
          ? (delta as Record<string, unknown>).content
          : undefined

      if (typeof chunk === 'string' && chunk) {
        text.push(chunk)
        await request.onText?.(chunk)
      }
      if (typeof record.finish_reason === 'string') {
        finishReason = record.finish_reason
      }
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
    return {
      ok: false,
      failure: {
        kind: 'stream-interrupted',
        statusCode: response.statusCode,
        headers: response.headers,
        bodyText: 'provider stream ended before [DONE]',
        effectiveCallTimeoutMs: response.effectiveCallTimeoutMs,
      },
    }
  }

  return {
    ok: true,
    result: { kind: PROVIDER_CALL_KIND.chat, text: text.join(''), finishReason, usage },
  }
}

export const callOpenAiCompatible = (
  transport: ProviderTransport,
  request: ProviderClientRequest,
): Promise<ProviderClientOutcome> => {
  const { endpoint, operation } = request
  const origin = new URL(endpoint.baseUrl).origin
  const target = endpointAt(
    endpoint.baseUrl,
    operation.kind === PROVIDER_CALL_KIND.chat ? 'chat/completions' : 'embeddings',
  )
  const stream = operation.kind === PROVIDER_CALL_KIND.chat && operation.stream
  const payload =
    operation.kind === PROVIDER_CALL_KIND.chat
      ? {
          model: operation.model,
          messages: operation.messages,
          stream,
          [operation.tokenLimitField ?? PROVIDER_TOKEN_LIMIT_FIELD.maxTokens]:
            operation.maxOutputTokens,
          ...(stream ? { stream_options: { include_usage: true } } : {}),
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
        accept: stream ? 'text/event-stream' : 'application/json',
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
        return failure(response)
      }

      return stream ? streamChat(response, request) : nonStream(response, request)
    },
  )
}
