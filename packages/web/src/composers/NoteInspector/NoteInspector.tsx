import { type ReactNode, useMemo } from 'react'

import { AsideGroups, type AsidePanelDef, type LayoutSpec } from '../../core/AsideGroups'
import { STORAGE_KEYS } from '../../libs/storageKeys'
import type { GraphNodeView as GraphNode } from '../../libs/wire'
import { MetaPanel } from '../../widgets/MetaPanel'
import { GraphPanel } from './GraphPanel'
import { LinkList } from './LinkList'
import { useNoteGraph } from './useNoteGraph'

// The reading-mode right aside: a stack of tabbed groups over the active note's
// inspector panels (Graph, Links, Backlinks, Meta, History). It fetches the graph
// once (useNoteGraph) and hands each panel its slice, then lets AsideGroups own
// the layout (tabs, split, corner resize, persistence). History is supplied as a
// ready node by the layout above (it owns the revision API + the main-column
// swap) — so this composer stays unaware of the journal.

// Default read layout: the note's "about" panels on top (the graph, with Meta and
// History as tabs beside it) and the connection lists (Links / Backlinks) below —
// so a note's links keep their own group while graph/meta/history share the top.
// Composition is fixed (#35); tab DnD is #36.
const DEFAULT_LAYOUT: LayoutSpec = [
  { panels: ['graph', 'meta', 'history'], activeTab: 'graph', height: 260 },
  { panels: ['links', 'backlinks'], activeTab: 'links' },
]

type MetaNote = { filePath?: string; frontmatter?: Record<string, unknown>; class?: string }

type NoteInspectorProps = {
  note: MetaNote | null
  activeId?: string | null
  space: string
  theme?: string
  onOpen: (id: string) => void
  onOpenTag?: (foldedTag: string) => void
  onCreateFromGhost?: (node: GraphNode) => void
  onOpenInGraph?: (id: string) => void
  /** The History timeline, built by the layout (revision API + selection → main
   *  column). null while there's no note → no History tab. */
  historyContent: ReactNode | null
  /** The panel toggle (collapse the aside), shown in the first group's head. */
  headerAction?: ReactNode
}

export const NoteInspector = ({
  note,
  activeId,
  space,
  theme,
  onOpen,
  onOpenTag,
  onCreateFromGhost,
  onOpenInGraph,
  historyContent,
  headerAction,
}: NoteInspectorProps) => {
  const { data, error, depth, setDepth, slice, backlinks, outgoing } = useNoteGraph(activeId, space)

  const panels = useMemo<AsidePanelDef[]>(() => {
    const defs: AsidePanelDef[] = [
      {
        id: 'graph',
        label: 'Graph',
        render: () => (
          <GraphPanel
            data={data}
            error={error}
            slice={slice}
            depth={depth}
            setDepth={setDepth}
            activeId={activeId}
            theme={theme}
            onOpen={onOpen}
            onCreateFromGhost={onCreateFromGhost}
            onOpenInGraph={onOpenInGraph}
          />
        ),
      },
      {
        id: 'links',
        label: 'Links',
        badge: outgoing.length,
        render: () => (
          <LinkList
            kind="links"
            items={outgoing}
            onOpen={onOpen}
            onCreateFromGhost={onCreateFromGhost}
          />
        ),
      },
      {
        id: 'backlinks',
        label: 'Backlinks',
        badge: backlinks.length,
        render: () => (
          <LinkList
            kind="backlinks"
            items={backlinks}
            onOpen={onOpen}
            onCreateFromGhost={onCreateFromGhost}
          />
        ),
      },
      {
        id: 'meta',
        label: 'Meta',
        render: () => <MetaPanel note={note ?? {}} space={space} onOpenTag={onOpenTag} />,
      },
    ]

    if (historyContent != null) {
      defs.push({ id: 'history', label: 'History', render: () => historyContent })
    }

    return defs
  }, [
    data,
    error,
    slice,
    depth,
    setDepth,
    activeId,
    theme,
    onOpen,
    onOpenTag,
    onCreateFromGhost,
    onOpenInGraph,
    outgoing,
    backlinks,
    note,
    space,
    historyContent,
  ])

  return (
    <AsideGroups
      panels={panels}
      defaultLayout={DEFAULT_LAYOUT}
      storageKey={STORAGE_KEYS.asideGroups}
      headerAction={headerAction}
    />
  )
}
