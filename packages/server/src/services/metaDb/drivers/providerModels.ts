import {
  MODEL_CAPABILITY,
  MODEL_STATUS,
  type ModelCapability,
  type ModelStatus,
  type ProviderModel,
  type ProviderModelWrite,
} from '@notarium/contract'

const CAPABILITY_ORDER: Readonly<Record<ModelCapability, number>> = {
  [MODEL_CAPABILITY.completion]: 0,
  [MODEL_CAPABILITY.embedding]: 1,
}

export const canonicalProviderModels = (
  models: readonly ProviderModelWrite[],
): ProviderModelWrite[] =>
  models.map((model) => ({
    name: model.name,
    capabilities: [...model.capabilities].sort(
      (left, right) => CAPABILITY_ORDER[left] - CAPABILITY_ORDER[right],
    ),
  }))

const freshProviderModel = (model: ProviderModelWrite): ProviderModel => ({
  ...model,
  capabilities: [...model.capabilities],
  dimensions: null,
  statusByCapability: Object.fromEntries(
    model.capabilities.map((capability) => [capability, MODEL_STATUS.available]),
  ),
})

/** Merge human-authored rows with transaction-current runtime facts. Exact names are
 * identities; only retained capabilities keep their measurements. */
export const mergedProviderModels = (
  current: readonly ProviderModel[],
  authored: readonly ProviderModelWrite[],
): ProviderModel[] => {
  const currentByName = new Map(current.map((model) => [model.name, model]))

  return canonicalProviderModels(authored).map((model) => {
    const retained = currentByName.get(model.name)

    if (!retained) {
      return freshProviderModel(model)
    }
    const statusByCapability = Object.fromEntries(
      model.capabilities.map((capability) => [
        capability,
        retained.statusByCapability[capability] ?? MODEL_STATUS.available,
      ]),
    )

    return {
      ...model,
      capabilities: [...model.capabilities],
      dimensions: model.capabilities.includes(MODEL_CAPABILITY.embedding)
        ? retained.dimensions
        : null,
      statusByCapability,
    }
  })
}

export const applyProviderModelMeasurement = (
  models: readonly ProviderModel[],
  measurement: {
    modelName: string
    capability: ModelCapability
    status?: ModelStatus
    dimensions?: number
  },
): ProviderModel[] =>
  models.map((model) => {
    if (
      model.name !== measurement.modelName ||
      !model.capabilities.includes(measurement.capability)
    ) {
      return {
        ...model,
        capabilities: [...model.capabilities],
        statusByCapability: { ...model.statusByCapability },
      }
    }

    return {
      ...model,
      capabilities: [...model.capabilities],
      dimensions:
        measurement.capability !== MODEL_CAPABILITY.embedding ||
        measurement.dimensions === undefined
          ? model.dimensions
          : measurement.dimensions,
      statusByCapability: {
        ...model.statusByCapability,
        ...(measurement.status === undefined
          ? {}
          : { [measurement.capability]: measurement.status }),
      },
    }
  })
