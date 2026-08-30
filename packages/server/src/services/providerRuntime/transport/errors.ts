import { PROVIDER_DELIVERY_STATE, type ProviderDeliveryState } from '@notarium/contract'

import { PROVIDER_TRANSPORT_ERROR, type ProviderTransportErrorCode } from './consts'

const MESSAGE: Record<ProviderTransportErrorCode, string> = {
  [PROVIDER_TRANSPORT_ERROR.policyDenied]: 'provider network policy denied the request',
  [PROVIDER_TRANSPORT_ERROR.invalidRequest]: 'provider request is invalid',
  [PROVIDER_TRANSPORT_ERROR.networkError]: 'provider network request failed',
  [PROVIDER_TRANSPORT_ERROR.redirectDenied]: 'provider redirect is not allowed',
  [PROVIDER_TRANSPORT_ERROR.canceled]: 'provider request was canceled',
  [PROVIDER_TRANSPORT_ERROR.firstByteTimeout]: 'provider did not start a response in time',
  [PROVIDER_TRANSPORT_ERROR.callTimeout]: 'provider request exceeded its time limit',
  [PROVIDER_TRANSPORT_ERROR.requestTooLarge]: 'provider request body is too large',
  [PROVIDER_TRANSPORT_ERROR.responseTooLarge]: 'provider response body is too large',
  [PROVIDER_TRANSPORT_ERROR.headersTooLarge]: 'provider request headers are too large',
}

export class ProviderTransportError extends Error {
  readonly code: ProviderTransportErrorCode
  readonly deliveryState: ProviderDeliveryState

  constructor(
    code: ProviderTransportErrorCode,
    options: ErrorOptions & { deliveryState?: ProviderDeliveryState } = {},
  ) {
    super(MESSAGE[code], options)
    this.name = 'ProviderTransportError'
    this.code = code
    this.deliveryState = options.deliveryState ?? PROVIDER_DELIVERY_STATE.notSent
  }
}
