import { lookup as dnsLookup } from 'node:dns/promises'
import { validateHeaderName, validateHeaderValue } from 'node:http'
import { isIP } from 'node:net'
import type { Readable } from 'node:stream'
import {
  type BrotliDecompress,
  createBrotliDecompress,
  createGunzip,
  createInflate,
  type Gunzip,
  type Inflate,
} from 'node:zlib'
import { Agent, buildConnector, request } from 'undici'

import { PROVIDER_DELIVERY_STATE } from '@notarium/contract'

import {
  ADDRESS_CLASS,
  type AddressClass,
  canonicalOriginOf,
  classifyIpAddress,
  normalizeIpAddress,
  targetOriginOf,
} from '../../../libs/originPolicy'
import {
  PROVIDER_TRANSPORT_ERROR,
  PROVIDER_TRANSPORT_LIMIT,
  type ProviderTransportLimits,
} from './consts'
import { ProviderTransportError } from './errors'
import { isPrincipalQueueFullError, PrincipalConcurrency } from './helpers'
import type {
  ProviderConnectorFactory,
  ProviderLookup,
  ProviderLookupAddress,
  ProviderResponseConsumer,
  ProviderTransportAdmissionRequest,
  ProviderTransportDependencies,
  ProviderTransportRequest,
} from './types'

type Timer = ReturnType<typeof setTimeout>
type Decompressor = BrotliDecompress | Gunzip | Inflate
const ignoreStreamError = (): void => {}

const DISPATCH_ADMISSION_ERROR = 'PROVIDER_DISPATCH_ADMISSION_ERROR'

const dispatchAdmissionError = (original: unknown): Error & { original: unknown } =>
  Object.assign(new Error('provider dispatch admission failed'), {
    code: DISPATCH_ADMISSION_ERROR,
    original,
  })

const isDispatchAdmissionError = (error: unknown): error is Error & { original: unknown } =>
  error instanceof Error && (error as Error & { code?: unknown }).code === DISPATCH_ADMISSION_ERROR

const systemLookup: ProviderLookup = async (hostname) => {
  const answers = await dnsLookup(hostname, { all: true, order: 'verbatim' })

  return answers.flatMap((answer) =>
    answer.family === 4 || answer.family === 6
      ? [{ address: answer.address, family: answer.family }]
      : [],
  )
}

const pinnedLookup =
  (addresses: readonly ProviderLookupAddress[]) =>
  (
    _hostname: string,
    options: { all?: boolean },
    callback: (
      error: NodeJS.ErrnoException | null,
      address: string | ProviderLookupAddress[],
      family?: number,
    ) => void,
  ): void => {
    if (options.all) {
      callback(null, [...addresses])
      return
    }
    const first = addresses[0]
    callback(null, first.address, first.family)
  }

const defaultConnectorFactory: ProviderConnectorFactory = ({
  addresses,
  signal,
  connectTimeoutMs,
}) =>
  buildConnector({
    lookup: pinnedLookup(addresses),
    autoSelectFamily: addresses.length > 1,
    autoSelectFamilyAttemptTimeout: 250,
    signal,
    timeout: connectTimeoutMs,
  })

const raceAbort = async <T>(task: Promise<T>, signal: AbortSignal): Promise<T> => {
  if (signal.aborted) {
    throw signal.reason
  }
  let onAbort: (() => void) | undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
  })

  try {
    return await Promise.race([task, aborted])
  } finally {
    if (onAbort) {
      signal.removeEventListener('abort', onAbort)
    }
  }
}

const bodyBytes = (body: string | Uint8Array | undefined): number =>
  typeof body === 'string' ? Buffer.byteLength(body) : (body?.byteLength ?? 0)

