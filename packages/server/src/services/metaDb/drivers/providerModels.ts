import type { ProviderModel } from '@notarium/contract'

/** Merge one measured model into the collection, in place by name. The column is a
 *  collection every driver rewrites whole, so the merge lives in one place rather
 *  than being re-derived per driver. */
export const mergedProviderModels = (
  models: readonly ProviderModel[],
  model: ProviderModel,
): ProviderModel[] => {
  const merged = models.map((candidate) => ({ ...candidate }))
  const index = merged.findIndex((candidate) => candidate.name === model.name)

  if (index < 0) {
    merged.push({ ...model })
  } else {
    merged[index] = { ...model }
  }

  return merged
}
