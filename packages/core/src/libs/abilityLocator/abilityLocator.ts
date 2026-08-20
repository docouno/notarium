import type { AbilityLocator } from '@notarium/contract'

import { isDurableScalar, isGeneratedNoteId } from '../id'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value === 'object' && !Array.isArray(value)

/** A package address is the exact storage-address form a host mints — the same thing
 *  the file library and the in-file skill link demand. The wider "any durable scalar"
 *  domain this used to accept was a second definition of the package identity, and it
 *  published addresses nothing in the system could store. */
const validPackageId = (value: unknown): value is string =>
  typeof value === 'string' && isGeneratedNoteId(value) && isDurableScalar(value)

export const isAbilityLocator = (value: unknown): value is AbilityLocator => {
  if (
    !isRecord(value) ||
    !validPackageId(value.packageId) ||
    (value.kind !== 'role' && value.kind !== 'skill')
  ) {
    return false
  }
  if (value.source === 'system' || value.source === 'catalog') {
    return Object.keys(value).every((key) => ['source', 'kind', 'packageId'].includes(key))
  }
  if (value.source !== 'owned' || !isRecord(value.location)) {
    return false
  }
  if (
    !Object.keys(value).every((key) => ['source', 'kind', 'packageId', 'location'].includes(key))
  ) {
    return false
  }
  const location = value.location

  if (
    typeof location.spaceId !== 'string' ||
    !location.spaceId ||
    !isDurableScalar(location.spaceId)
  ) {
    return false
  }
  if (location.scope === 'personal' || location.scope === 'space') {
    return Object.keys(location).every((key) => ['scope', 'spaceId'].includes(key))
  }

  return (
    value.kind === 'role' &&
    location.scope === 'project' &&
    typeof location.projectId === 'string' &&
    location.projectId.length > 0 &&
    isDurableScalar(location.projectId) &&
    Object.keys(location).every((key) => ['scope', 'spaceId', 'projectId'].includes(key))
  )
}

/** Stable field order for persistence, cache keys and opaque route encoding. */
export const serializeAbilityLocator = (locator: AbilityLocator): string => {
  if (!isAbilityLocator(locator)) {
    throw new Error('invalid ability locator')
  }
  if (locator.source !== 'owned') {
    return JSON.stringify({
      source: locator.source,
      kind: locator.kind,
      packageId: locator.packageId,
    })
  }
  const location =
    locator.location.scope === 'project'
      ? {
          scope: locator.location.scope,
          spaceId: locator.location.spaceId,
          projectId: locator.location.projectId,
        }
      : { scope: locator.location.scope, spaceId: locator.location.spaceId }

  return JSON.stringify({
    source: locator.source,
    kind: locator.kind,
    packageId: locator.packageId,
    location,
  })
}

export const parseAbilityLocator = (value: string): AbilityLocator | null => {
  try {
    const parsed: unknown = JSON.parse(value)
    return isAbilityLocator(parsed) ? parsed : null
  } catch {
    return null
  }
}

const base64url = (bytes: Uint8Array): string => {
  let binary = ''

  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }

  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

const fromBase64url = (value: string): Uint8Array | null => {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    return null
  }
  try {
    const encoded = value.replaceAll('-', '+').replaceAll('_', '/')
    const binary = atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '='))
    return Uint8Array.from(binary, (char) => char.charCodeAt(0))
  } catch {
    return null
  }
}

export const encodeAbilityLocator = (locator: AbilityLocator): string =>
  base64url(new TextEncoder().encode(serializeAbilityLocator(locator)))

export const decodeAbilityLocator = (value: string): AbilityLocator | null => {
  const bytes = fromBase64url(value)

  if (!bytes) {
    return null
  }
  try {
    return parseAbilityLocator(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    return null
  }
}
