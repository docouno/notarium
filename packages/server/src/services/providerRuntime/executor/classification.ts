import type { IncomingHttpHeaders } from 'node:http'
import { PROVIDER_CALL_ERROR, PROVIDER_DELIVERY_STATE, PROVIDER_LIMIT } from '@notarium/contract'

import { jsonObject } from '../clients/helpers'
import type { ProviderClientFailure } from '../clients/types'
import { ProviderCallError } from '../errors'

const scalarText = (value: unknown): string | null =>
  typeof value === 'string' || typeof value === 'number' ? String(value) : null

const errorParts = (bodyText: string): { message: string; metadata: Record<string, unknown> } => {
  const parsed = jsonObject(bodyText)
  const rawError = parsed?.error
  const error =
    typeof rawError === 'object' && rawError !== null && !Array.isArray(rawError)
      ? (rawError as Record<string, unknown>)
      : parsed
  const candidates = [
    error?.message,
    error?.detail,
    error?.error,
    parsed?.message,
    parsed?.detail,
    rawError,
    bodyText,
  ]
  const message = candidates.map(scalarText).find((value): value is string => Boolean(value)) ?? ''
  const metadata =
    typeof error?.metadata === 'object' && error.metadata !== null && !Array.isArray(error.metadata)
      ? (error.metadata as Record<string, unknown>)
      : {}

  return { message, metadata }
}

const redactionValues = (
  headers: ReadonlyMap<string, string>,
  sensitiveValues: Iterable<string>,
): string[] => {
  const values = new Set<string>()

  for (const value of sensitiveValues) {
    if (value) {
      values.add(value)
    }
  }
  for (const value of headers.values()) {
    if (!value) {
      continue
    }
    values.add(value)
    const bearer = value.match(/^\s*(?:Bearer|Token|ApiKey)\s+(.+)$/i)?.[1]

    if (bearer) {
      values.add(bearer)
    }
    const basic = value.match(/^\s*Basic\s+([A-Za-z0-9+/=_-]+)$/i)?.[1]

    if (basic) {
      try {
        const decoded = Buffer.from(basic, 'base64').toString('utf8')
        values.add(decoded)
        const separator = decoded.indexOf(':')

        if (separator >= 0 && separator < decoded.length - 1) {
          values.add(decoded.slice(separator + 1))
        }
      } catch {
        // The complete header value is still redacted below.
      }
    }
  }

  for (const value of [...values]) {
    values.add(encodeURIComponent(value))
    // Provider errors commonly embed the echoed request in a JSON string. Raw
    // text redaction alone misses the reversible escaped spelling.
    values.add(JSON.stringify(value).slice(1, -1))
  }

  return [...values].filter(Boolean).sort((left, right) => right.length - left.length)
}

const redactValues = (text: string, values: readonly string[]): string => {
  let redacted = text

  for (const value of values) {
    redacted = redacted.split(value).join('[redacted]')
  }

  return redacted
}

export const redactProviderText = (
  text: string,
  headers: ReadonlyMap<string, string>,
  sensitiveValues: Iterable<string> = [],
): string => redactValues(text, redactionValues(headers, sensitiveValues))

export class ProviderStreamRedactor {
  private readonly values: string[]
  private readonly tailLength: number
  private buffer = ''

  constructor(headers: ReadonlyMap<string, string>, sensitiveValues: Iterable<string> = []) {
    this.values = redactionValues(headers, sensitiveValues)
    this.tailLength = this.values.reduce((longest, value) => Math.max(longest, value.length - 1), 0)
  }

  push(chunk: string): string {
    this.buffer += chunk
    let safeEnd = Math.max(0, this.buffer.length - this.tailLength)

    for (const value of this.values) {
      let offset = this.buffer.indexOf(value)

      while (offset >= 0) {
        if (offset < safeEnd && offset + value.length > safeEnd) {
          safeEnd = offset
        }
        offset = this.buffer.indexOf(value, offset + 1)
      }
    }
    const safe = redactValues(this.buffer.slice(0, safeEnd), this.values)
    this.buffer = this.buffer.slice(safeEnd)
    return safe
  }

