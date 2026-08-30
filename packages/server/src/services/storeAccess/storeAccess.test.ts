import { describe, expect, it, vi } from 'vitest'
import { NOTE_CLASS } from '@notarium/contract'
import { noteNotFound } from '@notarium/core'

import type { Principal } from '../authz'
import { curatePersonalScope } from '../spaces'
import {
  canonicalMetaNoteAccess,
  canonicalMetaNoteAccessMany,
  createStoreAccess,
  readNoteAccess,
  type StoreAccess,
  weighScopeContextSets,
  weighScopePins,
} from './storeAccess'

const principal = { id: 'system', system: true } as Principal

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

  it('collapses only a typed store not-found to the anti-enumeration miss', async () => {
    const access = {
      noteStore: vi.fn().mockResolvedValue({
        space: 'main',
        store: { read: vi.fn().mockRejectedValue(noteNotFound('gone')) },
      }),
    } as unknown as StoreAccess

    await expect(readNoteAccess(access, principal, 'gone', 'note:read')).resolves.toBeNull()
  })

  it('preserves an operational store read failure', async () => {
    const failure = new Error('sqlite read failed at /private/meta.db')
    const access = {
      noteStore: vi.fn().mockResolvedValue({
        space: 'main',
        store: { read: vi.fn().mockRejectedValue(failure) },
      }),
    } as unknown as StoreAccess

    await expect(readNoteAccess(access, principal, 'live', 'note:read')).rejects.toBe(failure)
  })
})

describe('canonicalMetaNoteAccess', () => {
  it('uses a bounded read only for a retired id with a live successor', async () => {
    const read = vi.fn().mockResolvedValue({
      id: 'durable-id',
      title: 'Target',
      filePath: 'target.md',
      content: 'body',
      frontmatter: {},
    })
    const access = {
      noteStore: vi.fn().mockResolvedValue({
        space: 'main',
        noteId: 'retired-id',
        deletedAt: '2026-08-30T00:00:00.000Z',
        store: { read },
      }),
    } as unknown as StoreAccess

    await expect(
      canonicalMetaNoteAccess(access, principal, 'retired-id', 'note:read'),
    ).resolves.toMatchObject({ noteId: 'durable-id', space: 'main' })
    expect(read).toHaveBeenCalledOnce()
  })

  it('degrades an archived identity whose store is not live to an access miss', async () => {
    const unavailable = Object.assign(new Error('space not found'), { isNotFound: true })
    const access = createStoreAccess({
      resolveNote: vi.fn().mockResolvedValue({
        id: 'archived-note',
        space: 'archived',
        filePath: 'note.md',
        deletedAt: null,
      }),
      store: vi.fn().mockRejectedValue(unavailable),
    } as never)

    await expect(access.noteStore(principal, 'archived-note', 'note:read')).resolves.toBeNull()
  })
})

describe('canonicalMetaNoteAccessMany', () => {
  it('uses one exact batch and pays a body read only for a tombstone', async () => {
    const successorRead = vi.fn().mockResolvedValue({
      id: 'successor',
      title: 'Successor',
      filePath: 'successor.md',
      content: 'body',
      frontmatter: {},
    })
    const liveStore = { read: vi.fn() }
    const retiredStore = { read: successorRead }
    const noteStore = vi.fn().mockImplementation(async (_principal, id) =>
      id === 'retired'
        ? {
            space: 'main',
            noteId: 'retired',
            deletedAt: '2026-08-30T00:00:00.000Z',
            store: retiredStore,
          }
        : null,
    )
    const noteStores = vi.fn().mockResolvedValue(
      new Map([
        ['live', { space: 'main', noteId: 'live', deletedAt: null, store: liveStore }],
        [
          'retired',
          {
            space: 'main',
            noteId: 'retired',
            deletedAt: '2026-08-30T00:00:00.000Z',
            store: retiredStore,
          },
        ],
      ]),
    )
    const access = { noteStore, noteStores } as unknown as StoreAccess
    const result = await canonicalMetaNoteAccessMany(
      access,
      principal,
      ['live', 'retired'],
      'note:read',
    )

    expect(noteStores).toHaveBeenCalledOnce()
    expect(result.get('live')).toMatchObject({ noteId: 'live' })
    expect(result.get('retired')).toMatchObject({ noteId: 'successor' })
    expect(successorRead).toHaveBeenCalledOnce()
  })
})

