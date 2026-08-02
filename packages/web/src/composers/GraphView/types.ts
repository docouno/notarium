import type { FolderNode } from '../../libs/tree/tree'

// A row context menu, anchored at the click point.
export type FolderMenuState = { x: number; y: number; node: FolderNode }
export type ClusterMenuState = { x: number; y: number; id: number }
