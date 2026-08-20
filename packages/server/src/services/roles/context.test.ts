import { describe, expect, it, vi } from 'vitest'

// The exact storage-address form of a note id belongs to core. This test replaces core's
// answer and re-asks the parser: a target whose package id core now accepts must parse,
// and one it now rejects must not. Both hold only while the parser ASKS — a second copy
// of the shape here keeps answering by the old rule and turns every real target label
// "undescribed" the day the id form changes, with nothing else going red.
vi.mock('@notarium/core', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isGeneratedNoteId: (value: string) => value.startsWith('pkg-'),
}))

describe('parseRoleContextTarget', () => {
  it('takes the generated-note-id shape from core', async () => {
    const { parseRoleContextTarget } = await import('./context')

    expect(parseRoleContextTarget('personal:user-alice:pkg-1')).toEqual({
      scope: 'personal',
      ownerId: 'user-alice',
      packageId: 'pkg-1',
    })
    expect(parseRoleContextTarget('personal:user-alice:AbCdefGhij_1')).toBeNull()
  })
})
