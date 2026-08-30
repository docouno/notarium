import {
  PROVIDER_CALL_ERROR,
  PROVIDER_CALL_OUTCOME,
  PROVIDER_DELIVERY_STATE,
  type ProviderCallErrorCode,
  type ProviderUsage,
  WIRE,
} from '@notarium/contract'
import { freshNoteId } from '@notarium/core'

import type { MutationGate } from '../../../libs/mutationGate'
import {
  type ProviderCallLogPersistence,
  type ProviderCallLogRecord,
  providerCallOutcomeAsRead,
} from '../../metaDb'
import { callOllama, callOpenAiCompatible, type ProviderClientOutcome } from '../clients'
import { ProviderCallError } from '../errors'
import {
  type ProviderCallRateLimiter,
  ProviderRateLimitError,
  type ProviderRateLimitReservation,
} from '../rateLimiter'
import { PROVIDER_TRANSPORT_ERROR, ProviderTransportError } from '../transport'
import { PROVIDER_TRANSPORT_LIMIT } from '../transport/consts'
import { ProviderTransport } from '../transport/transport'
import type { ProviderTransportDependencies } from '../transport/types'
import {
  PROVIDER_CALL_KIND,
  PROVIDER_RETRY_MODE,
  type ProviderCallContext,
  type ProviderCallRateLimit,
  type ProviderCallRequest,
  type ProviderCallResult,
  type ProviderEmbeddingResult,
} from '../types'
import {
  classifyProviderFailure,
  ProviderStreamRedactor,
  redactProviderText,
  sanitizeProviderText,
} from './classification'

/** The journal as the executor uses it. Both phases are EXPECTED, unlike the
 *  fire-and-forget audit this genre comes from: an intent that cannot be written
 *  aborts the call, because an unrecorded send is precisely what the journal exists
 *  to make impossible. */
export type ProviderCallJournal = Pick<ProviderCallLogPersistence, 'intent' | 'settle'>

export type ProviderExecutorDependencies = {
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>
  random?: () => number
  now?: () => Date
  newId?: () => string
}

const EMBEDDING_BATCH_MAX = 2_048
const EMBEDDING_RESPONSE_TARGET_BYTES = 128 * 1024 * 1024
const EMBEDDING_JSON_BYTES_PER_DIMENSION = 32

const embeddingBatchSize = (dimensions: number | null | undefined): number =>
  dimensions && dimensions > 0
    ? Math.max(
        1,
        Math.min(
          EMBEDDING_BATCH_MAX,
          Math.floor(
            EMBEDDING_RESPONSE_TARGET_BYTES / (dimensions * EMBEDDING_JSON_BYTES_PER_DIMENSION),
          ),
        ),
      )
    : 1

const sum = (values: Array<number | null>): number | null =>
  values.every((value): value is number => value !== null)
    ? values.reduce((total, value) => total + value, 0)
    : null

const mergedCostDetails = (
  values: Array<Record<string, number> | null>,
): Record<string, number> | null => {
  if (values.some((value) => value === null)) {
    return null
  }
  const present = values as Array<Record<string, number>>
  const keys = [...new Set(present.flatMap((value) => Object.keys(value)))].sort()

  if (present.some((value) => keys.some((key) => !Object.hasOwn(value, key)))) {
    return null
  }

  return Object.fromEntries(
    keys.map((key) => [key, present.reduce((total, value) => total + value[key], 0)]),
  )
}

const mergedUsage = (usages: Array<ProviderUsage | null>): ProviderUsage | null => {
  if (usages.length === 0 || usages.some((usage) => usage === null)) {
    return null
  }
  const present = usages as ProviderUsage[]
  const source = present[0].source

  if (present.some((usage) => usage.source !== source)) {
    return null
  }
  if (source === 'openai-compatible') {
    const typed = present.filter((usage) => usage.source === source)
    return {
      source,
      promptTokens: sum(typed.map((usage) => usage.promptTokens)),
      completionTokens: sum(typed.map((usage) => usage.completionTokens)),
      totalTokens: sum(typed.map((usage) => usage.totalTokens)),
      reasoningTokens: sum(typed.map((usage) => usage.reasoningTokens)),
      cachedPromptTokens: sum(typed.map((usage) => usage.cachedPromptTokens)),
      cost: sum(typed.map((usage) => usage.cost)),
      isByok: typed.every((usage) => usage.isByok === typed[0].isByok) ? typed[0].isByok : null,
      costDetails: mergedCostDetails(typed.map((usage) => usage.costDetails)),
    }
  }
  const typed = present.filter((usage) => usage.source === source)
  return {
    source,
    totalDurationNs: sum(typed.map((usage) => usage.totalDurationNs)),
    loadDurationNs: sum(typed.map((usage) => usage.loadDurationNs)),
    promptEvalCount: sum(typed.map((usage) => usage.promptEvalCount)),
    promptEvalDurationNs: sum(typed.map((usage) => usage.promptEvalDurationNs)),
    evalCount: sum(typed.map((usage) => usage.evalCount)),
    evalDurationNs: sum(typed.map((usage) => usage.evalDurationNs)),
  }
}

