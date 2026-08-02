import { createContext, type ReactNode, useContext } from 'react'
import { useSpaceState } from './hooks/useSpaceState'
import type { SpaceContextValue } from './types'

// The space layer's client half (#16): which spaces this host serves, which
// one is ACTIVE, and the switch. The URL is the source of truth wherever it
// names a space (/s/<slug>/…); the space-free surfaces (/n/<id>, `/`) inherit
// the last active one — a loaded note then reports its real space
// (reportNoteSpace) so the chrome (tree, scopes) re-anchors to where the note
// actually lives. The last active slug persists per browser so `/` lands where
// the user left off.

export type { SpaceContextValue } from './types'

const SpaceContext = createContext<SpaceContextValue | null>(null)

export const useSpace = (): SpaceContextValue => {
  const ctx = useContext(SpaceContext)

  if (!ctx) {
    throw new Error('useSpace must be used within SpaceProvider')
  }

  return ctx
}

export const SpaceProvider = ({ children }: { children: ReactNode }) => {
  const value = useSpaceState()

  if (!value) {
    return null
  }

  return <SpaceContext.Provider value={value}>{children}</SpaceContext.Provider>
}
