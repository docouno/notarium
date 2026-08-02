import { describe, expect, it } from 'vitest'

import { dirSelected, folderShown, toggleFolder } from './selectedFolders'

describe('dirSelected', () => {
  it('a folder is selected by itself or any ancestor (subtree cascade)', () => {
    const s = new Set(['projects'])
    expect(dirSelected(s, 'projects')).toBe(true)
    expect(dirSelected(s, 'projects/web')).toBe(true) // via ancestor
    expect(dirSelected(s, 'archive')).toBe(false)
  })
  it('an empty set selects nothing; root ("") is never under a folder', () => {
    expect(dirSelected(new Set(), 'projects')).toBe(false)
    expect(dirSelected(new Set(['projects']), '')).toBe(false)
  })
})

describe('folderShown', () => {
  it('empty selection = no filter (everything shown)', () => {
    expect(folderShown(new Set(), 'projects')).toBe(true)
    expect(folderShown(new Set(), '')).toBe(true)
  })
  it('with a selection, only notes under a selected subtree show', () => {
    const s = new Set(['projects/web'])
    expect(folderShown(s, 'projects/web')).toBe(true)
    expect(folderShown(s, 'projects/web/deep')).toBe(true) // descendant
    expect(folderShown(s, 'projects/api')).toBe(false) // sibling, not selected
    expect(folderShown(s, '')).toBe(false) // a root note is under no folder
  })
})

describe('toggleFolder', () => {
  it('a click adds the path; toggling again removes it', () => {
    const a = toggleFolder(new Set(), 'projects')
    expect([...a]).toEqual(['projects'])
    const b = toggleFolder(a, 'projects')
    expect(b.size).toBe(0)
  })
  it('selecting two folders unions them (OR)', () => {
    const s = toggleFolder(toggleFolder(new Set(), 'projects'), 'archive')
    expect([...s].sort()).toEqual(['archive', 'projects'])
    expect(folderShown(s, 'projects/web')).toBe(true)
    expect(folderShown(s, 'archive/2020')).toBe(true)
  })
  it('does not mutate the input set', () => {
    const input = new Set(['archive'])
    toggleFolder(input, 'projects')
    expect([...input]).toEqual(['archive'])
  })
})