const defaultSleep = (milliseconds: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    const done = () => {
      signal.removeEventListener('abort', abort)
      resolve()
    }
    const timer = setTimeout(done, milliseconds)

    const abort = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      reject(signal.reason)
    }
    signal.addEventListener('abort', abort, { once: true })
  })

/** What the caller of a refused resend is told. A previous attempt that carries a
 *  class of its own reports that class; anything else — an answer we no longer hold,
 *  or an intent nothing ever closed — is honestly unknown. */
const blockedOutcome = (record: ProviderCallLogRecord, now: Date): ProviderCallErrorCode => {
  const outcome = providerCallOutcomeAsRead(record, now)

  return outcome === PROVIDER_CALL_OUTCOME.ok || outcome === PROVIDER_CALL_OUTCOME.inFlight
    ? PROVIDER_CALL_ERROR.outcomeUnknown
    : outcome
}

const usageOf = (result: ProviderCallResult): ProviderUsage | null =>
  result.kind === PROVIDER_CALL_KIND.chat || result.kind === PROVIDER_CALL_KIND.embedding
    ? result.usage
    : null

const observedTokensOf = (usage: ProviderUsage | null): number | null => {
  if (!usage) {
    return null
  }
  if (usage.source === 'openai-compatible') {
    if (usage.totalTokens !== null) {
      return usage.totalTokens
    }

    return usage.promptTokens !== null && usage.completionTokens !== null
      ? usage.promptTokens + usage.completionTokens
      : null
  }

  return usage.promptEvalCount !== null && usage.evalCount !== null
    ? usage.promptEvalCount + usage.evalCount
    : null
}

/** Each batch of a split embedding is its own logical call: they are separate paid
 *  requests, and one fence key over all of them would have batch two refused by batch
 *  one's own success. The suffix is derived from the offset, so a re-claim recomputes
 *  exactly the keys the first run used. */
const batchCall = (call: ProviderCallContext, offset: number): ProviderCallContext =>
  call.job
    ? { ...call, job: { ...call.job, jobCallKey: `${call.job.jobCallKey}#${offset}` } }
    : call

const transportFailure = (error: ProviderTransportError): ProviderCallError => {
  if (error.code === PROVIDER_TRANSPORT_ERROR.canceled) {
    return new ProviderCallError(PROVIDER_CALL_ERROR.canceled, {
      deliveryState: error.deliveryState,
      cause: error,
    })
  }
  if (error.code === PROVIDER_TRANSPORT_ERROR.policyDenied) {
    return new ProviderCallError(PROVIDER_CALL_ERROR.policyDenied, {
      retrySafe: true,
      deliveryState: error.deliveryState,
      cause: error,
    })
  }
  if (
    error.code === PROVIDER_TRANSPORT_ERROR.invalidRequest ||
    error.code === PROVIDER_TRANSPORT_ERROR.requestTooLarge ||
    error.code === PROVIDER_TRANSPORT_ERROR.headersTooLarge
  ) {
    return new ProviderCallError(PROVIDER_CALL_ERROR.invalidRequest, {
      deliveryState: error.deliveryState,
      cause: error,
    })
  }
  if (
    error.code === PROVIDER_TRANSPORT_ERROR.networkError ||
    error.code === PROVIDER_TRANSPORT_ERROR.firstByteTimeout ||
    error.code === PROVIDER_TRANSPORT_ERROR.callTimeout
  ) {
    return new ProviderCallError(PROVIDER_CALL_ERROR.unreachable, {
      retrySafe: error.deliveryState === PROVIDER_DELIVERY_STATE.notSent,
      deliveryState: error.deliveryState,
      cause: error,
    })
  }

  return new ProviderCallError(PROVIDER_CALL_ERROR.fallback, {
    deliveryState: error.deliveryState,
    cause: error,
  })
}

