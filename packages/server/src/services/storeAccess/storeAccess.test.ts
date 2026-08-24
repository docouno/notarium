import { describe, expect, it, vi } from 'vitest'
import { NOTE_CLASS } from '@notarium/contract'
import { noteNotFound } from '@notarium/core'

import type { Principal } from '../authz'
import {
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

  it('drops only a disallowed resolved item from pins and context sets', async () => {
    const target = { kind: 'personal' as const, id: 'personal-id' }
    const filtered = deps((noteClass) => noteClass !== NOTE_CLASS.skill)

    await expect(weighScopePins(filtered, principal, target)).resolves.toEqual([])
    await expect(weighScopeContextSets(filtered, principal, target)).resolves.toMatchObject([
      { id: 'set-1', items: [] },
    ])
  })
})
