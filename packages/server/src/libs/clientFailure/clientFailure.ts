const CLIENT_FAILURE = Symbol('clientFailure')

export type ClientFailure =
  Readonly<{ kind: 'not-found' }> | Readonly<{ kind: 'conflict' | 'actionable'; message: string }>

type ClientFailureCarrier = {
  [CLIENT_FAILURE]?: unknown
}

const validatedFailure = (failure: ClientFailure): ClientFailure => {
  if (failure.kind === 'not-found') {
    if ('message' in failure) {
      throw new TypeError('a not-found client failure cannot carry a message')
    }

    return Object.freeze({ kind: failure.kind })
  }

  if (
    (failure.kind !== 'conflict' && failure.kind !== 'actionable') ||
    typeof failure.message !== 'string' ||
    failure.message.trim().length === 0
  ) {
    throw new TypeError('a client failure message must be a non-empty string')
  }

  return Object.freeze({ kind: failure.kind, message: failure.message })
}

export const defineClientFailure = <T extends Error>(error: T, failure: ClientFailure): T => {
  if (!(error instanceof Error)) {
    throw new TypeError('only Error instances can carry a client failure')
  }

  Object.defineProperty(error, CLIENT_FAILURE, {
    configurable: false,
    enumerable: false,
    value: validatedFailure(failure),
    writable: false,
  })
  return error
}

export const clientFailureOf = (error: unknown): ClientFailure | null => {
  if ((typeof error !== 'object' && typeof error !== 'function') || error === null) {
    return null
  }

  const failure = (error as ClientFailureCarrier)[CLIENT_FAILURE]

  if (failure == null || typeof failure !== 'object' || !('kind' in failure)) {
    return null
  }
  if ((failure as { kind: unknown }).kind === 'not-found') {
    return 'message' in failure ? null : { kind: 'not-found' }
  }
  if (
    ((failure as { kind: unknown }).kind === 'conflict' ||
      (failure as { kind: unknown }).kind === 'actionable') &&
    'message' in failure &&
    typeof (failure as { message: unknown }).message === 'string' &&
    (failure as { message: string }).message.trim().length > 0
  ) {
    return {
      kind: (failure as { kind: 'conflict' | 'actionable' }).kind,
      message: (failure as { message: string }).message,
    }
  }

  return null
}
