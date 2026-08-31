import { describe, expect, it } from 'vitest'

import { compileReaderSummaryView, compileReaderView, createReaderRegistry } from '../../registry'
import { boardReaderDefinition } from './board'

describe('board reader definition', () => {
  const registry = createReaderRegistry([boardReaderDefinition])

  it('compiles scalar grouping as generic source needs and deduplicates fields', () => {
    expect(
      compileReaderView(registry, {
        name: 'Board',
        type: 'board',
        fields: ['note.owner', 'note.status', 'note.owner'],
        options: { groupBy: 'note.status' },
      }),
    ).toMatchObject({
      status: 'ready',
      options: { groupBy: 'note.status', order: { kind: 'manual' } },
      dataNeeds: {
        properties: ['note.status', 'note.owner'],
        includeCardFields: true,
        groupBy: 'note.status',
        window: 'group',
      },
    })
  })

  it('owns a count-only summary plan without card fields or rank ordering', () => {
    expect(
      compileReaderSummaryView(registry, {
        name: 'Board',
        type: 'board',
        fields: ['note.owner'],
        options: {
          groupBy: 'note.status',
          order: { kind: 'manual', ranks: '["task","a0"]' },
        },
      }),
    ).toMatchObject({
      status: 'ready',
      dataNeeds: {
        properties: ['note.status'],
        groupBy: 'note.status',
        window: 'group',
      },
    })
  })

  it('keeps board-specific validation out of the carrier', () => {
    expect(
      compileReaderView(registry, { name: 'Board', type: 'board', options: {} }),
    ).toMatchObject({ status: 'invalid' })
    expect(
      compileReaderView(registry, {
        name: 'Board',
        type: 'board',
        options: { groupBy: 'note.status', order: { kind: 'typed' } },
      }),
    ).toMatchObject({ status: 'invalid' })
  })
})
