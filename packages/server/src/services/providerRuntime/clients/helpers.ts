import {
  PROVIDER_LIMIT,
  PROVIDER_USAGE_SOURCE,
  type ProviderOllamaUsage,
  type ProviderOpenAiUsage,
} from '@notarium/contract'

export const bodyText = async (body: AsyncIterable<Uint8Array>): Promise<string> => {
  const decoder = new TextDecoder()
  let result = ''

  for await (const chunk of body) {
    result += decoder.decode(chunk, { stream: true })
  }

  return result + decoder.decode()
}

/** Incremental UTF-8 line framing without repeatedly concatenating and scanning
 *  the retained prefix. A provider may legally use the whole stream budget for
 *  one malformed line; handling it must stay O(total bytes), not O(chunks²). */
export class ProviderLineDecoder {
  private readonly decoder = new TextDecoder()
  private pending: string[] = []

  push(chunk: Uint8Array): string[] {
    return this.consume(this.decoder.decode(chunk, { stream: true }))
  }

  finish(): string[] {
    const lines = this.consume(this.decoder.decode())

    if (this.pending.length > 0) {
      lines.push(this.pending.join(''))
      this.pending = []
    }

    return lines
  }

  private consume(value: string): string[] {
    const lines: string[] = []
    let offset = 0
    let newline = value.indexOf('\n')

    while (newline >= 0) {
      const fragment = value.slice(offset, newline)

      if (this.pending.length > 0) {
        this.pending.push(fragment)
        lines.push(this.pending.join(''))
        this.pending = []
      } else {
        lines.push(fragment)
      }
      offset = newline + 1
      newline = value.indexOf('\n', offset)
    }
    if (offset < value.length) {
      this.pending.push(value.slice(offset))
    }

    return lines
  }
}

export const jsonObject = (value: string): Record<string, unknown> | null => {
  try {
    const parsed = JSON.parse(value) as unknown
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

export const finiteNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

export const openAiUsage = (value: unknown): ProviderOpenAiUsage | null => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null
  }
  const usage = value as Record<string, unknown>
  const completionDetails =
    typeof usage.completion_tokens_details === 'object' &&
    usage.completion_tokens_details !== null &&
    !Array.isArray(usage.completion_tokens_details)
      ? (usage.completion_tokens_details as Record<string, unknown>)
      : {}
  const promptDetails =
    typeof usage.prompt_tokens_details === 'object' &&
    usage.prompt_tokens_details !== null &&
    !Array.isArray(usage.prompt_tokens_details)
      ? (usage.prompt_tokens_details as Record<string, unknown>)
      : {}
  const rawCostDetails =
    typeof usage.cost_details === 'object' &&
    usage.cost_details !== null &&
    !Array.isArray(usage.cost_details)
      ? (usage.cost_details as Record<string, unknown>)
      : null
  const costDetails = rawCostDetails
    ? Object.fromEntries(
        Object.entries(rawCostDetails).flatMap(([key, entry]) => {
          const number = finiteNumber(entry)
          return number === null ? [] : [[key, number]]
        }),
      )
    : null

  return {
    source: PROVIDER_USAGE_SOURCE.openaiCompatible,
    promptTokens: finiteNumber(usage.prompt_tokens),
    completionTokens: finiteNumber(usage.completion_tokens),
    totalTokens: finiteNumber(usage.total_tokens),
    reasoningTokens: finiteNumber(completionDetails.reasoning_tokens),
    cachedPromptTokens: finiteNumber(promptDetails.cached_tokens),
    cost: finiteNumber(usage.cost),
    isByok: typeof usage.is_byok === 'boolean' ? usage.is_byok : null,
    costDetails,
  }
}

export const ollamaUsage = (value: Record<string, unknown>): ProviderOllamaUsage | null => {
  const usage: ProviderOllamaUsage = {
    source: PROVIDER_USAGE_SOURCE.ollamaNative,
    totalDurationNs: finiteNumber(value.total_duration),
    loadDurationNs: finiteNumber(value.load_duration),
    promptEvalCount: finiteNumber(value.prompt_eval_count),
    promptEvalDurationNs: finiteNumber(value.prompt_eval_duration),
    evalCount: finiteNumber(value.eval_count),
    evalDurationNs: finiteNumber(value.eval_duration),
  }

  return Object.values(usage).some((entry) => typeof entry === 'number') ? usage : null
}

export const endpointAt = (baseUrl: string, suffix: string): URL =>
  new URL(`${baseUrl.replace(/\/$/, '')}/${suffix.replace(/^\//, '')}`)

export const providerModelName = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null
  }
  // eslint-disable-next-line no-control-regex -- provider metadata is a single-line UI label
  const normalized = value.replace(/[\u0000-\u001f\u007f-\u009f]+/gu, ' ').trim()

  return normalized ? normalized.slice(0, PROVIDER_LIMIT.modelName) : null
}
