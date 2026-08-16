const LEGACY_NAME_ALIAS = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/

export const canonicalLegacyNameAliases = (value: unknown): readonly string[] => {
  if (!Array.isArray(value) || value.some((alias) => !isLegacyNameAlias(alias))) {
    return []
  }

  return [...new Set(value)].sort()
}

export const isLegacyNameAlias = (value: unknown): value is string =>
  typeof value === 'string' && LEGACY_NAME_ALIAS.test(value)

export const unionLegacyNameAliases = (
  ...sets: ReadonlyArray<readonly string[]>
): readonly string[] =>
  canonicalLegacyNameAliases(sets.flatMap((aliases) => canonicalLegacyNameAliases(aliases)))

export const appendLegacyNameAlias = (
  aliases: readonly string[],
  alias: string,
): readonly string[] => unionLegacyNameAliases(aliases, [alias])