const safeUsage = (
  usage: ProviderUsage | null,
  headers: ReadonlyMap<string, string>,
  sensitiveValues: Iterable<string>,
): ProviderUsage | null => {
  if (usage?.source !== 'openai-compatible' || !usage.costDetails) {
    return usage
  }
  const costDetails = Object.fromEntries(
    Object.entries(usage.costDetails)
      .slice(0, 32)
      .flatMap(([key, value]) => {
        const safeKey = sanitizeProviderText(key, headers, sensitiveValues).slice(0, 128)
        return safeKey ? [[safeKey, value]] : []
      }),
  )

  return { ...usage, costDetails }
}

const safeResult = (
  result: ProviderCallResult,
  headers: ReadonlyMap<string, string>,
  sensitiveValues: Iterable<string>,
): ProviderCallResult => {
  if (result.kind === PROVIDER_CALL_KIND.chat) {
    return {
      ...result,
      text: redactProviderText(result.text, headers, sensitiveValues),
      finishReason:
        result.finishReason === null
          ? null
          : sanitizeProviderText(result.finishReason, headers, sensitiveValues).slice(0, 128),
      usage: safeUsage(result.usage, headers, sensitiveValues),
    }
  }
  if (result.kind === PROVIDER_CALL_KIND.models) {
    return {
      ...result,
      models: result.models.flatMap((model) => {
        const safe = sanitizeProviderText(model, headers, sensitiveValues)
        return safe ? [safe] : []
      }),
    }
  }
  if (result.kind === PROVIDER_CALL_KIND.key) {
    return result
  }

  return { ...result, usage: safeUsage(result.usage, headers, sensitiveValues) }
}

export class ProviderExecutor {
  private readonly transport: ProviderTransport
  private readonly journal: ProviderCallJournal
  private readonly mutationGate?: Pick<MutationGate, 'run'>
  private readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>
  private readonly random: () => number
  private readonly now: () => Date
  private readonly newId: () => string

  constructor(
    private readonly privateOrigins: ReadonlySet<string>,
    journal: ProviderCallJournal,
    private readonly limiter: ProviderCallRateLimiter,
    mutationGate?: Pick<MutationGate, 'run'>,
    dependencies: ProviderExecutorDependencies = {},
    transport?: ProviderTransportDependencies,
  ) {
    this.transport = new ProviderTransport(this.privateOrigins, transport)
    this.journal = journal
    this.mutationGate = mutationGate
    this.sleep = dependencies.sleep ?? defaultSleep
    this.random = dependencies.random ?? Math.random
    this.now = dependencies.now ?? (() => new Date())
    this.newId = dependencies.newId ?? freshNoteId
  }

  admitEndpoint(input: { baseUrl: string; allowPrivateNetwork: boolean; signal: AbortSignal }) {
    return this.transport.admit({
      target: input.baseUrl,
      trustedOrigin: new URL(input.baseUrl).origin,
      allowPrivateNetwork: input.allowPrivateNetwork,
      signal: input.signal,
    })
  }

  /** Being outside the mutation barrier is a licence to hold no admission while the
   *  provider thinks, NOT to write outside the gate: both journal phases move
   *  `PRAGMA data_version`, and an online-backup snapshot that sees it drift throws
   *  the whole attempt away. Copied from `/mcp`, which takes the barrier INSIDE for
   *  the same reason. */
  private gated<T>(task: () => Promise<T>): Promise<T> {
    return this.mutationGate ? this.mutationGate.run(task) : task()
  }

  /** Records the intent and COMMITS it before the transport may send. A durable job
   *  call meets the send-fence here: a logical call whose last attempt does not prove
   *  the provider went unpaid is refused rather than repeated. */
  private async openIntent(request: ProviderCallRequest): Promise<string> {
    const id = this.newId()
    const outcome = await this.gated(() =>
      this.journal.intent({
        id,
        owner: request.call.owner,
        principal: request.call.principal,
        agent: request.call.agent,
        resourceId: request.call.resourceId,
        credentialId: request.call.credentialId,
        host: new URL(request.endpoint.baseUrl).host,
        spaces: request.call.spaces,
        job: request.call.job,
        createdAt: this.now().toISOString(),
      }),
    )

    if (outcome.status === 'blocked') {
      throw new ProviderCallError(blockedOutcome(outcome.record, this.now()), {
        deliveryState: outcome.record.deliveryState,
      })
    }

    return outcome.record.id
  }

