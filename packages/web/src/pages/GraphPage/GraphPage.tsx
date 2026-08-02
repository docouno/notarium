import { useChrome } from '../../composers/ChromeProvider'
import { useEditing } from '../../composers/EditingProvider'
import { GraphView } from '../../composers/GraphView'
import { useNotes } from '../../composers/NotesProvider'

// `/graph` — the knowledge graph takes over the main area (no topbar/aside).
export const GraphPage = () => {
  const { openNote } = useNotes()
  const { createFromGhost } = useEditing()
  const { theme, railOpen, toggleRail, graphFocus, setGraphFocus } = useChrome()
  return (
    <main className="main">
      <GraphView
        onOpen={openNote}
        onCreateFromGhost={createFromGhost}
        theme={theme}
        railOpen={railOpen}
        onToggleRail={toggleRail}
        initialFocusId={graphFocus}
        onFocusConsumed={() => setGraphFocus(null)}
      />
    </main>
  )
}
