import { describe, expect, it, vi } from 'vitest'

import { canonicalVisibleFavoriteNoteId } from './favorites'

describe('canonicalVisibleFavoriteNoteId', () => {
  it('follows a submitted provisional id after list has already re-keyed to durable', async () => {
    const store = {
      read: vi.fn().mockResolvedValue({ id: 'durable-id', content: '', frontmatter: {} }),
      list: vi.fn().mockResolvedValue([
        {
          id: 'durable-id',
          title: 'Target',
          filePath: 'target.md',
          modifiedAt: null,
          createdAt: null,
        },
      ]),
    }

    await expect(canonicalVisibleFavoriteNoteId(store, 'provisional-id')).resolves.toBe(
      'durable-id',
    )
    expect(store.read).toHaveBeenCalledWith('provisional-id')
  })

  it('does not admit a direct-readable note absent from the user list', async () => {
    const store = {
      read: vi.fn().mockResolvedValue({ id: 'hidden-id', content: '', frontmatter: {} }),
      list: vi.fn().mockResolvedValue([]),
    }

    await expect(canonicalVisibleFavoriteNoteId(store, 'hidden-id')).resolves.toBeNull()
  })
})
