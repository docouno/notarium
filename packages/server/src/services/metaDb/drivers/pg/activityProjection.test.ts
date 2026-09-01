import type { PoolClient } from 'pg'
import { expect, it, vi } from 'vitest'

import { maintainPgActivityProjectionProgressBatch } from './activityProjection'

it('rolls back a progress batch when source invalidation retires its generation', async () => {
  const statements: string[] = []
  const query = vi.fn(async (text: string) => {
    statements.push(text.trim())

    if (text.startsWith('SELECT * FROM activity_projection_status')) {
      return {
        rows: [
          {
            state: 'rebuilding',
            legacy_through_revision_id: '20',
            next_source_ordinal: '20',
            generation_counter: '1',
            active_generation: null,
            active_through: null,
            build_generation: '1',
            rebuild_cursor: '0',
            source_generation: '1',
            build_source_generation: '1',
          },
        ],
        rowCount: 1,
      }
    }
    if (text.includes('SELECT source_ordinal FROM source')) {
      return {
        rows: Array.from({ length: 11 }, (_, index) => ({ source_ordinal: String(index + 1) })),
        rowCount: 11,
      }
    }
    if (text.includes('UPDATE activity_projection_status')) {
      return { rows: [], rowCount: 0 }
    }

    return { rows: [], rowCount: 1 }
  })
  const client = { query } as unknown as PoolClient

  await expect(maintainPgActivityProjectionProgressBatch(client, 'space-a')).resolves.toEqual({
    state: 'rebuilding',
    processed: 0,
    published: false,
  })
  expect(statements.at(-1)).toBe('ROLLBACK')
  expect(statements).not.toContain('COMMIT')
})
