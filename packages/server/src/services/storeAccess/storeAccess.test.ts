import { describe, expect, it, vi } from 'vitest'

import type { Principal } from '../authz'
import { readNoteAccess, type StoreAccess } from './storeAccess'

const principal = { id: 'user:alice' } as Principal

describe('readNoteAccess', () => {
  it('returns the authoritative id from the live read, not the caller provisional id', async () => {
    const read = vi.fn().mockResolvedValue({
      id: 'durable-id',
      title: 'Target',
      filePath: 'target.md',
      content: 'body',
      frontmatter: {},
    })
    const access = {
      noteStore: vi.fn().mockResolvedValue({ space: 'main', store: { read } }),
    } as unknown as StoreAccess

    await expect(
      readNoteAccess(access, principal, 'provisional-id', 'note:read'),
    ).resolves.toMatchObject({ space: 'main', noteId: 'durable-id' })
    expect(read).toHaveBeenCalledWith('provisional-id')
  })

  it('collapses a tombstone to the same anti-enumeration miss', async () => {
    const access = {
      noteStore: vi.fn().mockResolvedValue({
        space: 'main',
        store: {
          read: vi.fn().mockResolvedValue({ content: '', frontmatter: {}, deleted: true }),
        },
      }),
    } as unknown as StoreAccess

    await expect(readNoteAccess(access, principal, 'gone', 'note:read')).resolves.toBeNull()
  })
})
