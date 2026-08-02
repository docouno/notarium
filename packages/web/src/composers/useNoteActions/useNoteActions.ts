import { useCallback, useRef } from 'react'
import { useNavigate } from 'react-router'
import { HTTP_STATUS } from '@notarium/contract/http'
import { DEFAULT_NOTE_TYPE } from '@notarium/core'
import { useDialog } from '../../core/Dialog'
import { useToast } from '../../core/Toast'
import type { DragItem } from '../../libs/dnd/dnd'
import { folderRoute } from '../../libs/routing/routePaths'
import { folderOf, joinPath } from '../../libs/tree/tree'
import type { NoteView } from '../../libs/wire'
import { api, ApiError } from '../../services/api'
import { useEditing } from '../EditingProvider'
import { useNotes } from '../NotesProvider'
import { useProjects } from '../ProjectsProvider'
import { useSpace } from '../SpaceProvider'
import { deletePlan, isInsideFolder } from './helpers/deletePlan'
import { plural } from './helpers/plural'
import type { TreeFolderNode } from './types'

// Note/folder CRUD actions shared by the tree's context menu, drag-and-drop and
// the topbar. Each mutation refreshes only the folders it TOUCHES (#94) — the
// tree skeleton plus the source/destination listings — never every loaded
// folder, whose ~95-wide refetch wave used to saturate the connection pool and
// stall the next /api/move behind it. Since #51 a note's URL is its id — rename
// and move never change it, so the open note just reloads in place; only deletes
// navigate away.
//
// A failure surfaces as a toast (#65): transient, owner-scoped feedback that
// doesn't block or ride across pages — never the old global error banner.

