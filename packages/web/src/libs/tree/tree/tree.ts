import { resolveFolderReference } from '@notarium/core'
import { namePathKey } from '@notarium/core/slug'

import type { NoteView, TreeFolder } from '../../wire'

// The minimum a note-like record needs for path-based grouping: where it lives.
// Loose on purpose so both Feed notes and graph nodes (which carry filePath but
// not the full note shape) feed the folder builders.
type PathLike = { filePath?: string | null }

// A folder facet node with its subtree note count — the shape buildFolderTree
// produces and the shared FolderTree widget (Feed scope + Graph filter) renders.
export type FolderNode = { name: string; path: string; count: number; children: FolderNode[] }

// The Sidebar's explorer tree: folders nest notes, sorted folders-first. `list` is
// the sorted children array sortNode bakes onto each folder for rendering (the
// `children` Map is the build-time accumulator).
export type FolderTreeNode = {
  type: 'folder'
  name: string
  path: string
  children: Map<string, TreeNode>
  list?: TreeNode[]
}
export type NoteTreeNode = {
  type: 'note'
  name: string
  fileName: string
  note: NoteView
}
export type TreeNode = FolderTreeNode | NoteTreeNode

// The directory part of a note path ('' for a root-level note).
export const folderOf = (p: string | null | undefined): string => {
  const i = (p || '').lastIndexOf('/')
  return i === -1 ? '' : (p as string).slice(0, i)
}

// Join a parent folder and a child segment into a full path ('' parent = root,
// so the segment stands alone). The single source of truth for "where a renamed
// or moved item lands": the move actions relocate it here, and the tree's openSet
// carry must predict the SAME destination — else the expansion lands on a path
// the skeleton never grows, and self-heal collapses it.
export const joinPath = (parent: string, segment: string): string =>
  parent ? `${parent}/${segment}` : segment

// Re-key a set of expanded folder paths across a rename/move. A folder carries no
// id — its PATH is its identity — so when the path changes, its (and its expanded
// descendants') openSet keys must follow, or the relocated folder reads as
// collapsed. Returns a set with the new keys added and the OLD ones KEPT (so
// nothing collapses mid-relocate, before the server skeleton lands; the stale old
// keys are swept later by the tree's self-heal). The `oldPath + '/'` boundary is
// per-segment, so moving `demo` never disturbs a sibling `demo2`. Returns the SAME
// set reference when nothing matched, so a no-op skips a render.
export const carryOpenKeys = (open: Set<string>, oldPath: string, newPath: string): Set<string> => {
  if (newPath === oldPath) {
    return open
  }
  let changed = false
  const next = new Set(open)

  for (const p of open) {
    if (p === oldPath) {
      next.add(newPath)
      changed = true
    } else if (p.startsWith(oldPath + '/')) {
      next.add(newPath + p.slice(oldPath.length))
      changed = true
    }
  }

  return changed ? next : open
}

// The current path a stale (aliased) folder URL should redirect to (#100 phase 3), or
// null when `reqPath` is already a live folder or unknown. A folder rename keeps
// the folder-id; the server's /tree carries PAST paths (`aliases`) for moved
// identified folders/projects, so a bookmark to `/files/<oldpath>` canonicalises
// to the current path here — the folder twin of the note's stale-slug redirect. Prefix-aware: a
// descendant of an old path (`a/sub` after `a`→`b`) redirects to `b/sub`.
//
// Matching is in NAME-KEY space, not slug space: `namePathKey` is the key the producing
// half uses (`nextPathAliases`) and the key every other consumer of this same history
// uses — the graph's folder-alias pass, the engine's `resolveRow`, the reader's
// `resolveWiki`. On `slugifyPath` this surface dropped exactly the aliases the others
// keep: a folder named `📥` IS retired into the history, `[[📥/note]]` resolves
// everywhere, and only a bookmark to `/files/📥` fell through to a 404 (#296).
// Folder paths are stored RAW on disk, so a matched key is mapped back to a real path.
export const canonicalFolderPath = (
  reqPath: string,
  folders: readonly TreeFolder[],
): string | null => {
  const currentPaths = folders.map((folder) => folder.path)
  const aliases = folders.flatMap((folder) =>
    (folder.aliases ?? []).map((alias) => ({ current: folder.path, alias })),
  )
  const resolved = resolveFolderReference(reqPath, aliases, currentPaths)

  if (resolved == null || resolved === reqPath) {
    return null
  }

  // The shared resolver returns the desired current subtree even when that
  // descendant no longer exists. A URL must land on a real folder, so walk back
  // to the longest unique current ancestor. Ambiguous descendants fall back to a
  // unique parent instead of becoming input-order dependent.
  const parts = resolved.split('/')

  for (let length = parts.length; length > 0; length--) {
    const prefix = parts.slice(0, length).join('/')

    if (currentPaths.includes(prefix)) {
      return prefix
    }
    const key = namePathKey(prefix)
    const matches = currentPaths.filter((path) => namePathKey(path) === key)

    if (matches.length === 1) {
      return matches[0]
    }
  }

  return null
}

