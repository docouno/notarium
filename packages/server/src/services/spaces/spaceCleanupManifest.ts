import type { SpaceRecord } from '../metaDb'

export type SpaceCleanupManifest = {
  version: 1
  space: SpaceRecord
}

const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === 'string'

const isSpaceRecord = (value: unknown): value is SpaceRecord => {
  if (!value || typeof value !== 'object') {
    return false
  }
  const record = value as Partial<SpaceRecord>

  return (
    typeof record.id === 'string' &&
    typeof record.slug === 'string' &&
    typeof record.displayName === 'string' &&
    typeof record.notesDir === 'string' &&
    Array.isArray(record.aliases) &&
    record.aliases.every((alias) => typeof alias === 'string') &&
    typeof record.createdAt === 'string' &&
    typeof record.archivedAt === 'string' &&
    isNullableString(record.archivedBy)
  )
}

export const encodeSpaceCleanupManifest = (space: SpaceRecord): string =>
  JSON.stringify({ version: 1, space: { ...space, aliases: [...space.aliases] } })

export const decodeSpaceCleanupManifest = (encoded: string | null): SpaceCleanupManifest => {
  let value: unknown

  try {
    value = encoded == null ? null : JSON.parse(encoded)
  } catch {
    throw new Error('space cleanup manifest is not valid JSON')
  }
  const manifest = value as Partial<SpaceCleanupManifest> | null

  if (!manifest || manifest.version !== 1 || !isSpaceRecord(manifest.space)) {
    throw new Error('space cleanup manifest is invalid')
  }

  return {
    version: 1,
    space: { ...manifest.space, aliases: [...manifest.space.aliases] },
  }
}
