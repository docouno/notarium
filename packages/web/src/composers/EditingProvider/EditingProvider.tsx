import { createContext, type ReactNode, useContext } from 'react'
import { useEditingState } from './hooks/useEditingState'
import type { EditingContextValue } from './types'

// Editing lifecycle: the draft overlay over the reader, the save pipeline and
// the unsaved-changes guard. The guard is a hybrid (#19):
//  - every router navigation (links, back/forward, programmatic) is covered by
//    useBlocker — confirm, then proceed/reset;
//  - actions that replace the draft *without* necessarily navigating (new note,
//    create-from-ghost, duplicate, open-in-graph) confirm explicitly via
//    ensureCanLeaveDraft/guarded.
// A tab close/reload still falls back to the browser's native beforeunload.

export type { EditingContextValue, EditingSessionAdapter, Ghost } from './types'

const EditingContext = createContext<EditingContextValue | null>(null)

export const useEditing = (): EditingContextValue => {
  const ctx = useContext(EditingContext)

  if (!ctx) {
    throw new Error('useEditing must be used within EditingProvider')
  }

  return ctx
}

export const EditingProvider = ({ children }: { children: ReactNode }) => {
  const value = useEditingState()

  return <EditingContext.Provider value={value}>{children}</EditingContext.Provider>
}
