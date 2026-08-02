import type { RefObject } from 'react'
import type { NoteView } from '../../libs/wire'
import { ExplorerVirtualRows } from './ExplorerVirtualRows'
import { FolderRow } from './FolderRow'
import { NoteRow, NoteRowSkeleton } from './NoteRow'
import type { DndBag, TreeApi, TreeRow } from './types'

export const VirtualTree = ({
  rows,
  scrollRef,
  visible,
  headH,
  activeId,
  activeFolderPath,
  movedId,
  onOpen,
  noteHref,
  openSet,
  toggle,
  dnd,
  tree,
  revealNonce,
}: {
  rows: TreeRow[]
  scrollRef: RefObject<HTMLDivElement | null>
  visible: boolean
  headH: number
  activeId: string | null
  /** The folder whose PAGE is the current surface (#214) — its row lights like the
   *  active note's. Null on a regular note / chrome page. */
  activeFolderPath: string | null
  movedId: string | null
  onOpen: (id: string) => void
  noteHref?: (note: NoteView) => string | null
  openSet: Set<string>
  toggle: (path: string) => void
  dnd: DndBag
  tree: TreeApi
  /** Bumped on a sync to re-arm the scroll for the already-active note (#161). */
  revealNonce: number
}) => {
  // The scroll latch follows the active row into view. An active FOLDER (its page is
  // the surface, #214) takes priority over any retained note id — its `index.md` note
  // has no row, so latching on the note would never scroll. The `folder://` prefix
  // keeps the folder-path key from ever colliding with a note id (which is id-charset,
  // never contains `/`) in this one shared string slot.
  const folderKey = (path: string) => `folder://${path}`
  const scrollActiveKey = activeFolderPath != null ? folderKey(activeFolderPath) : activeId
  return (
    <ExplorerVirtualRows
      rows={rows}
      scrollRef={scrollRef}
      visible={visible}
      headH={headH}
      activeId={scrollActiveKey}
      revealNonce={revealNonce}
      getKey={(row) =>
        row.kind === 'folder' ? row.node.path : row.kind === 'note' ? row.note.id : row.id
      }
      isActive={(row, id) =>
        row.kind === 'note'
          ? row.note.id === id
          : row.kind === 'folder'
            ? folderKey(row.node.path) === id
            : false
      }
      ariaMultiselectable
      renderRow={(row, index) =>
        row.kind === 'folder' ? (
          <FolderRow
            node={row.node}
            depth={row.depth}
            index={index}
            isOpen={openSet.has(row.node.path)}
            active={activeFolderPath === row.node.path}
            toggle={toggle}
            dnd={dnd}
            tree={tree}
          />
        ) : row.kind === 'note' ? (
          <NoteRow
            note={row.note}
            depth={row.depth}
            index={index}
            activeId={activeId}
            movedId={movedId}
            onOpen={onOpen}
            noteHref={noteHref}
            dnd={dnd}
            tree={tree}
          />
        ) : (
          <NoteRowSkeleton folder={row.folder} depth={row.depth} seed={row.seed} />
        )
      }
    />
  )
}
