import { canonicalOriginOf } from '../../libs/originPolicy'
import {
  type ProviderCallLogRetentionDays,
  providerCallLogRetentionFromEnv,
} from '../../services/metaDb'

export type ProviderConfig = {
  enabled: boolean
  privateOrigins: ReadonlySet<string>
  callLogRetentionDays?: ProviderCallLogRetentionDays
}

export const providersEnabledFromEnv = (raw: string | undefined): boolean => {
  if (raw === undefined || raw === 'false') {
    return false
  }
  if (raw === 'true') {
    return true
  }

  throw new Error('PROVIDERS_ENABLED must be "true" or "false"')
}

const invalidOrigin = (position: number): Error =>
  new Error(
    `PROVIDERS_PRIVATE_ORIGINS item ${position} must be an exact HTTP(S) origin without userinfo, path, query, fragment, wildcard, or CIDR`,
  )

export const providersPrivateOriginsFromEnv = (raw: string | undefined): ReadonlySet<string> => {
  if (raw === undefined || raw.trim() === '') {
    return new Set()
  }

  const origins = new Set<string>()

  for (const [index, item] of raw.split(',').entries()) {
    const value = item.trim()

    if (!value) {
      throw invalidOrigin(index + 1)
    }
    try {
      origins.add(canonicalOriginOf(value))
    } catch {
      throw invalidOrigin(index + 1)
    }
  }

  return origins
}

export { providerCallLogRetentionFromEnv }
