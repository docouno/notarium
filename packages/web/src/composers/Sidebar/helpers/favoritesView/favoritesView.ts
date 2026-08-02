import type { FavoriteItem } from '@notarium/contract'
import type { SkeletonNode } from '../../../../libs/tree/tree'
import { noteView, type NoteView } from '../../../../libs/wire'
import { dirOfPath, noteSort, pathInside } from '../paths'

export const favoriteBranchPaths = (items: readonly FavoriteItem[]): string[] =>
  items.flatMap((item) => {
    if (item.kind === 'folder') {
      return [item.folder.path]
    }
    if (item.kind === 'project') {
      return [item.project.path]
    }

    return []
  })

export const favoriteNoteFolders = (items: readonly FavoriteItem[]): Map<string, NoteView[]> => {
  const map = new Map<string, NoteView[]>()

  for (const item of items) {
    if (item.kind !== 'note') {
      continue
    }
    const n = noteView(item.note)
    const folder = dirOfPath(n.filePath)
    map.set(folder, [...(map.get(folder) ?? []), n])
  }
  for (const [folder, notes] of map) {
    map.set(folder, notes.sort(noteSort))
  }

  return map
}

export const favoriteTreeView = (
  roots: readonly SkeletonNode[],
  rootCount: number,
  branchPaths: readonly string[],
  noteFolders: ReadonlyMap<string, readonly NoteView[]>,
): { roots: SkeletonNode[]; rootCount: number; rootFolder: string } => {
  const fullRoot = branchPaths.includes('')

  if (fullRoot) {
    return { roots: [...roots], rootCount, rootFolder: '' }
  }

  const hasFavoriteBelow = (path: string) =>
    branchPaths.some((p) => p !== '' && pathInside(p, path)) ||
    [...noteFolders.keys()].some((folder) => folder !== '' && pathInside(folder, path))

  const fullBranchAt = (path: string) => branchPaths.some((p) => p !== '' && pathInside(path, p))

  const clone = (node: SkeletonNode): SkeletonNode | null => {
    if (fullBranchAt(node.path)) {
      return node
    }
    if (!hasFavoriteBelow(node.path)) {
      return null
    }
    const children = node.children.map(clone).filter((n): n is SkeletonNode => Boolean(n))
    const direct = noteFolders.get(node.path)?.length ?? 0
    return {
      ...node,
      direct,
      count: direct + children.reduce((sum, child) => sum + child.count, 0),
      children,
    }
  }

  return {
    roots: roots.map(clone).filter((n): n is SkeletonNode => Boolean(n)),
    rootCount: noteFolders.get('')?.length ?? 0,
    rootFolder: '',
  }
}
