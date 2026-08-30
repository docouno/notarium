import type { IncomingHttpHeaders } from 'node:http'
import type { buildConnector } from 'undici'

import type { AddressClass } from '../../../libs/originPolicy'
import type { ProviderTransportLimits } from './consts'

export type ProviderLookupAddress = {
  address: string
  family: 4 | 6
}

export type ProviderLookup = (
  hostname: string,
  signal: AbortSignal,
) => Promise<readonly ProviderLookupAddress[]>

export type ProviderConnectorFactory = (input: {
  addresses: readonly ProviderLookupAddress[]
  signal: AbortSignal
  connectTimeoutMs: number
}) => ReturnType<typeof buildConnector>

export type ProviderTransportDependencies = {
  lookup?: ProviderLookup
  connectorFactory?: ProviderConnectorFactory
  limits?: Partial<ProviderTransportLimits>
}

export type ProviderTransportRequest = {
  principalId: string
  target: string | URL
  trustedOrigin: string
  allowPrivateNetwork: boolean
  method: string
  headers?: Readonly<Record<string, string>>
  body?: string | Uint8Array
  stream: boolean
  /** Null/omitted selects the profile after address classification. */
  firstByteTimeoutMs?: number | null
  /** Null/omitted selects the profile after address classification. */
  callTimeoutMs?: number | null
  signal: AbortSignal
  /** Runs after bounded concurrency + DNS policy admission and immediately
   *  before any socket may send bytes. */
  beforeSend?: (signal: AbortSignal) => Promise<void>
}

export type ProviderTransportAdmissionRequest = Pick<
  ProviderTransportRequest,
  'target' | 'trustedOrigin' | 'allowPrivateNetwork' | 'signal'
>

export type ProviderTransportResponse = {
  statusCode: number
  headers: IncomingHttpHeaders
  addressClass: AddressClass
  effectiveCallTimeoutMs: number
  body: AsyncIterable<Uint8Array>
}

export type ProviderResponseConsumer<T> = (response: ProviderTransportResponse) => Promise<T> | T
