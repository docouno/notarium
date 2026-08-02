import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from 'react'
import { useSpace } from '../SpaceProvider'
import { Spotlight } from './Spotlight'

// SpotlightProvider — owns the overlay's open state and mounts the modal (#31).
// Sits inside SpaceProvider (it needs the active space) and the router (Spotlight
// navigates). Since #190 it has THREE triggers, all via `useSpotlight()`: the
// Cmd/Ctrl+P hotkey, the rail Search icon, and the `/` hotkey — the rail Search
// VIEW it used to coexist with is gone. The command palette (#30) would register
// more entries against the same api — this is the single owner of "is it open".

type SpotlightApi = {
  open: () => void
  close: () => void
  toggle: () => void
}

const SpotlightContext = createContext<SpotlightApi | null>(null)

export const useSpotlight = (): SpotlightApi => {
  const ctx = useContext(SpotlightContext)

  if (!ctx) {
    throw new Error('useSpotlight must be used within SpotlightProvider')
  }

  return ctx
}

export const SpotlightProvider = ({ children }: { children: ReactNode }) => {
  const { space } = useSpace()
  const [open, setOpen] = useState(false)

  // The hotkey that opens this (Cmd/Ctrl+P by default) is owned by the central
  // HotkeysProvider (#30), which calls `toggle()` below — there is no per-overlay
  // keydown listener anymore. The binding is user-customisable in Settings → Keyboard.

  // A space switch (#16) invalidates the recents + results the overlay holds —
  // close it so it never shows the previous space's notes.
  useEffect(() => {
    setOpen(false)
  }, [space])

  const api = useMemo<SpotlightApi>(
    () => ({
      open: () => setOpen(true),
      close: () => setOpen(false),
      toggle: () => setOpen((o) => !o),
    }),
    [],
  )

  return (
    <SpotlightContext.Provider value={api}>
      {children}
      {open && <Spotlight space={space} onClose={() => setOpen(false)} />}
    </SpotlightContext.Provider>
  )
}
