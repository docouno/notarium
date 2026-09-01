import type { ActivityProjectionLease } from '../knowledgeStore'
import { activityProjectionInvalid } from '../knowledgeStore'

type ActivityVersionPayload = {
  v: 1
  space: string
  activeGeneration: string
  sourceGeneration: string
}

const decimal = /^[1-9]\d*$/
const base64url = /^[A-Za-z0-9_-]+$/
const payloadKeys = ['activeGeneration', 'sourceGeneration', 'space', 'v']

const bytesToBase64url = (bytes: Uint8Array): string => {
  let binary = ''

  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }

  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

const base64urlToBytes = (value: string): Uint8Array => {
  if (!base64url.test(value)) {
    throw activityProjectionInvalid()
  }
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/')
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  let binary: string

  try {
    binary = atob(padded)
  } catch {
    throw activityProjectionInvalid()
  }

  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))

  if (bytesToBase64url(bytes) !== value) {
    throw activityProjectionInvalid()
  }

  return bytes
}

export const encodeActivityVersion = (space: string, lease: ActivityProjectionLease): string =>
  bytesToBase64url(
    new TextEncoder().encode(
      JSON.stringify({
        v: 1,
        space,
        activeGeneration: lease.activeGeneration,
        sourceGeneration: lease.sourceGeneration,
      } satisfies ActivityVersionPayload),
    ),
  )

export const decodeActivityVersion = (space: string, token: string): ActivityVersionPayload => {
  let value: unknown

  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(base64urlToBytes(token)))
  } catch (error) {
    if (error instanceof Error && 'reason' in error) {
      throw error
    }
    throw activityProjectionInvalid()
  }

  if (
    value == null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join('\0') !== payloadKeys.join('\0')
  ) {
    throw activityProjectionInvalid()
  }
  const payload = value as Partial<ActivityVersionPayload>

  if (
    payload.v !== 1 ||
    payload.space !== space ||
    typeof payload.activeGeneration !== 'string' ||
    !decimal.test(payload.activeGeneration) ||
    typeof payload.sourceGeneration !== 'string' ||
    !decimal.test(payload.sourceGeneration)
  ) {
    throw activityProjectionInvalid()
  }

  return payload as ActivityVersionPayload
}
