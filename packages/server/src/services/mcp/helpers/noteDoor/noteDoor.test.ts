import { describe, expect, it, vi } from 'vitest'
import { noteNotFound } from '@notarium/core'

import type { Ctx } from '../../gateway'
import { openMcpNoteDoor } from './noteDoor'

const contextWithRead = (read: () => Promise<never>): Ctx =>
  ({
    principal: { id: 'pat:alice:test' },
    store: {
      noteStore: vi.fn().mockResolvedValue({
        space: 'personal-id',
        store: { read },
      }),
    },
  }) as unknown as Ctx

describe('openMcpNoteDoor read failures', () => {
  it('collapses a typed not-found after access to the anti-enumeration miss', async () => {
    const ctx = contextWithRead(() => Promise.reject(noteNotFound('gone')))

    await expect(openMcpNoteDoor(ctx, 'gone', 'note:read')).resolves.toBeNull()
  })

  it('preserves an operational read failure for the gateway error mapper', async () => {
    const failure = new Error('storage unavailable')
    const ctx = contextWithRead(() => Promise.reject(failure))

    await expect(openMcpNoteDoor(ctx, 'live-note', 'note:read')).rejects.toBe(failure)
  })
})
