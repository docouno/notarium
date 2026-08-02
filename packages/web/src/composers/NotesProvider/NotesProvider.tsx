import { createContext, type ReactNode, useContext } from 'react'
import { useNotesState } from './hooks/useNotesState'
import type { NotesContextValue } from './types'

// Central note data + the URL↔reader sync. The URL is the source of truth for
// *where* we are (react-router renders the page); this provider owns *what* is
// loaded. Since #64 the full note list never crosses the wire: the provider
// boots from GET /api/tree (folder skeleton + counts + stats) and loads note
// listings lazily, one folder at a time via GET /api/tree/children (direct
// children, title-ordered) as the sidebar expands them. Everything any listing ever returned is merged into a
// "seen" registry — the resolution cache behind navigate-first opens, wiki-link
// styling and the rail's "Files" return target. Exhaustive questions (folder
// delete victims, Feed windows) go to the server, never to client memory.
//
// Freshness rides the shared SSE stream: `changed` events fold into one
// coalesced refresh of the tree + the folder listings this session holds
// (filtered by "does this event touch that folder" when the ids allow it), and
// a failed boot retries itself when the read-model reports progress.

/** Changed-event refreshes are coalesced: a delta poll landing many notes costs
 *  one /api/tree + one window per loaded folder (snapshot-served, ~ms each). */

export type { NavScope, ReaderMode, NoteError, NotesContextValue } from './types'

const NotesContext = createContext<NotesContextValue | null>(null)

export const useNotes = (): NotesContextValue => {
  const ctx = useContext(NotesContext)

  if (!ctx) {
    throw new Error('useNotes must be used within NotesProvider')
  }

  return ctx
}

export const NotesProvider = ({ children }: { children: ReactNode }) => {
  const value = useNotesState()

  return <NotesContext.Provider value={value}>{children}</NotesContext.Provider>
}