  /** Closes the row the send opened. Unlike the intent, a failure here does NOT take
   *  the call with it: the provider has already answered and the answer is already
   *  paid for, while an unclosed row is the model's own way of saying nothing observed
   *  this end — `providerCallOutcomeAsRead` reads it as unknown once the ceiling has
   *  passed. Turning that into a caller error would buy no record and lose the answer,
   *  and an interactive caller would pay for a second call to replace the first.
   *
   *  The recorded `retrySafe` is derived from the evidence rather than copied: a row
   *  the transport could not have sent licenses another attempt whatever class named
   *  it, which is exactly what the fence has to know. The error's own flag stays the
   *  caller-facing hint it was. */
  private async settle(
    id: string,
    outcome: {
      deliveryState: ProviderCallLogRecord['deliveryState']
      retrySafe: boolean
      outcome: ProviderCallLogRecord['outcome']
      usage: ProviderUsage | null
    },
  ): Promise<void> {
    const settled = {
      ...outcome,
      retrySafe: outcome.retrySafe || outcome.deliveryState === PROVIDER_DELIVERY_STATE.notSent,
    }

    await this.gated(() =>
      this.journal.settle({ id, ...settled, settledAt: this.now().toISOString() }),
    ).catch(() => undefined)
  }

  async execute(request: ProviderCallRequest): Promise<ProviderCallResult> {
    this.assertTokenBudget(request)

    if (request.operation.kind === PROVIDER_CALL_KIND.embedding) {
      return this.executeEmbedding(request)
    }

    return this.executeOne(request)
  }

  private async executeEmbedding(request: ProviderCallRequest): Promise<ProviderEmbeddingResult> {
    if (
      request.operation.kind !== PROVIDER_CALL_KIND.embedding ||
      request.operation.input.length === 0
    ) {
      throw new ProviderCallError(PROVIDER_CALL_ERROR.invalidRequest, {
        deliveryState: PROVIDER_DELIVERY_STATE.notSent,
      })
    }
    const batchSize = embeddingBatchSize(request.operation.dimensions)
    const embeddings: number[][] = []
    const usages: Array<ProviderUsage | null> = []
    let tokenReservation: ProviderRateLimitReservation | null = null

    for (let offset = 0; offset < request.operation.input.length; offset += batchSize) {
      const result = await this.executeOne(
        {
          ...request,
          call: batchCall(request.call, offset),
          operation: {
            ...request.operation,
            input: request.operation.input.slice(offset, offset + batchSize),
          },
        },
        {
          rateLimit: {
            ...request.call.rateLimit,
            inputUpperBound: offset === 0 ? request.call.rateLimit.inputUpperBound : 0,
            outputTokenBudget: 0,
          },
          retryRateLimit: request.call.rateLimit,
          settleObserved: false,
          captureReservation:
            offset === 0
              ? (reservation) => {
                  tokenReservation = reservation
                }
              : undefined,
        },
      )

      if (result.kind !== PROVIDER_CALL_KIND.embedding) {
        throw new Error('provider embedding adapter returned another result kind')
      }
      for (const embedding of result.embeddings) {
        embeddings.push(embedding)
      }
      usages.push(result.usage)
      const observed = mergedUsage(usages)

      if (tokenReservation) {
        this.limiter.settleCall(tokenReservation, observedTokensOf(observed))
      }
    }

    const usage = mergedUsage(usages)

    return {
      kind: PROVIDER_CALL_KIND.embedding,
      embeddings,
      usage,
    }
  }

  private async reserveCall(
    request: ProviderCallRequest,
    rateLimit: ProviderCallRateLimit = request.call.rateLimit,
    signal: AbortSignal = request.signal,
    waitTimeoutMs?: number,
  ): Promise<ProviderRateLimitReservation> {
    try {
      return await this.limiter.reserveCall({
        owner: request.call.owner,
        credentialId: request.call.credentialId,
        ...rateLimit,
        signal,
        waitTimeoutMs:
          waitTimeoutMs ??
          request.endpoint.firstByteTimeoutMs ??
          (request.endpoint.allowPrivateNetwork &&
          this.privateOrigins.has(new URL(request.endpoint.baseUrl).origin)
            ? PROVIDER_TRANSPORT_LIMIT.localFirstByteMs
            : PROVIDER_TRANSPORT_LIMIT.externalFirstByteMs),
      })
    } catch (error) {
      if (error instanceof ProviderRateLimitError) {
        const id = await this.openIntent(request)
        await this.settle(id, {
          deliveryState: PROVIDER_DELIVERY_STATE.notSent,
          retrySafe: true,
          outcome: error.code,
          usage: null,
        })
        throw error
      }
      if (signal.aborted) {
        throw new ProviderCallError(PROVIDER_CALL_ERROR.canceled, {
          deliveryState: PROVIDER_DELIVERY_STATE.notSent,
          cause: error,
        })
      }
      if (error instanceof TypeError) {
        throw new ProviderCallError(PROVIDER_CALL_ERROR.invalidRequest, {
          deliveryState: PROVIDER_DELIVERY_STATE.notSent,
          cause: error,
        })
      }
      throw error
    }
  }