  flush(): string {
    const safe = redactValues(this.buffer, this.values)
    this.buffer = ''
    return safe
  }
}

export const sanitizeProviderText = (
  text: string,
  headers: ReadonlyMap<string, string>,
  sensitiveValues: Iterable<string> = [],
): string => {
  // eslint-disable-next-line no-control-regex -- diagnostics cross a single-line persistence boundary
  let sanitized = text.replace(/[\u0000-\u001f\u007f-\u009f]+/gu, ' ').trim()

  sanitized = redactProviderText(sanitized, headers, sensitiveValues)

  return sanitized.slice(0, PROVIDER_LIMIT.diagnostic)
}

const headerValue = (headers: IncomingHttpHeaders, name: string): string | null => {
  const raw = headers[name]
  return Array.isArray(raw) ? (raw[0] ?? null) : (raw ?? null)
}

const retryAfterMs = (failure: ProviderClientFailure): number | null => {
  const raw = headerValue(failure.headers, 'retry-after')?.trim()

  if (!raw || !/^\d+$/u.test(raw)) {
    return null
  }
  const milliseconds = Number(raw) * 1_000

  return Number.isSafeInteger(milliseconds) && milliseconds >= 0
    ? Math.min(milliseconds, failure.effectiveCallTimeoutMs)
    : null
}

export const classifyProviderFailure = (
  failure: ProviderClientFailure,
  requestHeaders: ReadonlyMap<string, string>,
  sensitiveValues: Iterable<string> = [],
): ProviderCallError => {
  const diagnostic = sanitizeProviderText(failure.bodyText, requestHeaders, sensitiveValues)
  const common = {
    deliveryState: PROVIDER_DELIVERY_STATE.mayHaveSent,
    diagnostic: diagnostic || null,
  } as const

  if (failure.kind === 'stream-interrupted') {
    return new ProviderCallError(PROVIDER_CALL_ERROR.streamInterrupted, common)
  }
  if (failure.kind === 'malformed') {
    return new ProviderCallError(PROVIDER_CALL_ERROR.malformedResponse, common)
  }
  const { message, metadata } = errorParts(failure.bodyText)
  const normalized = message.toLowerCase()

  if (
    failure.statusCode === 401 &&
    (normalized.length > 0 || jsonObject(failure.bodyText)?.error !== undefined)
  ) {
    return new ProviderCallError(PROVIDER_CALL_ERROR.credentialRejected, common)
  }
  if (
    (failure.statusCode === 402 && /insufficient|credit/u.test(normalized)) ||
    (failure.statusCode === 403 && /key limit exceeded|total limit/u.test(normalized))
  ) {
    return new ProviderCallError(PROVIDER_CALL_ERROR.quotaExhausted, common)
  }
  if (failure.statusCode === 429 && metadata.error_type === 'rate_limit_exceeded') {
    return new ProviderCallError(PROVIDER_CALL_ERROR.providerRateLimited, {
      ...common,
      retrySafe: true,
      retryAfterMs: retryAfterMs(failure),
    })
  }
  if (
    /not a valid model id|no endpoints found|model.+not found|not found.+model|try pulling/u.test(
      normalized,
    )
  ) {
    return new ProviderCallError(PROVIDER_CALL_ERROR.modelUnavailable, common)
  }
  if (
    (failure.statusCode === 400 || failure.statusCode === 422) &&
    /parameter|max_tokens|max_completion_tokens|dimensions|context length|batch|input/u.test(
      normalized,
    )
  ) {
    return new ProviderCallError(PROVIDER_CALL_ERROR.parametersRejected, common)
  }
  if (/failed to load|cudamalloc|out of memory/u.test(normalized)) {
    return new ProviderCallError(PROVIDER_CALL_ERROR.modelLoadFailed, common)
  }

  return new ProviderCallError(PROVIDER_CALL_ERROR.fallback, common)
}
