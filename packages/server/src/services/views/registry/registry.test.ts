import { describe, expect, it } from 'vitest'

import { assertViewProjectionRegistryParity, projectReaderView } from '../viewProjection'
import { VIEW_PROJECTION_ADAPTERS, VIEW_READER_REGISTRY } from './registry'

describe('built-in view registry', () => {
  it('keeps board pure/server registrations in lockstep', () => {
    expect(() =>
      assertViewProjectionRegistryParity(VIEW_READER_REGISTRY, VIEW_PROJECTION_ADAPTERS),
    ).not.toThrow()
    expect(
      projectReaderView(
        VIEW_READER_REGISTRY,
        VIEW_PROJECTION_ADAPTERS,
        { name: 'Board', type: 'board', options: { groupBy: 'note.status' } },
        { groups: [{ key: 'doing' }], total: 12 },
      ),
    ).toMatchObject({ status: 'ready', prose: 'Board · 1 columns · 12 cards' })
  })
})