  private async executeOne(
    request: ProviderCallRequest,
    accounting: {
      rateLimit?: ProviderCallRateLimit
      retryRateLimit?: ProviderCallRateLimit
      settleObserved?: boolean
      captureReservation?: (reservation: ProviderRateLimitReservation) => void
    } = {},
  ): Promise<ProviderCallResult> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let reservation = await this.reserveCall(
        request,
        attempt === 0 ? accounting.rateLimit : (accounting.retryRateLimit ?? accounting.rateLimit),
      )
      // Every physical send gets its own row, and the row exists before the send: an
      // interactive repeat and a split embedding are separate paid requests, so the
      // number of rows is the number of requests that were allowed to leave.
      let id: string | null = null
      const rateLimit =
        attempt === 0 ? accounting.rateLimit : (accounting.retryRateLimit ?? accounting.rateLimit)
      const outcome = await this.attempt(request, async (dispatchSignal) => {
        // The first reservation bounded the limiter wait. Concurrency admission may
        // have consumed most of its window, so replace it immediately before intent
        // instead of sending under stale accounting evidence.
        this.limiter.releaseCall(reservation)
        reservation = await this.reserveCall(request, rateLimit, dispatchSignal, 1)
        if (attempt === 0) {
          accounting.captureReservation?.(reservation)
        }
        if (dispatchSignal.aborted) {
          throw dispatchSignal.reason
        }
        if (request.beforeSend && !(await request.beforeSend())) {
          throw new ProviderCallError(PROVIDER_CALL_ERROR.canceled, {
            deliveryState: PROVIDER_DELIVERY_STATE.notSent,
          })
        }
        if (dispatchSignal.aborted) {
          throw dispatchSignal.reason
        }
        id = await this.openIntent(request)
      }).catch(async (error: unknown) => {
        const failure = this.callFailure(request, error)

        if (failure.recorded.deliveryState === PROVIDER_DELIVERY_STATE.notSent) {
          this.limiter.releaseCall(reservation)
        } else {
          this.limiter.settleCall(reservation, null)
        }
        if (id) {
          await this.settle(id, {
            deliveryState: failure.recorded.deliveryState,
            retrySafe: failure.recorded.retrySafe,
            outcome: failure.recorded.code,
            usage: null,
          })
        }
        throw failure.thrown
      })

      if (!id) {
        this.limiter.releaseCall(reservation)
        throw new Error('provider transport returned without durable send intent')
      }

      if (outcome.ok) {
        const usage = usageOf(outcome.result)

        if (accounting.settleObserved !== false) {
          this.limiter.settleCall(reservation, observedTokensOf(usage))
        }
        await this.settle(id, {
          deliveryState: PROVIDER_DELIVERY_STATE.sent,
          retrySafe: false,
          outcome: PROVIDER_CALL_OUTCOME.ok,
          usage,
        })
        return outcome.result
      }
      const error = classifyProviderFailure(
        outcome.failure,
        request.endpoint.headers,
        request.endpoint.sensitiveValues,
      )
      this.limiter.settleCall(reservation, null)
      // The provider answered, so the call is on the bill whatever its class; only the
      // classifier's own proof of a pre-processing refusal reopens the door.
      await this.settle(id, {
        deliveryState: PROVIDER_DELIVERY_STATE.sent,
        retrySafe: error.retrySafe,
        outcome: error.code,
        usage: null,
      })
      const mayRetry =
        attempt === 0 &&
        request.retryMode === PROVIDER_RETRY_MODE.interactive &&
        error.code === PROVIDER_CALL_ERROR.providerRateLimited

      if (!mayRetry) {
        throw error
      }
      const configuredCeiling =
        request.endpoint.callTimeoutMs ?? PROVIDER_TRANSPORT_LIMIT.localCallMs
      const fallback = 5_000 + Math.floor(this.random() * 1_000)
      const delay = Math.min(error.retryAfterMs ?? fallback, configuredCeiling)

