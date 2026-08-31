import { lazy, Suspense } from 'react'

import { EmptyState } from '../../core/EmptyState'
import { IconGraph } from '../../core/Icons'
import { Skeleton } from '../../core/Skeleton'
import { cx } from '../../libs/cx/cx'
import type { GraphView as Graph, GraphNodeView as GraphNode } from '../../libs/wire'
import styles from './panels.module.scss'

const ForceGraphCanvas = lazy(async () => {
  const { ForceGraphCanvas: LoadedForceGraphCanvas } = await import('../../core/ForceGraphCanvas')

  return { default: LoadedForceGraphCanvas }
})

type GraphPanelProps = {
  /** null until the first /api/graph load resolves (drives the skeleton). */
  data: Graph | null
  error: string | null
  slice: { nodes: GraphNode[]; links: Graph['links'] }
  depth: number
  setDepth: (d: number) => void
  activeId?: string | null
  theme?: string
  onOpen: (id: string) => void
  onCreateFromGhost?: (node: GraphNode) => void
  onOpenInGraph?: (id: string) => void
}

// First-load placeholder for the graph square: a central node + a ring of
// satellites in shimmer, so the panel reads as "a graph is coming" rather than a
// bare word. Decorative, hence aria-hidden.
const GraphSkeleton = () => (
  <div className={styles.graphSkeleton} aria-hidden="true" data-testid="localgraph-skeleton">
    <Skeleton className={styles.skelNode} radius="50%" />
    <Skeleton className={cx(styles.skelSat, styles.skelSat1)} radius="50%" />
    <Skeleton className={cx(styles.skelSat, styles.skelSat2)} radius="50%" />
    <Skeleton className={cx(styles.skelSat, styles.skelSat3)} radius="50%" />
  </div>
)

// The local graph for the active note, as one inspector panel. It fills its
// group's body — height is owned by the group (the corner/divider resize), not
// by this panel, so the same square stretches when the group grows. Data comes
// pre-sliced from useNoteGraph; this is pure presentation.
export const GraphPanel = ({
  data,
  error,
  slice,
  depth,
  setDepth,
  activeId,
  theme,
  onOpen,
  onCreateFromGhost,
  onOpenInGraph,
}: GraphPanelProps) => {
  const hasGraph = slice.nodes.length > 1
  return (
    <div className={styles.graphPanel}>
      {error ? (
        <div className={styles.graphEmpty}>{error}</div>
      ) : !data ? (
        // First graph load (#68 item 5): a star-shaped shimmer instead of a
        // "Loading…" line, matching the shape the canvas will take.
        <GraphSkeleton />
      ) : !hasGraph ? (
        <div className={styles.graphEmpty}>
          <EmptyState
            variant="bare"
            icon={<IconGraph size={22} />}
            title="No links from this note yet"
            hint="Mentions and wiki-links you add show up here as a map."
            testId="localgraph-empty"
          />
        </div>
      ) : (
        <Suspense fallback={<GraphSkeleton />}>
          <ForceGraphCanvas
            graph={slice}
            theme={theme}
            activeId={activeId}
            onOpen={onOpen}
            onCreateFromGhost={onCreateFromGhost}
            // Size by each note's full-vault connectivity (not the local slice), and
            // match the graph page's "100%" spacing so both views read the same. The
            // active note is marked by its ring + centre.
            sizeBy="degree"
            spacing={1.1}
            fitPadding={40}
            maxZoom={2}
          />
        </Suspense>
      )}
      {/* Locate this note in the full graph: switch to the graph view with this
          note pinned as the focus, so you see its place in the whole vault. */}
      {onOpenInGraph && data && !error && activeId && hasGraph && (
        <button
          className={styles.graphLocate}
          onClick={() => onOpenInGraph(activeId)}
          title="Open in graph — focus this note"
          aria-label="Open in graph"
        >
          <IconGraph size={15} />
        </button>
      )}
      {/* Depth = how many link-hops from the active note to include. Docked
          bottom-left, mirroring the zoom controls bottom-right. Hidden when
          there's no graph to slice. */}
      {data && !error && hasGraph && (
        <div className={styles.graphDepth}>
          <div className={styles.depthToggle} role="group" aria-label="Graph depth">
            <button
              className={depth === 1 ? styles.on : ''}
              onClick={() => setDepth(1)}
              title="Direct links (1 hop)"
            >
              1
            </button>
            <button
              className={depth === 2 ? styles.on : ''}
              onClick={() => setDepth(2)}
              title="Two hops"
            >
              2
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
