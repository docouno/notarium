import type { DragItem } from '../../../../libs/dnd/dnd'
import type { DragNoteItem } from '../../types'

export const isInsideFolder = (path: string, folder: string): boolean =>
  path === folder || path.startsWith(`${folder}/`)

const outermostFolders = (paths: readonly string[]): string[] => {
  const sorted = [...new Set(paths)].sort((a, b) => a.length - b.length || a.localeCompare(b))
  const kept: string[] = []

  for (const path of sorted) {
    if (!kept.some((parent) => isInsideFolder(path, parent))) {
      kept.push(path)
    }
  }

  return kept
}

export const deletePlan = (
  items: readonly DragItem[],
): { selectedCount: number; notes: DragNoteItem[]; folders: string[] } => {
  const unique = new Map<string, DragItem>()

  for (const item of items) {
    unique.set(`${item.kind}:${item.id}`, item)
  }
  const all = [...unique.values()]
  const folders = outermostFolders(
    all.filter((item) => item.kind === 'folder').map((item) => item.id),
  )
  const notes = all.filter(
    (item): item is DragNoteItem =>
      item.kind === 'note' && !folders.some((folder) => isInsideFolder(item.srcFolder, folder)),
  )
  return { selectedCount: unique.size, notes, folders }
}