      try {
        await this.sleep(delay, request.signal)
      } catch (cause) {
        throw new ProviderCallError(PROVIDER_CALL_ERROR.canceled, {
          deliveryState: PROVIDER_DELIVERY_STATE.notSent,
          cause,
        })
      }
    }

    throw new Error('unreachable provider retry state')
  }

  private assertTokenBudget(request: ProviderCallRequest): void {
    const budget = request.call.rateLimit
    const invalid = () =>
      new ProviderCallError(PROVIDER_CALL_ERROR.invalidRequest, {
        deliveryState: PROVIDER_DELIVERY_STATE.notSent,
      })

    if (!budget) {
      throw invalid()
    }
    if (request.operation.kind === PROVIDER_CALL_KIND.chat) {
      if (
        !Number.isInteger(budget.inputUpperBound) ||
        budget.inputUpperBound <= 0 ||
        !Number.isInteger(budget.outputTokenBudget) ||
        budget.outputTokenBudget <= 0 ||
        !Number.isInteger(request.operation.maxOutputTokens) ||
        request.operation.maxOutputTokens <= 0 ||
        budget.outputTokenBudget < request.operation.maxOutputTokens
      ) {
        throw invalid()
      }
    }
    if (
      request.operation.kind === PROVIDER_CALL_KIND.embedding &&
      (!Number.isInteger(budget.inputUpperBound) ||
        budget.inputUpperBound <= 0 ||
        (budget.tpm !== null && budget.outputTokenBudget !== 0))
    ) {
      throw invalid()
    }
  }

  /** The class the journal records for a failed send, and the error the caller gets.
   *  They differ in one case on purpose: a throw the executor does not recognize is
   *  somebody else's bug and travels on unchanged, but its row still closes — an
   *  intent left open would read as a call that may have been paid for. A raw throw
   *  after the caller aborted IS the abort, and it is ambiguous by construction: the
   *  request was already on its way. */
  private callFailure(
    request: ProviderCallRequest,
    error: unknown,
  ): { recorded: ProviderCallError; thrown: unknown } {
    if (error instanceof ProviderTransportError) {
      const failure = transportFailure(error)
      return { recorded: failure, thrown: failure }
    }
    if (error instanceof ProviderCallError) {
      return { recorded: error, thrown: error }
    }
    if (request.signal.aborted) {
      const canceled = new ProviderCallError(PROVIDER_CALL_ERROR.canceled, {
        deliveryState: PROVIDER_DELIVERY_STATE.mayHaveSent,
        cause: error,
      })
      return { recorded: canceled, thrown: canceled }
    }

    return {
      recorded: new ProviderCallError(PROVIDER_CALL_ERROR.fallback, {
        deliveryState: PROVIDER_DELIVERY_STATE.mayHaveSent,
        cause: error,
      }),
      thrown: error,
    }
  }

  private async attempt(
    request: ProviderCallRequest,
    beforeSend: (signal: AbortSignal) => Promise<void>,
  ): Promise<ProviderClientOutcome> {
    const redactor = new ProviderStreamRedactor(
      request.endpoint.headers,
      request.endpoint.sensitiveValues,
    )

    const flush = async (): Promise<void> => {
      if (!request.onText) {
        return
      }
      const tail = redactor.flush()

      if (tail) {
        await request.onText({ text: tail })
      }
    }
    const input = {
      endpoint: request.endpoint,
      operation: request.operation,
      signal: request.signal,
      beforeSend,
      onText: request.onText
        ? async (text: string) => {
            const safe = redactor.push(text)

            if (safe) {
              await request.onText!({ text: safe })
            }
          }
        : undefined,
    }
    let outcome: ProviderClientOutcome

    try {
      if (request.endpoint.wire === WIRE.openaiCompatible) {
        outcome = await callOpenAiCompatible(this.transport, input)
      } else if (request.endpoint.wire === WIRE.ollama) {
        outcome = await callOllama(this.transport, input)
      } else {
        throw new ProviderCallError(PROVIDER_CALL_ERROR.invalidRequest, {
          deliveryState: PROVIDER_DELIVERY_STATE.notSent,
        })
      }
    } catch (error) {
      await flush()
      throw error
    }
    await flush()

    return outcome.ok
      ? {
          ok: true,
          result: safeResult(
            outcome.result,
            request.endpoint.headers,
            request.endpoint.sensitiveValues,
          ),
        }
      : outcome
  }
}