describe('scope note class policy', () => {
  const deps = (noteClassAllowed?: (noteClass: string | undefined) => boolean) => {
    const read = vi.fn().mockResolvedValue({
      id: 'skill-note',
      title: 'Packaged instructions',
      filePath: '.notarium/skills/skill-note/SKILL.md',
      content: '# Packaged instructions\n\nDo the thing.',
      frontmatter: {},
      class: NOTE_CLASS.skill,
    })
    const store = {
      noteStore: vi.fn().mockResolvedValue({ space: 'personal-id', store: { read } }),
    } as unknown as StoreAccess

    return {
      store,
      spaces: { slugOf: vi.fn().mockReturnValue('personal') },
      scopePins: {
        pinsForTarget: vi.fn().mockResolvedValue([
          {
            targetKind: 'personal',
            targetId: 'personal-id',
            targetSpace: 'personal-id',
            noteSpace: 'personal-id',
            noteId: 'skill-note',
            createdAt: '2026-08-22T00:00:00.000Z',
          },
        ]),
      },
      contextSets: {
        setsForTarget: vi.fn().mockResolvedValue([
          {
            id: 'set-1',
            homeSpace: 'personal-id',
            name: 'Mixed context',
            items: [{ space: 'personal-id', noteId: 'skill-note' }],
            createdAt: '2026-08-22T00:00:00.000Z',
          },
        ]),
      },
      ...(noteClassAllowed ? { noteClassAllowed } : {}),
    } as unknown as Parameters<typeof weighScopePins>[0]
  }

  it('keeps the shared REST projection unchanged when no class policy is supplied', async () => {
    const target = { kind: 'personal' as const, id: 'personal-id' }

    await expect(weighScopePins(deps(), principal, target)).resolves.toHaveLength(1)
    await expect(weighScopeContextSets(deps(), principal, target)).resolves.toMatchObject([
      { id: 'set-1', items: [{ noteId: 'skill-note' }] },
    ])
  })

  it('defers set class filtering until the bounded curation resolve', async () => {
    const target = { kind: 'personal' as const, id: 'personal-id' }
    const filtered = deps((noteClass) => noteClass !== NOTE_CLASS.skill)

    await expect(weighScopePins(filtered, principal, target)).resolves.toEqual([])
    const sets = await weighScopeContextSets(filtered, principal, target)
    const curated = await curatePersonalScope([], sets, [], 10_000)

    expect(curated.sets).toMatchObject([{ id: 'set-1', items: [], itemsLoaded: 0 }])
  })

  it('hands raw membership to the lazy curator without cloning its unbounded tail', async () => {
    let materialized = 0
    const items = Array.from({ length: 1_000 }, (_, index) => {
      const noteId = `note-${index}`

      return Object.defineProperty({ space: 'personal-id' }, 'noteId', {
        enumerable: true,
        get: () => {
          materialized += 1
          return noteId
        },
      }) as { noteId: string; space: string }
    })
    const input = deps()
    vi.mocked(input.contextSets!.setsForTarget).mockResolvedValue([
      {
        id: 'set-large',
        homeSpace: 'personal-id',
        name: 'Large',
        items,
        createdAt: '2026-08-22T00:00:00.000Z',
      },
    ])
    const sets = await weighScopeContextSets(input, principal, {
      kind: 'personal',
      id: 'personal-id',
    })

    expect(materialized).toBe(0)
    await curatePersonalScope([], sets, [], 10_000)
    expect(materialized).toBe(250)
  })
})
