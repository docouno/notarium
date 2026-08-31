import { boardReaderDefinition, createReaderRegistry } from '@notarium/core'

import { NotesViewSource } from '../notesSource'
import { createViewSourceRegistry } from '../sourceRegistry'
import type { ViewProjectionAdapters } from '../viewProjection'

export const VIEW_READER_REGISTRY = createReaderRegistry([boardReaderDefinition])
export const VIEW_SOURCE_REGISTRY = createViewSourceRegistry([new NotesViewSource()])

export const VIEW_PROJECTION_ADAPTERS: ViewProjectionAdapters = Object.freeze({
  board: {
    summary: (projection) => {
      const data = (projection as { data?: { groups?: unknown[]; total?: number } }).data
      const columns = data?.groups?.length ?? 0
      const cards = data?.total ?? 0
      const columnLabel = columns === 1 ? 'column' : 'columns'
      const cardLabel = cards === 1 ? 'card' : 'cards'

      return `${columns} ${columnLabel} · ${cards} ${cardLabel}`
    },
    prose: (projection) => {
      const data = (projection as { data?: { groups?: unknown[]; total?: number } }).data
      return `Board · ${data?.groups?.length ?? 0} columns · ${data?.total ?? 0} cards`
    },
    structured: (projection) => {
      const data = (projection as { data?: { groups?: unknown[]; total?: number } }).data
      return {
        kind: 'board',
        columns: data?.groups ?? [],
        total: data?.total ?? 0,
      }
    },
  },
})