const requestHeaders = (
  input: Readonly<Record<string, string>> | undefined,
  target: URL,
  limits: ProviderTransportLimits,
): Record<string, string> => {
  const entries = Object.entries(input ?? {})

  if (entries.length > limits.headerCount) {
    throw new ProviderTransportError(PROVIDER_TRANSPORT_ERROR.headersTooLarge)
  }
  const headers: Record<string, string> = {
    host: target.host,
    'accept-encoding': 'gzip, deflate, br',
  }
  let bytes = Object.entries(headers).reduce(
    (total, [name, value]) => total + Buffer.byteLength(name) + Buffer.byteLength(value) + 4,
    0,
  )

  for (const [name, value] of entries) {
    const lower = name.toLowerCase()

    if (lower === 'host' || lower === 'content-length' || lower === 'transfer-encoding') {
      throw new ProviderTransportError(PROVIDER_TRANSPORT_ERROR.invalidRequest)
    }
    if (lower in headers) {
      throw new ProviderTransportError(PROVIDER_TRANSPORT_ERROR.invalidRequest)
    }
    try {
      validateHeaderName(name)
      validateHeaderValue(name, value)
    } catch (cause) {
      throw new ProviderTransportError(PROVIDER_TRANSPORT_ERROR.invalidRequest, { cause })
    }
    bytes += Buffer.byteLength(name) + Buffer.byteLength(value) + 4
    headers[lower] = value
  }
  if (bytes > limits.headerBytes) {
    throw new ProviderTransportError(PROVIDER_TRANSPORT_ERROR.headersTooLarge)
  }

  return headers
}

const parseTarget = (
  input: Pick<ProviderTransportRequest, 'target' | 'trustedOrigin'>,
): { target: URL; origin: string } => {
  let target: URL

  try {
    target = new URL(input.target)
  } catch (cause) {
    throw new ProviderTransportError(PROVIDER_TRANSPORT_ERROR.invalidRequest, { cause })
  }
  if (
    (target.protocol !== 'http:' && target.protocol !== 'https:') ||
    target.username !== '' ||
    target.password !== '' ||
    target.hash !== ''
  ) {
    throw new ProviderTransportError(PROVIDER_TRANSPORT_ERROR.invalidRequest)
  }
  let trustedOrigin: string

  try {
    trustedOrigin = canonicalOriginOf(input.trustedOrigin)
  } catch (cause) {
    throw new ProviderTransportError(PROVIDER_TRANSPORT_ERROR.invalidRequest, { cause })
  }
  const origin = targetOriginOf(target)

  if (origin !== trustedOrigin) {
    throw new ProviderTransportError(PROVIDER_TRANSPORT_ERROR.policyDenied)
  }

  return { target, origin }
}

const normalizeAnswers = (answers: readonly ProviderLookupAddress[]): ProviderLookupAddress[] => {
  const unique = new Map<string, ProviderLookupAddress>()

  for (const answer of answers) {
    const policyAddress = normalizeIpAddress(answer.address)
    const family = isIP(answer.address)

    if (!policyAddress || (family !== 4 && family !== 6)) {
      throw new ProviderTransportError(PROVIDER_TRANSPORT_ERROR.policyDenied)
    }
    // Policy compares the normalized semantic address (including embedded IPv4),
    // while the connector keeps the exact address DNS returned. In particular,
    // a NAT64 address must not turn into a direct IPv4 connection after validation.
    unique.set(`${family}:${answer.address.toLowerCase()}`, {
      address: answer.address,
      family,
    })
  }
  if (unique.size === 0) {
    throw new ProviderTransportError(PROVIDER_TRANSPORT_ERROR.policyDenied)
  }

  return [...unique.values()]
}

const resolvedClass = (addresses: readonly ProviderLookupAddress[]): AddressClass => {
  const classes = new Set(addresses.map(({ address }) => classifyIpAddress(address)))

  if (classes.has(ADDRESS_CLASS.alwaysDenied) || classes.size !== 1) {
    throw new ProviderTransportError(PROVIDER_TRANSPORT_ERROR.policyDenied)
  }

  return classes.values().next().value!
}

const assertReachable = (
  addressClass: AddressClass,
  protocol: string,
  origin: string,
  privateOrigins: ReadonlySet<string>,
  allowPrivateNetwork: boolean,
): void => {
  if (addressClass === ADDRESS_CLASS.public) {
    if (protocol !== 'https:') {
      throw new ProviderTransportError(PROVIDER_TRANSPORT_ERROR.policyDenied)
    }

    return
  }
  if (
    !allowPrivateNetwork ||
    !privateOrigins.has(origin) ||
    (addressClass !== ADDRESS_CLASS.private && addressClass !== ADDRESS_CLASS.loopback)
  ) {
    throw new ProviderTransportError(PROVIDER_TRANSPORT_ERROR.policyDenied)
  }
}

