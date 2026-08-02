import type { DragItem } from '../../../../libs/dnd/dnd'
import type { SkeletonNode } from '../../../../libs/tree/tree'
import type { NoteView } from '../../../../libs/wire'
import type { TreeRow } from '../../types'
import { baseName, dirOfPath } from '../paths'

// The drag/selection payload for a tree row — a folder (its path) or a note (id
// + basename + source folder). Skeleton rows aren't selectable/draggable (null).
// Used to resolve a shift-range over the flattened rows into a selection set.
export const rowDragItem = (row: TreeRow): DragItem | null => {
  if (row.kind === 'folder') {
    return { kind: 'folder', id: row.node.path }
  }
  if (row.kind === 'note') {
    return {
      kind: 'note',
      id: row.note.id,
      fileName: baseName(row.note.filePath),
      srcFolder: dirOfPath(row.note.filePath),
    }
  }

  return null
}

export const flattenTree = (
  folders: readonly SkeletonNode[],
  rootNotes: NoteView[] | null,
  rootCount: number,
  openSet: Set<string>,
  notesIn: (folder: string) => NoteView[] | null,
  // The folder the top-level notes belong to (#164): '' in Files/Projects, the
  // focused project's path in single-project focus — so the root notes' skeleton
  // rows + drop targets point at the project, not the space root.
  rootFolder = '',
): TreeRow[] => {
  const rows: TreeRow[] = []

  const pushNotes = (
    folder: string,
    loaded: NoteView[] | null,
    expected: number,
    depth: number,
  ) => {
    if (loaded === null) {
      // The listing hasn't arrived yet → shimmer rows, not "empty folder".
      // An honest count (the skeleton's `direct`), capped around a viewport's
      // worth — a 1000-note folder shouldn't promise four rows and then BOOM;
      // the virtualizer keeps the extra shimmer rows free anyway.
      for (let i = 0; i < Math.min(expected, 24); i++) {
        rows.push({ kind: 'skeleton', id: `${folder}#${i}`, folder, depth, seed: i })
      }

      return
    }
    for (const n of loaded) {
      rows.push({ kind: 'note', note: n, depth })
    }
  }

  const walk = (nodes: readonly SkeletonNode[], depth: number) => {
    for (const node of nodes) {
      rows.push({ kind: 'folder', node, depth })
      if (!openSet.has(node.path)) {
        continue
      }
      walk(node.children, depth + 1)
      if (node.direct > 0) {
        pushNotes(node.path, notesIn(node.path), node.direct, depth + 1)
      }
    }
  }
  walk(folders, 0)
  if (rootCount > 0) {
    pushNotes(rootFolder, rootNotes, rootCount, 0)
  }

  return rows
}
