import { beforeEach, describe, expect, it } from 'vitest'
import {
  loadRecentNotes,
  pushRecentNote,
} from '../../packages/web/src/libs/recentNotes/recentNotes'

// Recently-opened MRU (#31) — the Spotlight's empty-state list. Pure localStorage
// logic: dedup-by-id, MRU order, per-space keying, cap, and best-effort tolerance
// of a blocked/garbage store. Node has no localStorage, so a Map-backed stub stands
// in (the module only touches get/setItem).

beforeEach(() => {
  const store = new Map<string, string>()
  globalThis.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  } as Storage
})

const note = (id: string, title = id) => ({
  kind: 'note' as const,
  id,
  title,
  filePath: `${id}.md`,
})

describe('recentNotes MRU', () => {
  it('loads what was pushed', () => {
    pushRecentNote('main', note('a', 'Alpha'))
    expect(loadRecentNotes('main')).toEqual([
      {
        kind: 'note',
        id: 'a',
        title: 'Alpha',
        filePath: 'a.md',
        modifiedAt: null,
        createdAt: null,
      },
    ])
  })

  it('orders most-recent first and dedups by id', () => {
    pushRecentNote('main', note('a'))
    pushRecentNote('main', note('b'))
    pushRecentNote('main', note('a')) // re-open promotes, no duplicate
    expect(loadRecentNotes('main').map((n) => n.id)).toEqual(['a', 'b'])
  })

  it('keys recents per space — never crosses the boundary', () => {
    pushRecentNote('main', note('a'))
    pushRecentNote('other', note('z'))
    expect(loadRecentNotes('main').map((n) => n.id)).toEqual(['a'])
    expect(loadRecentNotes('other').map((n) => n.id)).toEqual(['z'])
  })

  it('caps the list at 30', () => {
    for (let i = 0; i < 40; i++) {
      pushRecentNote('main', note(`n${i}`))
    }
    const list = loadRecentNotes('main')
    expect(list).toHaveLength(30)
    expect(list[0].id).toBe('n39') // newest first
  })

  it('keeps the display slug for canonical-URL routing', () => {
    pushRecentNote('main', {
      kind: 'note',
      id: 'a',
      title: 'Alpha',
      slug: 'custom-slug',
      filePath: 'a.md',
    })
    expect(loadRecentNotes('main')[0]).toEqual({
      id: 'a',
      kind: 'note',
      title: 'Alpha',
      slug: 'custom-slug',
      filePath: 'a.md',
      modifiedAt: null,
      createdAt: null,
    })
  })

  it('keeps stored date hints', () => {
    pushRecentNote('main', {
      kind: 'note',
      id: 'a',
      title: 'Alpha',
      filePath: 'a.md',
      modifiedAt: '2026-06-08T00:00:00.000Z',
      createdAt: '2026-06-01T09:00:00.000Z',
    })
    expect(loadRecentNotes('main')[0]).toEqual({
      kind: 'note',
      id: 'a',
      title: 'Alpha',
      filePath: 'a.md',
      modifiedAt: '2026-06-08T00:00:00.000Z',
      createdAt: '2026-06-01T09:00:00.000Z',
    })
  })

  it('is a no-op for an empty space or id', () => {
    pushRecentNote('', note('a'))
    pushRecentNote('main', note(''))
    expect(loadRecentNotes('main')).toEqual([])
  })

  it('tolerates a malformed store', () => {
    localStorage.setItem('notarium.recentNotes:main', '{not json')
    expect(loadRecentNotes('main')).toEqual([])
    localStorage.setItem('notarium.recentNotes:main', '{"not":"an array"}')
    expect(loadRecentNotes('main')).toEqual([])
  })

  it('adopts an unversioned legacy store as the generic notes it can only hold', () => {
    localStorage.setItem(
      'notarium.recentNotes:main',
      JSON.stringify([{ id: 'a', title: 'Alpha', filePath: 'a.md' }]),
    )
    // A bare array predates Abilities in the ring, so every row in it is a generic
    // note and `/n/<id>` still addresses it. Adopting costs nothing; dropping would
    // cost the user their whole MRU.
    expect(loadRecentNotes('main')).toEqual([
      {
        kind: 'note',
        id: 'a',
        title: 'Alpha',
        filePath: 'a.md',
        modifiedAt: null,
        createdAt: null,
      },
    ])
  })

  it('drops a versioned store this generation cannot read', () => {
    localStorage.setItem(
      'notarium.recentNotes:main',
      JSON.stringify({ version: 1, items: [{ id: 'a', title: 'Alpha', filePath: 'a.md' }] }),
    )
    expect(loadRecentNotes('main')).toEqual([])
  })

  it('keeps an Owned Ability exact route in the versioned MRU', () => {
    pushRecentNote('main', {
      kind: 'owned-ability',
      id: 'ability-note',
      title: 'Research',
      href: '/agents/abilities/roles/owned/exact',
    })
    expect(loadRecentNotes('main')[0]).toMatchObject({
      kind: 'owned-ability',
      href: '/agents/abilities/roles/owned/exact',
    })
  })
})