const responseLength = (headers: Record<string, string | string[] | undefined>): number | null => {
  const raw = headers['content-length']
  const value = Array.isArray(raw) ? raw[0] : raw
  const parsed = value === undefined ? Number.NaN : Number(value)

  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
}

const contentEncoding = (headers: Record<string, string | string[] | undefined>): string => {
  const raw = headers['content-encoding']
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim().toLowerCase()

  return value || 'identity'
}

const decompressed = (
  body: Readable,
  encoding: string,
): { stream: Readable; decompressor?: Decompressor } => {
  let decompressor: Decompressor | undefined

  if (encoding === 'gzip') {
    decompressor = createGunzip()
  } else if (encoding === 'deflate') {
    decompressor = createInflate()
  } else if (encoding === 'br') {
    decompressor = createBrotliDecompress()
  } else if (encoding !== 'identity') {
    throw new ProviderTransportError(PROVIDER_TRANSPORT_ERROR.networkError)
  }

  return decompressor ? { stream: body.pipe(decompressor), decompressor } : { stream: body }
}

const cappedBody = (
  stream: Readable,
  maxBytes: number,
  firstByte: () => void,
): AsyncIterable<Uint8Array> => ({
  async *[Symbol.asyncIterator]() {
    let total = 0
    let started = false

    try {
      for await (const raw of stream) {
        if (!started) {
          started = true
          firstByte()
        }
        const chunk = typeof raw === 'string' ? Buffer.from(raw) : (raw as Uint8Array)
        total += chunk.byteLength
        if (total > maxBytes) {
          throw new ProviderTransportError(PROVIDER_TRANSPORT_ERROR.responseTooLarge)
        }
        yield chunk
      }
      if (!started) {
        firstByte()
      }
    } finally {
      stream.destroy()
    }
  },
})

const timerAbort = (
  controller: AbortController,
  milliseconds: number,
  code:
    typeof PROVIDER_TRANSPORT_ERROR.firstByteTimeout | typeof PROVIDER_TRANSPORT_ERROR.callTimeout,
): Timer => setTimeout(() => controller.abort(new ProviderTransportError(code)), milliseconds)

const timeoutOf = (
  override: number | null | undefined,
  profile: number,
  safetyCeiling: number,
): number => {
  if (override == null) {
    return profile
  }
  if (!Number.isSafeInteger(override) || override <= 0) {
    throw new ProviderTransportError(PROVIDER_TRANSPORT_ERROR.invalidRequest)
  }

  return Math.min(override, safetyCeiling)
}

export class ProviderTransport {
  private readonly privateOrigins: ReadonlySet<string>
  private readonly lookup: ProviderLookup
  private readonly connectorFactory: ProviderConnectorFactory
  private readonly limits: ProviderTransportLimits
  private readonly concurrency: PrincipalConcurrency

  constructor(
    privateOrigins: ReadonlySet<string>,
    dependencies: ProviderTransportDependencies = {},
  ) {
    this.privateOrigins = privateOrigins
    this.lookup = dependencies.lookup ?? systemLookup
    this.connectorFactory = dependencies.connectorFactory ?? defaultConnectorFactory
    this.limits = { ...PROVIDER_TRANSPORT_LIMIT, ...dependencies.limits }
    this.concurrency = new PrincipalConcurrency(
      this.limits.concurrentPerPrincipal,
      this.limits.queuedPerPrincipal,
    )
  }

  async admit(input: ProviderTransportAdmissionRequest): Promise<AddressClass> {
    return (await this.resolveTarget(input)).addressClass
  }

  private async resolveTarget(
    input: ProviderTransportAdmissionRequest,
    parsed = parseTarget(input),
  ): Promise<{
    target: URL
    origin: string
    addresses: ProviderLookupAddress[]
    addressClass: AddressClass
  }> {
    const { target, origin } = parsed
    const hostname = target.hostname.replace(/^\[|\]$/g, '')
    let rawAnswers: readonly ProviderLookupAddress[]

    if (isIP(hostname)) {
      rawAnswers = [{ address: hostname, family: isIP(hostname) as 4 | 6 }]
    } else {
      try {
        rawAnswers = await raceAbort(this.lookup(hostname, input.signal), input.signal)
      } catch (cause) {
        if (input.signal.aborted) {
          throw cause
        }
        throw new ProviderTransportError(PROVIDER_TRANSPORT_ERROR.policyDenied, { cause })
      }
    }
    const addresses = normalizeAnswers(rawAnswers)
    const addressClass = resolvedClass(addresses)
    assertReachable(
      addressClass,
      target.protocol,
      origin,
      this.privateOrigins,
      input.allowPrivateNetwork,
    )

    return { target, origin, addresses, addressClass }
  }

