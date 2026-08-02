import { describe, expect, it } from 'vitest'
import {
  buildFolderTree,
  buildTree,
  folderOf,
  type FolderTreeNode,
  listFolders,
} from '../../packages/web/src/libs/tree/tree'

// A minimal note record (the tree builders read filePath/permalink/title only;
// `id` rides along because the domain note carries one since #51).
const note = (filePath: string, title?: string) => ({
  id: `fake-${filePath}`,
  filePath,
  title: title ?? '',
  modifiedAt: null,
  createdAt: null,
})

describe('folderOf', () => {
  it('returns the directory part, or "" for a root note', () => {
    expect(folderOf('a/b/c.md')).toBe('a/b')
    expect(folderOf('root.md')).toBe('')
    expect(folderOf('')).toBe('')
  })
})

describe('buildFolderTree', () => {
  it('counts every ancestor over the whole subtree', () => {
    const tree = buildFolderTree([
      note('demo/a.md'),
      note('demo/sub/b.md'),
      note('demo/sub/c.md'),
      note('root.md'), // root note → not a folder node
    ])
    expect(tree).toHaveLength(1)
    const demo = tree[0]
    expect(demo).toMatchObject({ name: 'demo', path: 'demo', count: 3 })
    expect(demo.children).toHaveLength(1)
    expect(demo.children[0]).toMatchObject({ name: 'sub', path: 'demo/sub', count: 2 })
  })

  it('sorts siblings case-insensitively', () => {
    const tree = buildFolderTree([note('Beta/x.md'), note('alpha/y.md')])
    expect(tree.map((n: { name: string }) => n.name)).toEqual(['alpha', 'Beta'])
  })
})

describe('listFolders', () => {
  it('returns every distinct ancestor directory, sorted, root excluded', () => {
    const folders = listFolders([note('projects/2026/q1/plan.md'), note('top.md')])
    expect(folders).toEqual(['projects', 'projects/2026', 'projects/2026/q1'])
  })
})

describe('buildTree', () => {
  it('nests notes under folders and lists folders before notes', () => {
    const root = buildTree([note('demo/b.md', 'B'), note('a.md', 'A'), note('demo/sub/c.md', 'C')])
    // folder "demo" sorts before the root-level note "A"
    expect(root.list!.map((n) => `${n.type}:${n.name}`)).toEqual(['folder:demo', 'note:A'])
    const demo = root.list![0] as FolderTreeNode
    expect(demo.list!.map((n) => `${n.type}:${n.name}`)).toEqual(['folder:sub', 'note:B'])
  })

  it('derives a note name from the filename when title is absent', () => {
    const root = buildTree([note('My Note.md')])
    expect(root.list![0]).toMatchObject({ type: 'note', name: 'My Note', fileName: 'My Note.md' })
  })
})
