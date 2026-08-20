import type { AbilityLocator } from '@notarium/contract'

import { decodeUtf8Base64Url, encodeUtf8Base64Url } from '../base64url'
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

export const encodeAbilityLocator = (locator: AbilityLocator): string =>
  encodeUtf8Base64Url(serializeAbilityLocator(locator))

export const decodeAbilityLocator = (value: string): AbilityLocator | null => {
  const decoded = decodeUtf8Base64Url(value)

  if (decoded == null) {
    return null
  }

  return parseAbilityLocator(decoded)
}