export const useNoteActions = () => {
  const { space } = useSpace()
  const { note, mode, openNote, reloadNote, clearReader, refreshFolders, applyLocalMove } =
    useNotes()
  const { reload: reloadProjects } = useProjects()
  const { isEditing, guarded } = useEditing()
  const { confirm } = useDialog()
  const toast = useToast()
  const navigate = useNavigate()

  // Per-note move pipeline (#94). The optimistic relocation makes the row follow
  // every drop INSTANTLY, but the backend moves are id-addressed to an absolute
  // path and must apply in order — two concurrent /api/move for one note could
  // land out of order and leave the server at the wrong folder. So we keep at
  // most ONE move request in flight per note and coalesce: a drop while one is
  // pending just updates the desired destination, and when the in-flight move
  // returns we fire one move to the NEWEST target (intermediate hops are skipped
  // — the file goes straight to where it ended up). This is what lets the user
  // grab a note again and re-throw it while the first ~5s move is still pending
  // without being blocked. `touched` accumulates every folder the chain passed
  // through (origin + each destination) — the set reconciled once it settles, so
  // that even a mid-chain failure refreshes wherever the backend left the note.
  type MovePlan = { dest: string; destPath: string; inFlight: boolean; touched: Set<string> }
  const movePlans = useRef(new Map<string, MovePlan>())
  // Folder moves stay single-flight-guarded (structural subtree relocate, not a
  // coalescable single-row hop): ignore a repeat while one is pending.
  const movingFolders = useRef(new Set<string>())

  // The reader follows a rename/move only while plainly reading — an active
  // edit keeps its draft untouched (same contract as before the split).
  const reading = mode === 'read' && !isEditing

  // Rename a folder or a note in place. A folder rename is a directory move to a
  // sibling path (the engine relocates the subtree; it does NOT rewrite other
  // notes' links — that long-standing claim was a myth, #100). A note rename changes its
  // title — which drives the on-disk filename — so we reuse the in-place rename
  // path (read content, then save with originalId) to move the file instead of
  // writing a duplicate (see #8). The note's id — and URL — survive either way;
  // the reader just reloads in place, and inbound [[Old Title]] keep resolving
  // through the note's alias-history (#100), no source bodies touched.
  const renameItem = useCallback(
    async (kind: 'note' | 'folder', item: NoteView | TreeFolderNode, newName: string) => {
      try {
        if (kind === 'folder') {
          const oldPath = (item as TreeFolderNode).path
          const dest = joinPath(folderOf(oldPath), newName)

          if (dest === oldPath) {
            return
          }
          await api.moveFolder(space, oldPath, dest)
          // A folder rename is a directory move within the same parent — that
          // parent's skeleton changes (the renamed child); the subtree's stale
          // path keys are simply no longer referenced by the refreshed skeleton.
          // Await both so the badge channel updates in the SAME render as the
          // skeleton (#97/item 2): a fire-and-forget reloadProjects left a window where
          // the renamed folder's badge lagged the moved skeleton. The tree is now
          // server-authoritative (one channel), so this only refreshes the badge.
          await Promise.all([refreshFolders([folderOf(oldPath)]), reloadProjects()])
          if (reading && note?.filePath?.startsWith(oldPath + '/')) {
            await reloadNote()
          }
        } else {
          const target = item as NoteView

          // Read-then-save under the read's version token (#50). A rename only
          // changes the title, so a conflict (someone wrote between our read and
          // save) is resolved by simply re-reading: their content + our new
          // title, nothing lost. One retry; a second conflict surfaces as the
          // error it is.
          for (let attempt = 0; ; attempt++) {
            const full = await api.noteGet(target.id)

            try {
              await api.noteSave(space, {
                // Body-first title (#156): a rename is changing the document's leading
                // `# H1`. Reconstruct it onto the (H1-less) stored body; the save
                // chokepoint derives the new title from it and renames the note.
                content: full.content ? `# ${newName}\n\n${full.content}` : `# ${newName}`,
                directory: folderOf(target.filePath),
                noteType: (full.frontmatter?.type as string) || DEFAULT_NOTE_TYPE,
                tags: Array.isArray(full.frontmatter?.tags)
                  ? (full.frontmatter.tags as string[])
                  : undefined,
                originalId: target.id,
                versionToken: full.versionToken,
              })
              break
            } catch (e) {
              if (attempt === 0 && e instanceof ApiError && e.status === HTTP_STATUS.CONFLICT) {
                continue
              }
              throw e
            }
          }
          // A note rename changes only its title/filename — it stays in the same
          // folder, so just that listing (+ skeleton) needs refreshing.
          await refreshFolders([folderOf(target.filePath)])
          // The id — and therefore the /n/<id> URL — held; the reader refreshes.
          if (reading && note && note.id === target.id) {
            await reloadNote()
          }
        }
      } catch (e) {
        toast.error((e as Error).message)
      }
    },
    [toast, refreshFolders, reading, note, reloadNote, space, reloadProjects],
  )

  // Delete a single note from the tree (distinct from the topbar delete, which
  // targets the open note). Confirms first, then clears the reader if it was open.
  const removeNote = useCallback(
    async (target: NoteView): Promise<boolean> => {
      const ok = await confirm({
        title: `Delete “${target.title}”?`,
        message: 'This permanently removes the underlying file.',
        confirmLabel: 'Delete',
        danger: true,
      })

      if (!ok) {
        return false
      }
      try {
        await api.noteRemove(target.id)
        const wasOpen = note && note.id === target.id

        if (wasOpen) {
          clearReader()
        }
        await refreshFolders([folderOf(target.filePath)])
        if (wasOpen && note) {
          navigate(folderRoute(space, folderOf(note.filePath)))
        }

        return true
      } catch (e) {
        toast.error((e as Error).message)
        return false
      }
    },
    [confirm, toast, note, clearReader, refreshFolders, navigate, space],
  )

  // Delete a whole folder (#97). A single server call removes its notes
  // (journaled #12), any project markers it held, and the dir subtree — folders
  // are first-class on disk now (no "delete every note so the dir prunes"). We
  // still fetch the subtree count for an honest confirm; `total` is the full
  // population (the old per-page victim loop silently missed notes beyond the
  // first window — the server now deletes the whole subtree).
  const removeFolder = useCallback(
    async (node: TreeFolderNode): Promise<boolean> => {
      let count: number

      try {
        // depth defaults to subtree; limit:1 fetches one row but `total` is the
        // honest full subtree population (the count the confirm shows).
        ;({ total: count } = await api.notesGet(space, { folder: node.path, limit: 1 }))
      } catch (e) {
        toast.error((e as Error).message)
        return false
      }
      const ok = await confirm({
        title: `Delete folder “${node.name}”?`,
        message: count
          ? `This permanently removes the folder and ${count} note${count === 1 ? '' : 's'} inside.`
          : 'This permanently removes the empty folder.',
        confirmLabel: 'Delete',
        danger: true,
      })

      if (!ok) {
        return false
      }
      try {
        const wasOpen = note && (note.filePath || '').startsWith(node.path + '/')
        const nextFolder = folderOf(node.path)
        await api.folderDelete(space, node.path)
        if (wasOpen) {
          clearReader()
        }
        // The folder (and any project marker it held) is gone — refresh the parent
        // skeleton and the project badges together.
        await Promise.all([refreshFolders([folderOf(node.path)]), reloadProjects()])
        if (wasOpen) {
          navigate(folderRoute(space, nextFolder))
        }

        return true
      } catch (e) {
        toast.error((e as Error).message)
        return false
      }
    },
    [confirm, toast, note, clearReader, refreshFolders, reloadProjects, navigate, space],
  )

  // Delete a context-menu selection (#206). The UI selection may contain both a
  // folder and rows inside it; the server folder-delete already removes the whole
  // subtree, so children covered by selected folders are intentionally skipped.
  const removeItems = useCallback(
    async (items: readonly DragItem[]): Promise<boolean> => {
      const plan = deletePlan(items)

      if (plan.selectedCount === 0 || (plan.notes.length === 0 && plan.folders.length === 0)) {
        return false
      }

      const folderCounts = new Map<string, number>()

      try {
        await Promise.all(
          plan.folders.map(async (folder) => {
            const { total } = await api.notesGet(space, { folder, limit: 1 })
            folderCounts.set(folder, total)
          }),
        )
      } catch (e) {
        toast.error((e as Error).message)
        return false
      }

      const folderNoteCount = [...folderCounts.values()].reduce((sum, count) => sum + count, 0)
      const noun = plan.selectedCount === 1 ? 'item' : 'items'
      const ok = await confirm({
        title: `Delete ${plan.selectedCount} ${noun}?`,
        message: `This permanently removes ${plural(plan.selectedCount, 'selected item')}${
          folderNoteCount > 0
            ? `, including ${plural(folderNoteCount, 'note')} inside selected folders`
            : ''
        }.`,
        confirmLabel: `Delete ${plan.selectedCount} ${noun}`,
        danger: true,
      })

      if (!ok) {
        return false
      }

      const touched = new Set<string>()
      let deletedAny = false
      let deletedFolder = false
      let deletedOpen = false
      let navigateFolder = ''
      const openBeforeDelete = note

      for (const target of plan.notes) {
        try {
          await api.noteRemove(target.id)
          touched.add(target.srcFolder)
          deletedAny = true
          if (openBeforeDelete?.id === target.id) {
            deletedOpen = true
            navigateFolder = target.srcFolder
          }
        } catch (e) {
          toast.error((e as Error).message)
        }
      }

      for (const folder of plan.folders) {
        try {
          await api.folderDelete(space, folder)
          touched.add(folderOf(folder))
          deletedAny = true
          deletedFolder = true
          if (openBeforeDelete?.filePath && isInsideFolder(openBeforeDelete.filePath, folder)) {
            deletedOpen = true
            navigateFolder = folderOf(folder)
          }
        } catch (e) {
          toast.error((e as Error).message)
        }
      }

      if (!deletedAny) {
        return false
      }
      if (deletedOpen) {
        clearReader()
        navigate(folderRoute(space, navigateFolder))
      }
      await Promise.all([
        refreshFolders([...touched]),
        deletedFolder ? reloadProjects() : Promise.resolve(),
      ])
      return true
    },
    [confirm, toast, note, clearReader, refreshFolders, reloadProjects, navigate, space],
  )

  // Create a new empty (unmarked) folder (#97): a durable, first-class dir. Slashes
  // nest (the last segment is the name); a name clash 409s. The tree is server-
  // authoritative, so refresh the parent skeleton to surface the new node. Throws
  // on failure so the caller (which owns the prompt + reveal) can react.
  const createFolder = useCallback(
    async (path: string) => {
      await api.folderCreate(space, path)
      await refreshFolders([folderOf(path)])
    },
    [space, refreshFolders],
  )

  // Duplicate a note: copy its content into a new "<title> copy" in the same
  // folder, then open the copy. Guarded: discarding an active draft is confirmed.
  const duplicateNote = guarded(async (target: NoteView) => {
    try {
      const full = await api.noteGet(target.id)
      const newTitle = `${target.title} copy`
      const saved = await api.noteSave(space, {
        // Body-first title (#156): the copy's title is its leading `# H1`. Prepend it
        // to the source's (H1-less) body so the create derives "<title> copy".
        content: full.content ? `# ${newTitle}\n\n${full.content}` : `# ${newTitle}`,
        directory: folderOf(target.filePath),
        noteType: (full.frontmatter?.type as string) || DEFAULT_NOTE_TYPE,
        tags: Array.isArray(full.frontmatter?.tags)
          ? (full.frontmatter.tags as string[])
          : undefined,
      })
      // The copy lands in the same folder as its source.
      await refreshFolders([folderOf(target.filePath)])
      await openNote(saved.id)
    } catch (e) {
      toast.error((e as Error).message)
    }
  })

  // Drive a note's move pipeline: fire one /api/move at a time, looping to the
  // latest desired destination if more drops arrived while in flight, then a
  // SINGLE reconciling refresh of the true endpoints (origin + final folder).
  // The refresh reads server truth, so it also corrects the optimistic row if a
  // move failed (e.g. destination occupied) — no manual rollback bookkeeping.
  const drainNoteMoves = useCallback(
    async (id: string) => {
      const plan = movePlans.current.get(id)

      if (!plan || plan.inFlight) {
        return
      } // already draining, or nothing to do
      plan.inFlight = true
      try {
        // Loop: commit the current target; if a newer one arrived meanwhile, go again.
        for (;;) {
          const cur = movePlans.current.get(id)

          if (!cur) {
            break
          }
          const destPath = cur.destPath
          await api.moveNote(id, destPath)
          const after = movePlans.current.get(id)

          if (after && after.destPath !== destPath) {
            continue
          } // superseded by a later drop
          break
        }
      } catch (e) {
        toast.error((e as Error).message)
      } finally {
        // Captured before delete; no user drop can interleave between the loop's
        // break and here (single-threaded, no await in between).
        const folders = [...(movePlans.current.get(id)?.touched ?? [])]
        movePlans.current.delete(id)
        // Reconcile every folder the chain touched against server truth — this
        // also pulls the optimistic row back if a move failed (occupied dest, etc).
        await refreshFolders(folders)
        if (reading && note && note.id === id) {
          await reloadNote()
        }
      }
    },
    [toast, refreshFolders, reading, note, reloadNote],
  )

  // Enqueue ONE note's move into the optimistic per-note coalescing pipeline.
  // `drag.srcFolder` is the row's CURRENT (already-optimistic) folder, so
  // re-throws chain cleanly. The row relocates NOW (applyLocalMove); the server
  // move + reconciling refresh ride the drain (at most one /api/move in flight
  // per note, last-drop-wins). A no-op (already in dest) is skipped.
  const enqueueNoteMove = useCallback(
    (drag: DragItem, dest: string) => {
      if (drag.kind !== 'note') {
        return
      }
      const srcFolder = drag.srcFolder

      if (srcFolder === dest) {
        return
      } // already sits here (current optimistic location)
      const destinationPath = joinPath(dest, drag.fileName)
      applyLocalMove(drag.id, srcFolder, dest, destinationPath) // row moves NOW
      const existing = movePlans.current.get(drag.id)

      if (existing) {
        existing.dest = dest
        existing.destPath = destinationPath // coalesce: in-flight drain picks this up
        existing.touched.add(srcFolder).add(dest)
      } else {
        movePlans.current.set(drag.id, {
          dest,
          destPath: destinationPath,
          inFlight: false,
          touched: new Set([srcFolder, dest]),
        })
      }
      void drainNoteMoves(drag.id)
    },
    [applyLocalMove, drainNoteMoves],
  )

  // Move a BATCH of folders into `dest`, sequentially, then ONE combined refresh.
  // A folder move is a structural subtree relocate (not a coalescable single-row
  // hop), so each is single-flight guarded and awaited in turn — concurrent
  // structural moves + repeated skeleton/badge reloads are exactly what the
  // combined refresh avoids. A per-item failure toasts but doesn't abort the rest
  // (partial success is visible — the issue's recommendation 1). The refresh set
  // is the union of every touched parent + the destination, so for a single
  // folder it's `[srcFolder, dest]` — byte-identical to the pre-#163 path.
  const moveFoldersBatch = useCallback(
    async (folders: DragItem[], dest: string) => {
      const touched = new Set<string>([dest])
      let movedAny = false

      for (const f of folders) {
        if (f.kind !== 'folder' || movingFolders.current.has(f.id)) {
          continue
        }
        const base = f.id.split('/').pop() as string
        const destinationPath = joinPath(dest, base)

        if (destinationPath === f.id) {
          continue
        } // dropped on its current parent (no-op)
        movingFolders.current.add(f.id)
        touched.add(folderOf(f.id))
        try {
          await api.moveFolder(space, f.id, destinationPath)
          movedAny = true
        } catch (e) {
          toast.error((e as Error).message)
        } finally {
          movingFolders.current.delete(f.id)
        }
      }
      if (!movedAny) {
        return
      }
      // Await both (badge + skeleton in one render, #97/item 2); the project rows were
      // re-prefixed server-side (#13 I3), this refreshes the badges to follow.
      await Promise.all([refreshFolders([...touched]), reloadProjects()])
      // The reader follows if the open note lived under ANY moved folder (its id —
      // and URL — are unchanged, #51, so it just reloads in place).
      if (reading && note && folders.some((f) => (note.filePath || '').startsWith(f.id + '/'))) {
        await reloadNote()
      }
    },
    [space, refreshFolders, reloadProjects, reading, note, reloadNote, toast],
  )

  // Drag-and-drop move of a SET (#163): one or many notes/folders dropped onto a
  // tree folder (''=root). Notes ride the optimistic per-note pipeline (each
  // independent + coalesced); folders go through the sequential batch with a
  // single combined refresh. Callers pass an already-droppable set (the section
  // filters via `droppableInto`), but each branch re-checks no-ops defensively.
  // The open note's URL never moves with it (#51: the id is the address).
  const moveItems = useCallback(
    async (items: readonly DragItem[], destFolder: string) => {
      const dest = destFolder || ''

      for (const it of items) {
        if (it.kind === 'note') {
          enqueueNoteMove(it, dest)
        }
      }
      const folders = items.filter((it) => it.kind === 'folder')

      if (folders.length) {
        await moveFoldersBatch(folders, dest)
      }
    },
    [enqueueNoteMove, moveFoldersBatch],
  )

  // Topbar delete: targets the open note.
  const deleteNote = useCallback(async () => {
    if (!note) {
      return
    }
    const ok = await confirm({
      title: `Delete “${note.title}”?`,
      message: 'This permanently removes the underlying file.',
      confirmLabel: 'Delete',
      danger: true,
    })

    if (!ok) {
      return
    }
    try {
      await api.noteRemove(note.id)
      const folder = folderOf(note.filePath)
      clearReader()
      await refreshFolders([folder])
      navigate(folderRoute(space, folder))
    } catch (e) {
      toast.error((e as Error).message)
    }
  }, [note, confirm, toast, clearReader, refreshFolders, navigate, space])

  return {
    renameItem,
    removeNote,
    removeFolder,
    removeItems,
    createFolder,
    duplicateNote,
    moveItems,
    deleteNote,
  }
}
