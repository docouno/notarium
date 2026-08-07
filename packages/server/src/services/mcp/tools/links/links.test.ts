import { describe, expect, it, vi } from 'vitest'

import type { Ctx } from '../../gateway'
import { resolveLinkTitle } from './links'

const context = (detail: { id: string; title: string }): Ctx =>
  ({
    principal: { id: 'agent' },
    store: {
      noteStore: vi.fn().mockResolvedValue({
        space: 'main',
        store: { read: vi.fn().mockResolvedValue(detail) },
      }),
    },
  }) as unknown as Ctx

describe('resolveLinkTitle', () => {
  it('rejects a forward title that already resolves back to the source', async () => {
    const ctx = context({ id: 'other-id', title: 'Other' })
    ctx.store.spaceStore = vi.fn().mockResolvedValue({
      resolveWikilink: vi.fn().mockResolvedValue({ id: 'durable-source', title: 'Source' }),
    })

    await expect(
      resolveLinkTitle(ctx, {
        fromId: 'durable-source',
        fromSpace: 'main',
        relation: 'links_to',
        toTitle: 'Former Source Name',
      }),
    ).rejects.toThrow(/cannot be linked to itself/i)
  })

  it('materializes the durable id returned for a provisional target', async () => {
    await expect(
      resolveLinkTitle(context({ id: 'durable-id', title: 'Target' }), {
        fromSpace: 'main',
        relation: 'links_to',
        to: 'provisional-id',
      }),
    ).resolves.toBe('notarium-id:durable-id|Target')
  })

  it('rejects a self-link revealed only after provisional id reconciliation', async () => {
    await expect(
      resolveLinkTitle(context({ id: 'durable-id', title: 'Target' }), {
        fromId: 'durable-id',
        fromSpace: 'main',
        relation: 'links_to',
        to: 'provisional-id',
      }),
    ).rejects.toThrow(/cannot be linked to itself/i)
  })
})
