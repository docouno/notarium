import type { ViewDefinition } from './types'

export type ReaderCompileResult<Options> =
  | { status: 'ready'; options: Options; diagnostics?: readonly string[] }
  | { status: 'invalid'; diagnostics: readonly string[] }

export type ViewDataNeeds = {
  properties: readonly string[]
  /** Include schema declarations marked for card presentation. The source owns
   * schema expansion so every card reader gets the same field semantics. */
  includeCardFields?: boolean
  groupBy?: string
  window: 'source' | 'group'
  order?: { kind: 'manual-rank'; ranks?: string }
}

export type ViewMutationCapabilities = {
  move?: boolean
  editOptions?: boolean
}

export type ReaderDomainProjection = unknown
export type ReaderPresentation = 'document' | 'workspace'

export type ReaderDefinition<Options = unknown> = {
  type: string
  /** Page geometry is reader-owned presentation metadata. A workspace reader uses
   * the surrounding note as configuration/provenance without inheriting prose width. */
  presentation?: ReaderPresentation
  compileOptions(raw: unknown): ReaderCompileResult<Options>
  dataNeeds(options: Options, view: ViewDefinition): ViewDataNeeds
  /** Minimal source projection needed for a compact list summary. Readers that
   * omit it reuse their regular needs. */
  summaryDataNeeds?(options: Options, view: ViewDefinition): ViewDataNeeds
  mutationCapabilities(options: Options): ViewMutationCapabilities
  project(data: unknown, options: Options): ReaderDomainProjection
}

export type ReaderRegistry = {
  readonly types: readonly string[]
  get(type: string): ReaderDefinition | undefined
}

export const createReaderRegistry = (definitions: readonly ReaderDefinition[]): ReaderRegistry => {
  const byType = new Map<string, ReaderDefinition>()

  for (const definition of definitions) {
    const type = definition.type.trim()

    if (!type) {
      throw new Error('reader type must be non-empty')
    }
    if (byType.has(type)) {
      throw new Error(`duplicate reader type: ${type}`)
    }
    byType.set(type, definition)
  }
  const types = Object.freeze([...byType.keys()])

  return Object.freeze({
    types,
    get: (type: string) => byType.get(type),
  })
}

export const compileReaderView = (
  registry: ReaderRegistry,
  view: ViewDefinition,
):
  | { status: 'unsupported' }
  | {
      status: 'invalid'
      diagnostics: readonly string[]
    }
  | {
      status: 'ready'
      definition: ReaderDefinition
      options: unknown
      dataNeeds: ViewDataNeeds
      mutationCapabilities: ViewMutationCapabilities
    } => {
  const definition = registry.get(view.type)

  if (!definition) {
    return { status: 'unsupported' }
  }
  const compiled = definition.compileOptions(view.options)

  if (compiled.status === 'invalid') {
    return compiled
  }

  return {
    status: 'ready',
    definition,
    options: compiled.options,
    dataNeeds: definition.dataNeeds(compiled.options, view),
    mutationCapabilities: definition.mutationCapabilities(compiled.options),
  }
}

export const compileReaderSummaryView = (
  registry: ReaderRegistry,
  view: ViewDefinition,
): ReturnType<typeof compileReaderView> => {
  const compiled = compileReaderView(registry, view)

  if (compiled.status !== 'ready' || !compiled.definition.summaryDataNeeds) {
    return compiled
  }

  return {
    ...compiled,
    dataNeeds: compiled.definition.summaryDataNeeds(compiled.options, view),
  }
}
