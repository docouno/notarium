import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  abilityDraftOwner,
  type AbilityDraftRecord,
  clearAbilityDrafts,
  readAbilityDraft,
  removeAbilityDraft,
  writeAbilityDraft,
} from './abilityDraftStorage'

class MemorySessionStorage implements Storage {
  private readonly values = new Map<string, string>()

  get length() {
    return this.values.size
  }

  clear() {
    this.values.clear()
  }

  getItem(key: string) {
    return this.values.get(key) ?? null
  }

  key(index: number) {
    return [...this.values.keys()][index] ?? null
  }

  removeItem(key: string) {
    this.values.delete(key)
  }

  setItem(key: string, value: string) {
    this.values.set(key, value)
  }
}

const record = (owner: string, draftId: string): AbilityDraftRecord => ({
  version: 1,
  owner,
  draftId,
  kind: 'role',
  createdAt: '2026-08-16T12:00:00.000Z',
  updatedAt: '2026-08-16T12:01:00.000Z',
  authoredDraft: {
    name: 'release-captain',
    description: 'Coordinates a release.',
    instructions: 'Verify the evidence.',
    attachments: [],
  },
  creationSettings: {
    home: 'personal',
    space: 'team',
    availability: 'all-projects',
    projects: [],
  },
})

describe('ability draft session storage', () => {
  let storage: MemorySessionStorage

  beforeEach(() => {
    storage = new MemorySessionStorage()
    Object.defineProperty(globalThis, 'sessionStorage', {
      value: storage,
      configurable: true,
    })
  })

  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'sessionStorage')
  })

  it('round-trips the exact owner, draft id, and kind only', () => {
    writeAbilityDraft(record('alice', 'draft-a'))

    expect(readAbilityDraft('alice', 'draft-a', 'role')).toEqual(record('alice', 'draft-a'))
    expect(readAbilityDraft('alice', 'draft-a', 'skill')).toBeNull()
    expect(readAbilityDraft('alice', 'draft-a', 'role')).toBeNull()
  })

  it('rejects a record whose placement is no longer expressible', () => {
    storage.setItem(
      'notarium:ability-draft:alice:draft-a',
      JSON.stringify({
        ...record('alice', 'draft-a'),
        creationSettings: {
          home: 'project',
          space: 'team',
          availability: 'selected-projects',
          projects: ['project-a'],
        },
      }),
    )

    expect(readAbilityDraft('alice', 'draft-a', 'role')).toBeNull()
    expect(storage.length).toBe(0)
  })

  it('fails closed and removes a payload stored under another owner', () => {
    storage.setItem(
      'notarium:ability-draft:bob:draft-a',
      JSON.stringify(record('alice', 'draft-a')),
    )

    expect(readAbilityDraft('bob', 'draft-a', 'role')).toBeNull()
    expect(storage.length).toBe(0)
  })

  it('fails closed on a non-executable Catalog attachment', () => {
    const invalid = record('alice', 'draft-a')
    storage.setItem(
      'notarium:ability-draft:alice:draft-a',
      JSON.stringify({
        ...invalid,
        authoredDraft: {
          ...invalid.authoredDraft,
          attachments: [
            {
              kind: 'exact',
              locator: { source: 'catalog', kind: 'skill', packageId: 'catalog-skill' },
              label: 'catalog-skill',
            },
          ],
        },
      }),
    )

    expect(readAbilityDraft('alice', 'draft-a', 'role')).toBeNull()
    expect(storage.length).toBe(0)
  })

  it('clears only the requested owner and supports explicit removal after publish', () => {
    writeAbilityDraft(record('alice', 'draft-a'))
    writeAbilityDraft(record('alice', 'draft-b'))
    writeAbilityDraft(record('bob', 'draft-a'))

    removeAbilityDraft('alice', 'draft-a')
    expect(readAbilityDraft('alice', 'draft-a', 'role')).toBeNull()
    expect(readAbilityDraft('alice', 'draft-b', 'role')).not.toBeNull()

    clearAbilityDrafts('alice')
    expect(readAbilityDraft('alice', 'draft-b', 'role')).toBeNull()
    expect(readAbilityDraft('bob', 'draft-a', 'role')).not.toBeNull()
  })

  // The writer and the cleaner must name the same namespace. They drifted apart once —
  // one moved to the stable id while the other kept the handle — and the drift was
  // silent: a rename lost the draft, and the cleaner scanned a prefix nobody wrote to.
  it('names the namespace by the stable account id, so a rename neither loses nor leaks a draft', () => {
    expect(abilityDraftOwner('password', 'a1b2c3d4e5f60718')).toBe('a1b2c3d4e5f60718')
    expect(abilityDraftOwner('none', 'a1b2c3d4e5f60718')).toBe('@system')
    expect(abilityDraftOwner('password', null)).toBeNull()
    expect(abilityDraftOwner(undefined, undefined)).toBeNull()

    const owner = abilityDraftOwner('password', 'a1b2c3d4e5f60718') as string
    writeAbilityDraft(record(owner, 'draft-a'))
    // The handle the account happens to wear today addresses nothing.
    expect(readAbilityDraft('alice', 'draft-a', 'role')).toBeNull()
    expect(readAbilityDraft(owner, 'draft-a', 'role')).not.toBeNull()
    clearAbilityDrafts(owner)
    expect(readAbilityDraft(owner, 'draft-a', 'role')).toBeNull()
  })
})