  async request<T>(
    input: ProviderTransportRequest,
    consume: ProviderResponseConsumer<T>,
  ): Promise<T> {
    let release: (() => void) | undefined
    let firstByteTimer: Timer | undefined
    let callTimer: Timer | undefined
    let agent: Agent | undefined
    let body: Readable | undefined
    let decompressor: Decompressor | undefined
    let connected = false
    const firstByteController = new AbortController()
    const callController = new AbortController()
    const operationStartedAt = Date.now()

    try {
      if (bodyBytes(input.body) > this.limits.requestBytes) {
        throw new ProviderTransportError(PROVIDER_TRANSPORT_ERROR.requestTooLarge)
      }
      const parsed = parseTarget(input)
      const initiallyLocal = input.allowPrivateNetwork && this.privateOrigins.has(parsed.origin)
      let firstByteMs = timeoutOf(
        input.firstByteTimeoutMs,
        initiallyLocal ? this.limits.localFirstByteMs : this.limits.externalFirstByteMs,
        this.limits.localFirstByteMs,
      )
      let callMs = timeoutOf(
        input.callTimeoutMs,
        initiallyLocal ? this.limits.localCallMs : this.limits.externalCallMs,
        this.limits.localCallMs,
      )

      callTimer = timerAbort(callController, callMs, PROVIDER_TRANSPORT_ERROR.callTimeout)
      const queueSignal = AbortSignal.any([input.signal, callController.signal])

      try {
        release = await this.concurrency.enter(input.principalId, queueSignal)
      } catch (cause) {
        if (callController.signal.reason instanceof ProviderTransportError) {
          throw callController.signal.reason
        }
        if (input.signal.aborted) {
          throw new ProviderTransportError(PROVIDER_TRANSPORT_ERROR.canceled, { cause })
        }
        if (isPrincipalQueueFullError(cause)) {
          throw new ProviderTransportError(PROVIDER_TRANSPORT_ERROR.callTimeout, { cause })
        }
        throw cause
      }
      const networkStartedAt = Date.now()
      firstByteTimer = timerAbort(
        firstByteController,
        firstByteMs,
        PROVIDER_TRANSPORT_ERROR.firstByteTimeout,
      )
      const signal = AbortSignal.any([
        input.signal,
        firstByteController.signal,
        callController.signal,
      ])
      const { target, addresses, addressClass } = await this.resolveTarget(
        {
          target: input.target,
          trustedOrigin: input.trustedOrigin,
          allowPrivateNetwork: input.allowPrivateNetwork,
          signal,
        },
        parsed,
      )

      const local = addressClass !== ADDRESS_CLASS.public

      if (local !== initiallyLocal) {
        clearTimeout(firstByteTimer)
        clearTimeout(callTimer)
        firstByteMs = timeoutOf(
          input.firstByteTimeoutMs,
          local ? this.limits.localFirstByteMs : this.limits.externalFirstByteMs,
          this.limits.localFirstByteMs,
        )
        callMs = timeoutOf(
          input.callTimeoutMs,
          local ? this.limits.localCallMs : this.limits.externalCallMs,
          this.limits.localCallMs,
        )
        const operationElapsed = Date.now() - operationStartedAt
        const networkElapsed = Date.now() - networkStartedAt

        if (networkElapsed >= firstByteMs) {
          throw new ProviderTransportError(PROVIDER_TRANSPORT_ERROR.firstByteTimeout)
        }
        if (operationElapsed >= callMs) {
          throw new ProviderTransportError(PROVIDER_TRANSPORT_ERROR.callTimeout)
        }
        firstByteTimer = timerAbort(
          firstByteController,
          firstByteMs - networkElapsed,
          PROVIDER_TRANSPORT_ERROR.firstByteTimeout,
        )
        callTimer = timerAbort(
          callController,
          callMs - operationElapsed,
          PROVIDER_TRANSPORT_ERROR.callTimeout,
        )
      }
      const operationElapsed = Date.now() - operationStartedAt
      const networkElapsed = Date.now() - networkStartedAt
      const baseConnector = this.connectorFactory({
        addresses,
        signal,
        connectTimeoutMs: Math.max(
          1,
          Math.min(firstByteMs - networkElapsed, callMs - operationElapsed),
        ),
      })
      const connector: ReturnType<typeof buildConnector> = (options, callback) =>
        baseConnector(options, (error, socket) => {
          if (error) {
            callback(error, null)
            return
          }
          if (!socket) {
            callback(new Error('provider connector returned no socket'), null)
            return
          }
          connected = true
          callback(null, socket)
        })

      agent = new Agent({ connect: connector, connections: 1, pipelining: 1 })
      if (input.beforeSend) {
        try {
          await input.beforeSend(signal)
          if (signal.aborted) {
            throw signal.reason
          }
        } catch (error) {
          throw dispatchAdmissionError(error)
        }
      }
      const response = await request(target, {
        dispatcher: agent,
        method: input.method,
        headers: requestHeaders(input.headers, target, this.limits),
        body: input.body,
        signal,
        headersTimeout: firstByteMs,
        bodyTimeout: 0,
      })

      body = response.body
      connected = true
      if (response.statusCode >= 300 && response.statusCode < 400) {
        clearTimeout(firstByteTimer)
        throw new ProviderTransportError(PROVIDER_TRANSPORT_ERROR.redirectDenied, {
          deliveryState: PROVIDER_DELIVERY_STATE.mayHaveSent,
        })
      }
      const maxBytes = input.stream
        ? this.limits.streamResponseBytes
        : this.limits.nonStreamResponseBytes
      const encoding = contentEncoding(response.headers)
      const length = responseLength(response.headers)

      if (encoding === 'identity' && length !== null && length > maxBytes) {
        throw new ProviderTransportError(PROVIDER_TRANSPORT_ERROR.responseTooLarge, {
          deliveryState: PROVIDER_DELIVERY_STATE.mayHaveSent,
        })
      }
      const decoded = decompressed(body, encoding)

      decompressor = decoded.decompressor
      const onFirstByte = (): void => {
        if (firstByteTimer) {
          clearTimeout(firstByteTimer)
          firstByteTimer = undefined
        }
      }

      return await consume({
        statusCode: response.statusCode,
        headers: response.headers,
        addressClass,
        effectiveCallTimeoutMs: callMs,
        body: cappedBody(decoded.stream, maxBytes, onFirstByte),
      })
    } catch (error) {
      const deliveryState = connected
        ? PROVIDER_DELIVERY_STATE.mayHaveSent
        : PROVIDER_DELIVERY_STATE.notSent

      if (isDispatchAdmissionError(error)) {
        throw error.original
      }
      if (error instanceof ProviderTransportError) {
        if (
          error.deliveryState === PROVIDER_DELIVERY_STATE.notSent &&
          deliveryState === PROVIDER_DELIVERY_STATE.mayHaveSent
        ) {
          throw new ProviderTransportError(error.code, { cause: error, deliveryState })
        }
        throw error
      }
      if (input.signal.aborted) {
        throw new ProviderTransportError(PROVIDER_TRANSPORT_ERROR.canceled, {
          cause: error,
          deliveryState,
        })
      }
      const timedOut = [firstByteController.signal, callController.signal].find(
        (signal) => signal.aborted,
      )

      if (timedOut?.reason instanceof ProviderTransportError) {
        throw new ProviderTransportError(timedOut.reason.code, {
          cause: timedOut.reason,
          deliveryState,
        })
      }

      throw new ProviderTransportError(PROVIDER_TRANSPORT_ERROR.networkError, {
        cause: error,
        deliveryState,
      })
    } finally {
      if (firstByteTimer) {
        clearTimeout(firstByteTimer)
      }
      if (callTimer) {
        clearTimeout(callTimer)
      }
      decompressor?.on('error', ignoreStreamError).destroy()
      body?.on('error', ignoreStreamError).destroy()
      await agent?.destroy().catch(() => {})
      release?.()
    }
  }
}
