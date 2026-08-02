import { slugify } from '@notarium/core'

import type { SpaceRecord } from '../metaDb'

type SpaceAddress = Pick<SpaceRecord, 'id' | 'slug' | 'aliases'>

/** Build the product's slug/alias boundary: every current slug wins over every
 *  retired alias, while an alias shared by multiple spaces is omitted as
 *  ambiguous. That fail-closed rule makes resolution independent of registry
 *  ordering — especially important because the runtime and recovery CLI load
 *  the same registry through different composition paths. */
export const buildSpaceSlugIndex = (records: readonly SpaceAddress[]): Map<string, string> => {
  const index = new Map<string, string>()
  const aliasCandidates = new Map<string, string | null>()

  for (const record of records) {
    index.set(record.slug, record.id)
  }
  for (const record of records) {
    for (const alias of record.aliases) {
      const key = slugify(alias)

      if (!key || index.has(key)) {
        continue
      }
      if (!aliasCandidates.has(key)) {
        aliasCandidates.set(key, record.id)
      } else if (aliasCandidates.get(key) !== record.id) {
        aliasCandidates.set(key, null)
      }
    }
  }
  for (const [alias, id] of aliasCandidates) {
    if (id) {
      index.set(alias, id)
    }
  }

  return index
}

/** Alias history safe to expose as still-addressable. Shadowed aliases and
 *  aliases shared by multiple spaces stay in durable history but are omitted
 *  from the wire because neither the server nor a client may resolve them. */
export const resolvableSpaceAliases = (records: readonly SpaceAddress[], id: string): string[] => {
  const record = records.find((candidate) => candidate.id === id)

  if (!record) {
    return []
  }
  const index = buildSpaceSlugIndex(records)
  return record.aliases.filter((alias) => {
    const key = slugify(alias)
    return Boolean(key) && (index.get(alias) ?? index.get(key)) === id
  })
}

/** Recovery reference resolution. Stable ids are accepted exactly and take
 *  precedence; human-facing current slugs and past aliases use the same index
 *  semantics as SpaceManager's request boundary. */
export const resolveSpaceRecord = (
  records: readonly SpaceRecord[],
  reference: string,
): SpaceRecord | null => {
  const byId = new Map(records.map((record) => [record.id, record]))
  const exact = byId.get(reference)

  if (exact) {
    return exact
  }
  const bySlug = buildSpaceSlugIndex(records)
  const id = bySlug.get(reference) ?? bySlug.get(slugify(reference))

  return id ? (byId.get(id) ?? null) : null
}
