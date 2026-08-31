import { compileReaderView, type ReaderRegistry, type ViewDefinition } from '@notarium/core'

export type ViewProjectionAdapter = {
  /** Reader-owned compact Feed wording. Returning null omits the summary. */
  summary?(projection: unknown): string | null
  prose(projection: unknown): string
  structured(projection: unknown): Record<string, unknown>
}

export type ViewProjectionAdapters = Readonly<Record<string, ViewProjectionAdapter>>

export const summarizeReaderView = (
  registry: ReaderRegistry,
  adapters: ViewProjectionAdapters,
  view: ViewDefinition,
  data: unknown,
): string | null => {
  const compiled = compileReaderView(registry, view)

  if (compiled.status !== 'ready') {
    return null
  }
  const projection = compiled.definition.project(data, compiled.options)

  return adapters[view.type]?.summary?.(projection) ?? null
}

export const assertViewProjectionRegistryParity = (
  registry: ReaderRegistry,
  adapters: ViewProjectionAdapters,
): void => {
  const adapterTypes = Object.keys(adapters).sort()
  const definitionTypes = [...registry.types].sort()

  if (
    adapterTypes.length !== definitionTypes.length ||
    adapterTypes.some((type, index) => type !== definitionTypes[index])
  ) {
    throw new Error('view reader definitions and server projection adapters are out of sync')
  }
}

export const projectReaderView = (
  registry: ReaderRegistry,
  adapters: ViewProjectionAdapters,
  view: ViewDefinition,
  data: unknown,
):
  | { status: 'unsupported' }
  | { status: 'invalid'; diagnostics: readonly string[] }
  | { status: 'ready'; prose: string; structured: Record<string, unknown> } => {
  const compiled = compileReaderView(registry, view)

  if (compiled.status !== 'ready') {
    return compiled
  }
  const adapter = adapters[view.type]

  if (!adapter) {
    throw new Error(`registered view reader has no server adapter: ${view.type}`)
  }
  const projection = compiled.definition.project(data, compiled.options)

  return {
    status: 'ready',
    prose: adapter.prose(projection),
    structured: adapter.structured(projection),
  }
}
