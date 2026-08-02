import type { MenuItem } from '../../../../core/ContextMenu'
import {
  IconCopy,
  IconDocPage,
  IconDownload,
  IconEdit,
  IconExternal,
  IconFolderKanban,
  IconFolderPlus,
  IconKey,
  IconLink,
  IconPin,
  IconPlus,
  IconStar,
  IconStarFilled,
  IconTrash,
} from '../../../../core/Icons'
import type { DragItem } from '../../../../libs/dnd/dnd'
import { noteRoute } from '../../../../libs/routing/routePaths'
import { joinPath, type SkeletonNode } from '../../../../libs/tree/tree'
import type { NoteView } from '../../../../libs/wire'
import type { TreeApi } from '../../types'

// Context-menu item builders. Kept here (not at the app root) because the items
// are pure view actions wired to the shared `tree` action bag.
export const dragItemPath = (item: DragItem): string =>
  item.kind === 'folder' ? item.id : joinPath(item.srcFolder, item.fileName)

export const multiSelectionMenuItems = (items: readonly DragItem[], tree: TreeApi): MenuItem[] => {
  const count = items.length
  const noun = count === 1 ? 'item' : 'items'
  return [
    {
      label: 'Copy paths',
      icon: <IconCopy size={14} />,
      onClick: () => tree.copyText(items.map(dragItemPath).join('\n'), { label: 'paths' }),
    },
    { divider: true },
    {
      label: `Delete ${count} ${noun}`,
      icon: <IconTrash size={14} />,
      danger: true,
      onClick: () => tree.onDeleteItems(items),
    },
  ]
}

export const noteMenuItems = (
  note: NoteView,
  id: string,
  tree: TreeApi,
  contextItems: readonly DragItem[],
  href: string | null = noteRoute(note.id),
): MenuItem[] => {
  if (tree.canWrite && contextItems.length > 1) {
    return multiSelectionMenuItems(contextItems, tree)
  }
  const favorite = tree.isNoteFavorite(note.id)
  // Read-only actions — always available (a reader navigates and copies).
  const read: MenuItem[] = [
    {
      label: favorite ? 'Remove from favorites' : 'Add to favorites',
      icon: favorite ? <IconStarFilled size={14} /> : <IconStar size={14} />,
      onClick: () => tree.onToggleNoteFavorite(note),
    },
    ...(href
      ? [
          {
            label: 'Open in new tab',
            icon: <IconExternal size={14} />,
            onClick: () => window.open(href, '_blank', 'noopener'),
          },
        ]
      : []),
    {
      label: 'Copy wikilink',
      icon: <IconLink size={14} />,
      onClick: () => tree.copyText(`[[${note.title}]]`, { label: 'wikilink', subject: note.title }),
    },
    // The stable notarium-id (#232): the reference an agent drops straight into
    // get_note — unlike the title-based wikilink, it survives a rename.
    {
      label: 'Copy note id',
      icon: <IconKey size={14} />,
      onClick: () => tree.copyText(note.id, { label: 'note id', subject: note.title }),
    },
  ]

  // A reader gets no write affordances — Rename/Duplicate/Delete would only earn
  // a server rejection (the misleading read-only bug, #111 reader-gating).
  if (!tree.canWrite) {
    return read
  }

  return [
    { label: 'Rename', icon: <IconEdit size={14} />, onClick: () => tree.startRename('note', id) },
    { label: 'Duplicate', icon: <IconCopy size={14} />, onClick: () => tree.onDuplicate(note) },
    ...(tree.canPin(note)
      ? [
          {
            label: 'Pin to agent context',
            icon: <IconPin size={14} />,
            onClick: () => tree.onPinNote(note),
          },
        ]
      : []),
    { divider: true },
    ...read,
    { divider: true },
    {
      label: 'Delete',
      icon: <IconTrash size={14} />,
      danger: true,
      onClick: () => tree.onDeleteNote(note),
    },
  ]
}

export const folderMenuItems = (
  node: SkeletonNode,
  tree: TreeApi,
  contextItems: readonly DragItem[],
): MenuItem[] => {
  if (tree.canWrite && contextItems.length > 1) {
    return multiSelectionMenuItems(contextItems, tree)
  }
  const project = tree.projectAt(node.path)
  const favorite = project ? tree.isProjectFavorite(project.id) : tree.folderFavorite(node.path)
  // Read-only actions — always available (a reader navigates and copies). A
  // marked NON-root project can be focused (#164): re-roots the explorer to it.
  const read: MenuItem[] = [
    {
      label: favorite ? 'Remove from favorites' : 'Add to favorites',
      icon: favorite ? <IconStarFilled size={14} /> : <IconStar size={14} />,
      onClick: () =>
        project ? tree.onToggleProjectFavorite(project) : tree.onToggleFolderFavorite(node),
    },
    // The folder's PAGE (#212): open its body if it has one, else the virtual
    // folder page. One entry — the surface decides — so a reader sees it too.
    ...(node.path
      ? [
          {
            label: 'Open page',
            icon: <IconDocPage size={14} />,
            onClick: () => tree.onOpenFolderPage(node),
          },
        ]
      : []),
    ...(project && node.path
      ? [
          {
            label: 'Focus project',
            icon: <IconFolderKanban size={14} />,
            onClick: () => tree.onFocusProject(node.path),
          },
        ]
      : []),
    {
      label: 'Copy path',
      icon: <IconCopy size={14} />,
      onClick: () => tree.copyText(node.path, { label: 'path' }),
    },
    {
      label: 'Export folder',
      icon: <IconDownload size={14} />,
      onClick: () => tree.onExportFolder(node),
    },
  ]

  if (!tree.canWrite) {
    return read
  }
  // A marked folder offers Unmark; an unmarked one offers Mark — only for a
  // principal who can manage the space (a plain member just sees the badge).
  const projectItem: MenuItem | null = !tree.canManageProjects
    ? null
    : project
      ? {
          label: 'Unmark project',
          icon: <IconFolderKanban size={14} />,
          onClick: () => tree.onUnmarkFolder(project),
        }
      : {
          label: 'Mark as project',
          icon: <IconFolderKanban size={14} />,
          onClick: () => tree.onMarkFolder(node),
        }
  return [
    {
      label: 'New note',
      icon: <IconPlus size={14} />,
      onClick: () => tree.onNewInFolder(node.path),
    },
    {
      label: 'New folder',
      icon: <IconFolderPlus size={14} />,
      onClick: () => tree.onNewFolder(node.path),
    },
    {
      label: 'Rename',
      icon: <IconEdit size={14} />,
      onClick: () => tree.startRename('folder', node.path),
    },
    ...(projectItem ? [{ divider: true } as MenuItem, projectItem] : []),
    { divider: true },
    ...read,
    { divider: true },
    {
      label: 'Delete',
      icon: <IconTrash size={14} />,
      danger: true,
      onClick: () => tree.onDeleteFolder(node),
    },
  ]
}
