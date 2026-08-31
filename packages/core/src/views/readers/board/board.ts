import type { ReaderDefinition } from '../../registry'
import type { ViewDefinition } from '../../types'

// canon: docs/views.md#board

export type BoardOptions = {
  groupBy: string
  order: { kind: 'manual'; ranks?: string }
}

const objectOf = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

const uniqueProperties = (view: ViewDefinition, groupBy: string): string[] => {
  const seen = new Set<string>()
  const out: string[] = []

  for (const property of [groupBy, ...(view.fields ?? [])]) {
    if (!seen.has(property)) {
      seen.add(property)
      out.push(property)
    }
  }

  return out
}

export const boardReaderDefinition: ReaderDefinition<BoardOptions> = {
  type: 'board',
  presentation: 'workspace',
  compileOptions: (raw) => {
    const options = objectOf(raw) ?? {}
    const groupBy = options.groupBy

    if (typeof groupBy !== 'string' || !groupBy.startsWith('note.') || groupBy.length <= 5) {
      return {
        status: 'invalid',
        diagnostics: ['board options.groupBy must address note.<key>'],
      }
    }
    const order = objectOf(options.order)

    if (order && order.kind !== 'manual') {
      return {
        status: 'invalid',
        diagnostics: ['board options.order.kind must be manual in v1'],
      }
    }
    if (order?.ranks !== undefined && typeof order.ranks !== 'string') {
      return {
        status: 'invalid',
        diagnostics: ['board options.order.ranks must be a JSONL scalar'],
      }
    }

    return {
      status: 'ready',
      options: {
        groupBy,
        order: {
          kind: 'manual',
          ...(typeof order?.ranks === 'string' ? { ranks: order.ranks } : {}),
        },
      },
      ...(Object.keys(options).some((key) => !['groupBy', 'order'].includes(key))
        ? { diagnostics: ['unknown board options are preserved and ignored'] }
        : {}),
    }
  },
  dataNeeds: (options, view) => ({
    properties: uniqueProperties(view, options.groupBy),
    includeCardFields: true,
    groupBy: options.groupBy,
    window: 'group',
    order: { kind: 'manual-rank', ...(options.order.ranks ? { ranks: options.order.ranks } : {}) },
  }),
  summaryDataNeeds: (options) => ({
    properties: [options.groupBy],
    groupBy: options.groupBy,
    window: 'group',
  }),
  mutationCapabilities: () => ({ move: true, editOptions: true }),
  project: (data, options) => ({ type: 'board', options, data }),
}
