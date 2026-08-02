import type { DragItem } from '../../libs/dnd/dnd'

// The drag payload is the canonical discriminated union from libs/dnd — a note
// (id + basename + source folder) or a folder (its path). One source of truth so
// the tree's drag source, the validity rules and the move action never drift.

export type TreeFolderNode = { name: string; path: string }
export type DragNoteItem = Extract<DragItem, { kind: 'note' }>