// Nested folder facets with subtree note counts, shared by the Feed scope tree
// and the Graph visibility filter (one builder → one data shape → one FolderTree).
// Every ancestor directory of a note counts that note, so a parent's count equals
// the notes under its whole subtree (matching the prefix filter both callers
// apply). Root-level notes (no folder) aren't a node here. Each node is
// { name, path, count, children: [] }.
export const buildFolderTree = (notes: readonly PathLike[]): FolderNode[] => {
  type RawNode = { name: string; path: string; count: number; children: Map<string, RawNode> }
  const counts = new Map<string, number>() // dir path -> subtree note count

  for (const n of notes) {
    const dir = folderOf(n.filePath)

    if (!dir) {
      continue
    }
    let acc = ''

    for (const part of dir.split('/')) {
      acc = acc ? `${acc}/${part}` : part
      counts.set(acc, (counts.get(acc) || 0) + 1)
    }
  }
  const roots = new Map<string, RawNode>()

  for (const path of counts.keys()) {
    let map = roots
    let acc = ''

    for (const part of path.split('/')) {
      acc = acc ? `${acc}/${part}` : part
      if (!map.has(part)) {
        map.set(part, { name: part, path: acc, count: counts.get(acc) || 0, children: new Map() })
      }
      map = map.get(part)!.children
    }
  }
  const toArr = (map: Map<string, RawNode>): FolderNode[] =>
    [...map.values()]
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
      .map((n) => ({ name: n.name, path: n.path, count: n.count, children: toArr(n.children) }))
  return toArr(roots)
}

// VS Code-style "reveal the single chain" expansion for a folder tree (#98 item 3):
// starting at the top, while a level holds EXACTLY ONE folder that has children,
// open it and descend into it; stop the moment a level branches (>1 folder) or
// the lone folder is a leaf. Returns the paths to open. A branching or empty top
// level opens nothing — everything starts collapsed, the way VS Code reveals a
// deeply-nested single path but leaves a wide first level folded. Generic over
// any { path, children } node so the Feed/Memory facet trees can share it.
export const singleChainOpen = <T extends { path: string; children: readonly T[] }>(
  nodes: readonly T[],
): string[] => {
  const open: string[] = []
  let level = nodes

  while (level.length === 1 && level[0].children.length > 0) {
    open.push(level[0].path)
    level = level[0].children
  }

  return open
}

// The /api/tree skeleton (#64) nested into the same FolderNode shape
// buildFolderTree produces — so the Feed facet and the Sidebar render the
// server-counted skeleton through the very same components that used to eat
// the full note list. `direct` (notes immediately inside) rides along for the
// sidebar's lazy expand decision.
export type SkeletonNode = {
  id?: string
  name: string
  path: string
  count: number
  direct: number
  children: SkeletonNode[]
}

export const nestFolders = (folders: readonly TreeFolder[]): SkeletonNode[] => {
  const nodes = new Map<string, SkeletonNode>()
  const roots: SkeletonNode[] = []

  // Server sends paths sorted, so a parent always precedes its children.
  for (const f of folders) {
    const node: SkeletonNode = {
      id: f.id,
      name: f.name,
      path: f.path,
      count: f.count,
      direct: f.direct,
      children: [],
    }
    nodes.set(f.path, node)
    const parent = nodes.get(folderOf(f.path))

    if (parent) {
      parent.children.push(node)
    } else {
      roots.push(node)
    }
  }
  const sortRec = (arr: SkeletonNode[]): SkeletonNode[] => {
    arr.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
    for (const n of arr) {
      sortRec(n.children)
    }

    return arr
  }

  return sortRec(roots)
}

// #97: `withProjectFolders` (the client-side injection of marked-but-empty
// project folders) is RETIRED. The tree skeleton is now server-authoritative —
// the /tree endpoint unions the engine's directory channel + the project
// registry (treeSummary), so empty projects and "New folder"s arrive in the
// skeleton itself. One channel, no client synthesis (which is what removed the
// dup-on-rename race, #13/item 2).

// Build a nested folder tree out of the flat notes list (keyed on filePath).

export const buildTree = (notes: readonly NoteView[]): FolderTreeNode => {
  const root: FolderTreeNode = { type: 'folder', name: '', path: '', children: new Map() }

  for (const note of notes) {
    const path = note.filePath || note.title

    if (!path) {
      continue
    }
    const parts = path.split('/').filter(Boolean)
    const fileName = parts.pop() || ''
    let node = root
    let acc = ''

    for (const part of parts) {
      acc = acc ? `${acc}/${part}` : part
      if (!node.children.has(part)) {
        node.children.set(part, { type: 'folder', name: part, path: acc, children: new Map() })
      }
      node = node.children.get(part) as FolderTreeNode
    }
    node.children.set(`📄${fileName}`, {
      type: 'note',
      name: note.title || fileName.replace(/\.md$/, ''),
      fileName,
      note,
    })
  }

  return sortNode(root) as FolderTreeNode
}

// Distinct folder paths across all notes, sorted alphabetically. Powers the
// editor's folder picker: every ancestor directory of a note's filePath is a
// real, selectable folder (e.g. "projects/2026/q1" yields "projects",
// "projects/2026", "projects/2026/q1"). Root ('') is left out — callers add it.
export const listFolders = (notes: readonly PathLike[]): string[] => {
  const set = new Set<string>()

  for (const note of notes) {
    const path = note.filePath || ''
    const parts = path.split('/').filter(Boolean)
    parts.pop() // drop the filename
    let acc = ''

    for (const part of parts) {
      acc = acc ? `${acc}/${part}` : part
      set.add(acc)
    }
  }

  return [...set].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
}

const sortNode = (node: TreeNode): TreeNode => {
  if (node.type !== 'folder') {
    return node
  }
  const arr = [...node.children.values()].map(sortNode)
  arr.sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === 'folder' ? -1 : 1
    }

    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  })
  node.list = arr
  return node
}
