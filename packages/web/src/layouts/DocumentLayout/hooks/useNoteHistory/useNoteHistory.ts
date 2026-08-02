import { useEffect, useMemo, useState } from 'react'
import { STORE_EVENT } from '@notarium/contract/events'
import type { ReaderMode } from '../../../../composers/NotesProvider'
import type { SyncContextValue } from '../../../../composers/SyncProvider'
import { api } from '../../../../services/api/api'
import type { HistorySelection } from '../../../../widgets/NoteHistory'

type UseNoteHistoryArgs = {
  mode: ReaderMode
  isEditing: boolean
  activeId: string | null
  subscribe: SyncContextValue['subscribe']
}

// Note history (#12), VSCode-style panel pair: the History tab of the aside
// hosts the timeline; a selected revision swaps the main content column to
// the revision view (same pattern as the edit overlay). Selection state
// lives here — both panels are this layout's children.
export const useNoteHistory = ({ mode, isEditing, activeId, subscribe }: UseNoteHistoryArgs) => {
  const [historySel, setHistorySel] = useState<HistorySelection | null>(null)
  const [historyRefresh, setHistoryRefresh] = useState(0)
  // History is one tab of the inspector now (#35) — build its data whenever a note
  // is being read; the timeline mounts lazily (only when its tab is active) and a
  // selected revision drives the main column (below). Keyed off activeId, not the
  // loaded note: on a switch activeId flips at once while `note` still holds the
  // previous one (#68 item 3), so the timeline remounts onto the new note immediately.
  const historyNoteId = mode === 'read' && !isEditing && activeId ? activeId : null
  // The widget's transport port: the host owns the api calls (and the CAS
  // handshake of a restore — fresh token right before the write, #50).
  const historySource = useMemo(
    () =>
      historyNoteId
        ? {
            list: (opts: { offset: number; limit: number }) =>
              api.revisionsGet(historyNoteId, opts),
            detail: (revisionId: string) => api.revisionGet(historyNoteId, revisionId),
            restore: async (revisionId: string) => {
              const live = await api.noteGet(historyNoteId)
              await api.noteRestore(historyNoteId, revisionId, live.versionToken)
            },
          }
        : null,
    [historyNoteId],
  )
  useEffect(() => {
    if (!historyNoteId) {
      return
    }

    return subscribe((event) => {
      if (event.type === STORE_EVENT.CHANGED && event.upserts.includes(historyNoteId)) {
        setHistoryRefresh((n) => n + 1)
      }
    })
  }, [historyNoteId, subscribe])
  // The viewed revision is bound to the note and to reading mode: navigating
  // away or entering the editor drops back to the current version. Keyed off
  // activeId (not the loaded note) so a switch to another note clears the open
  // revision AT ONCE — otherwise the old revision lingers in the main column
  // while the new note loads (#68 item 3).
  useEffect(() => {
    setHistorySel(null)
  }, [activeId, isEditing])
  // Escape = back to current — unless a dialog owns the key right now.
  useEffect(() => {
    if (!historySel) {
      return
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') {
        return
      }
      if (document.querySelector('[aria-modal="true"]')) {
        return
      }
      setHistorySel(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [historySel])

  return {
    historySel,
    setHistorySel,
    historyRefresh,
    setHistoryRefresh,
    historyNoteId,
    historySource,
  }
}
