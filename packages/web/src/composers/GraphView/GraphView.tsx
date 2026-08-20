import { type MouseEvent as ReactMouseEvent, useEffect, useMemo, useRef, useState } from 'react'
import { SCAN_PHASE } from '@notarium/core'
import { buildTagFacet } from '@notarium/core/tags'
import { Aside } from '../../core/Aside'
import { ContextMenu, type MenuItem } from '../../core/ContextMenu'
import { ForceGraphCanvas } from '../../core/ForceGraphCanvas'
import {
  IconCrosshair,
  IconEye,
  IconEyeOff,
  IconPanelLeft,
  IconPanelRight,
  IconX,
} from '../../core/Icons'
import { IconToggle } from '../../core/IconToggle'
import { MiniStat, MiniStats } from '../../core/MiniStat'
import { Notice } from '../../core/Notice'
import { Segmented } from '../../core/Segmented'
import { Slider } from '../../core/Slider'
import {
  buildGroupColors,
  buildPalette,
  groupKey,
  groupKeyOfPath,
} from '../../libs/graph/graphColors'
import { computeVisibleIds, countShown } from '../../libs/graph/graphFilter'
import { idOf } from '../../libs/graph/graphId'
import {
  buildClusterList,
  type ClusterWithColor,
  computeCommunityMap,
  computeFocusNeighbors,
  computeInDegree,
  computeLinksToGhost,
  inDegHistogram,
} from '../../libs/graph/graphMetrics'
import { scanGraph } from '../../libs/graph/graphSearch'
import { STORAGE_KEYS } from '../../libs/storageKeys'
import {
  buildFolderTree,
  type FolderNode,
  toggleFolder as toggleFolderSet,
} from '../../libs/tree/tree'
import type { GraphLink, GraphNodeView as GraphNode } from '../../libs/wire'
import { useBulkWords } from '../../services/previews'
import { FolderTree } from '../../widgets/FolderTree'
import { GraphSearch } from '../../widgets/GraphSearch'
import { TagFilter } from '../../widgets/TagFilter'
import { GRAPH_SCAN_DEBOUNCE_MS, SPACING_SHIFT } from './consts'
import { useGraphData } from './hooks/useGraphData'
import { useGraphPulse } from './hooks/useGraphPulse'
import type { ClusterMenuState, FolderMenuState } from './types'
import styles from './GraphView.module.scss'

// The subtree-cascading folder INCLUSION algebra (dirSelected/toggleFolder) is
// shared with the Feed facet (#93/#109) — see libs/tree/selectedFolders.

type GraphViewProps = {
  onOpen: (id: string) => void
  onCreateFromGhost: (node: GraphNode) => void
  theme: string
  railOpen: boolean
  railNarrow: boolean
  onToggleRail: () => void
  initialFocusId: string | null
  onFocusConsumed?: () => void
}

export const GraphView = ({
  onOpen,
  onCreateFromGhost,
  theme,
  railOpen,
  railNarrow,
  onToggleRail,
  initialFocusId,
  onFocusConsumed,
}: GraphViewProps) => {
  const { data, error, syncStatus } = useGraphData()

  // "How to show" — presentation controls, housed in the aside's Display tab (the
  // set outgrew a canvas chip once Size joined Group). Grouping drives node colour +
  // spatial clustering; sizeBy drives the node-size metric, sizeScale its overall
  // multiplier (the "Node size" slider). Default grouping is the link-clusters
  // (#62): colour = community, size = degree is the overview's story, and the
  // server pre-layout anchors by community to match. A saved choice still wins.
  const [groupBy, setGroupBy] = useState(
    () => localStorage.getItem(STORAGE_KEYS.graphGroupBy) || 'community',
  )
  const [sizeBy, setSizeBy] = useState(
    () => localStorage.getItem(STORAGE_KEYS.graphSizeBy) || 'connections',
  )
  const [sizeScale, setSizeScale] = useState(
    () => Number(localStorage.getItem(STORAGE_KEYS.graphSizeScale)) || 1,
  )
  const [spacing, setSpacing] = useState(
    () => Number(localStorage.getItem(STORAGE_KEYS.graphSpacing)) || 1,
  )

  // Right aside hosts two views: "Focus" (locate a note, move the camera to it) and
  // "Filters" (what to show). One panel, switched by tabs — the locator's result list
  // needs somewhere that doesn't cover the canvas it's lighting up. "Focus" (not
  // "Search") keeps it a noun beside "Filters" and avoids colliding with the global
  // note search (#31); it also names the behaviour: focus on a node, don't filter.
  const [filtersOpen, setFiltersOpen] = useState(
    () => localStorage.getItem(STORAGE_KEYS.graphFilters) === '1',
  )
  const [asideTab, setAsideTab] = useState(
    () => localStorage.getItem(STORAGE_KEYS.graphTab) || 'display',
  )
  // Tri-state predicate facets (each: 'any' = no constraint). Connections filters by
  // total degree; dead-links by whether a note has unresolved outgoing links.
  const [conn, setConn] = useState(() => localStorage.getItem(STORAGE_KEYS.graphConn) || 'any') // any | connected | isolated
  const [dead, setDead] = useState('any') // any | with | without
  const [tag, setTag] = useState('any') // any | tagged | untagged (from the node's own tags, #109)
  const [tagSel, setTagSel] = useState<Set<string>>(() => new Set()) // specific tags (folded), OR-matched (#109 part C)
  const [minInDeg, setMinInDeg] = useState(0)
  const [selected, setSelected] = useState<Set<string>>(() => new Set()) // selected folder paths (inclusion, subtree-cascading)
  const [treeOpen, setTreeOpen] = useState<Set<string>>(() => new Set()) // expanded folder rows
  const [folderMenu, setFolderMenu] = useState<FolderMenuState | null>(null) // { x, y, node } for the row context menu
  const [selectedClusters, setSelectedClusters] = useState<Set<number>>(() => new Set()) // selected cluster ids (inclusion)
  const [clusterMenu, setClusterMenu] = useState<ClusterMenuState | null>(null) // { x, y, id } for the cluster row menu
  const [query, setQuery] = useState('')
  const [focusId, setFocusId] = useState<string | null>(null) // search-picked node (persistent camera focus)
  const [listHover, setListHover] = useState<string | null>(null) // node hovered in the aside list → lit on the graph

  // The search field and the pinned focus are independent concerns: the field only
  // owns the query (its × / Esc clears the text, not the focus), and the focus has its
  // own reset in the Focused header. So typing or clearing the search leaves a pinned
  // focus intact — emptying the query just returns to its Focused/Connections view.
  // A pick (below) sets the focus AND clears the query so that view shows at once.
  const changeQuery = (q: string) => setQuery(q)
  const clearSearch = () => setQuery('')

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.graphGroupBy, groupBy)
  }, [groupBy])
  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.graphSizeBy, sizeBy)
  }, [sizeBy])
  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.graphSizeScale, String(sizeScale))
  }, [sizeScale])
  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.graphSpacing, String(spacing))
  }, [spacing])
  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.graphFilters, filtersOpen ? '1' : '0')
  }, [filtersOpen])
  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.graphTab, asideTab)
  }, [asideTab])
  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.graphConn, conn)
  }, [conn])

  // Entering the graph via "open in graph" from a note's local graph: pin that note
  // as the focus, then consume the one-shot so a later plain visit doesn't re-focus a
  // stale note. We deliberately DON'T force the aside open — the focus reads on the
  // canvas on its own; we only pre-select the Focus tab so it's the relevant one if
  // the user does open the panel. The camera centres on the node in ForceGraphCanvas
  // once it has a position (its focusId effect).
  useEffect(() => {
    if (!initialFocusId) {
      return
    }
    setFocusId(initialFocusId)
    setQuery('')
    setAsideTab('focus')
    onFocusConsumed?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialFocusId])

  // Expand the top-level folders once the graph arrives, so the tree opens to a
  // useful first level instead of all-collapsed.
  const treeSeeded = useRef(false)

  // In-degree (how referenced) per node, over the full graph — drives the hubs
  // filter and is the same signal the canvas sizes nodes by.
  const inDeg = useMemo(() => computeInDegree(data?.links ?? []), [data])
  const maxInDeg = useMemo(() => Math.max(0, ...[...inDeg.values()]), [inDeg])

  // In-degree distribution over real notes (bucket d = how many notes have exactly
  // d incoming links) — the histogram behind the "Min links in" slider.
  const inDegHist = useMemo<number[] | null>(
    () => (!data || maxInDeg === 0 ? null : inDegHistogram(data.nodes, inDeg, maxInDeg)),
    [data, inDeg, maxInDeg],
  )

  // Stable colour map over ALL groups, so a folder keeps its colour even when other
  // folders are filtered out (recomputing over the filtered set would reshuffle hues).
  const groupColors = useMemo(
    () => buildGroupColors(data?.nodes || [], theme === 'dark'),
    [data, theme],
  )

  // Link-communities (Louvain) — the graph-native grouping. Computed server-side
  // in the snapshot since #62 and shipped on each node (`community`); here it's
  // just re-indexed into the map the filters/colours read. Clusters double as a
  // *filter* axis available in any grouping mode (the symmetric counterpart to
  // the folder filter).
  const communityMap = useMemo(() => (data ? computeCommunityMap(data.nodes) : null), [data])
  const communityColors = useMemo(() => {
    if (!communityMap) {
      return new Map<number, string>()
    }
    const ids = [...new Set(communityMap.values())].sort((a, b) => a - b)
    return buildPalette(ids, theme === 'dark')
  }, [communityMap, theme])

  // The active grouping fed to the canvas: which node→group function and which
  // palette. Folder is the default (function omitted → canvas uses its folder key);
  // community injects the Louvain map. Colour always follows the active grouping.
  // Memoised so its identity is stable across unrelated re-renders (e.g. hovering a
  // result row): the canvas keys its force-tuning effect on this fn, and a fresh
  // closure each render would reheat the simulation and make the graph jump. Group
  // keys are stringified at this seam so the canvas works in one key type (folders
  // are already strings; community ids are numbers).
  const canvasGroupOf = useMemo<((node: GraphNode) => string | null) | undefined>(
    () =>
      groupBy === 'community' && communityMap
        ? (n) => {
            const c = communityMap.get(n.id)
            return c == null ? null : String(c)
          }
        : undefined,
    [groupBy, communityMap],
  )
  const canvasGroupColors = useMemo<Map<string, string>>(() => {
    if (groupBy === 'community') {
      return new Map([...communityColors].map(([k, v]) => [String(k), v]))
    }

    return groupColors
  }, [groupBy, communityColors, groupColors])

  // Cluster list — each cluster labelled by its most-referenced member (its hub), so
  // "cluster around Roadmap 2026" reads instead of "community 3". Drives BOTH the
  // canvas colour legend (when grouping by clusters) and the aside cluster filter
  // (always), so the two never disagree. Built whenever the communities exist.
  const clusterList = useMemo<ClusterWithColor[]>(
    () =>
      communityMap && data
        ? buildClusterList(data.nodes, communityMap, inDeg, communityColors)
        : [],
    [communityMap, data, inDeg, communityColors],
  )

  // Flat "tree" of clusters for the shared FolderTree in filter mode — reusing the
  // same row anatomy (swatch + name + count, off-dimming, right-click menu) as the
  // folder filter, so the two read identically. path = the cluster id (as string).
  const clusterNodes = useMemo<FolderNode[]>(
    () =>
      clusterList.map((c) => ({ name: c.label, path: String(c.id), count: c.size, children: [] })),
    [clusterList],
  )

  // Folder visibility tree — the same nested structure (and builder) the Feed uses,
  // so the two pages share one explorer. Colour is a pure overlay: each row's swatch
  // is the cluster colour its notes carry on the canvas (deep folders inherit their
  // ancestor group's hue), while show/hide is a plain path-prefix filter.
  const folderTree = useMemo(
    () => buildFolderTree((data?.nodes || []).filter((n) => !n.ghost)),
    [data],
  )
  const colorOf = (path: string) => groupColors.get(groupKeyOfPath(path)) || 'var(--text-faint)'

  // A node's colour under the *active* grouping — folder hue, community hue, or
  // neutral when grouping is off — so the Focus list dots track Group by exactly like
  // the canvas and the Filters swatches (which they didn't: they were folder-only).
  const nodeColor = (n: GraphNode): string => {
    if (groupBy === 'community') {
      const c = communityMap?.get(n.id)
      return (c != null ? communityColors.get(c) : undefined) || 'var(--text-faint)'
    }
    if (groupBy === 'folder') {
      const k = groupKey(n)
      return (k != null ? groupColors.get(k) : undefined) || 'var(--text-faint)'
    }

    return 'var(--text-faint)' // none
  }

  useEffect(() => {
    if (!treeSeeded.current && folderTree.length) {
      setTreeOpen(new Set(folderTree.map((f) => f.path)))
      treeSeeded.current = true
    }
  }, [folderTree])

  // Notes that point at a ghost — the "only with unresolved" subset.
  const linksToGhost = useMemo(
    () => (data ? computeLinksToGhost(data.nodes, data.links) : new Set<string>()),
    [data],
  )

  const ghosts = useMemo(() => (data ? data.nodes.filter((n) => n.ghost) : []), [data])

  // Tags ride the graph payload now (#109) — read straight from the node, no lazy
  // per-node preview sweep. The specific-tag facet (part C) is the SAME hierarchical
  // shape the Feed aside builds (buildTagFacet, shared with the server's /tags), so
  // the graph's tag pane and the Feed's read identically.
  const realIds = useMemo(
    () => (data ? data.nodes.filter((n) => !n.ghost).map((n) => n.id) : []),
    [data],
  )
  const tagFacetNodes = useMemo(
    () => buildTagFacet((data?.nodes ?? []).filter((n) => !n.ghost).map((n) => n.tags)).tags,
    [data],
  )
  const toggleTagSel = (t: string) =>
    setTagSel((prev) => {
      const next = new Set(prev)

      if (next.has(t)) {
        next.delete(t)
      } else {
        next.add(t)
      }

      return next
    })

  // Word counts are likewise off-payload (a read per note); fetch them lazily only
  // while sizing by words, through the same shared snippet cache. Until they land a
  // node has no entry → ForceGraphCanvas treats it as 0 (uniform-ish), so nodes
  // inflate to their content size as the bodies stream in.
  const sizeByWords = sizeBy === 'words'
  const wordsMap = useBulkWords(realIds, sizeByWords)

  // The pinned focus note and the notes it connects to — the textual companion to the
  // canvas "star" that the Focus tab shows when a node is focused but nothing is being
  // searched. Connections are the focal node's real links over the whole graph.
  const focusNode = useMemo(
    () => (data && focusId ? data.nodes.find((n) => n.id === focusId) || null : null),
    [data, focusId],
  )
  const focusNeighbors = useMemo(
    () => (data && focusId ? computeFocusNeighbors(data.nodes, data.links, focusId) : []),
    [data, focusId],
  )

  // What the canvas simulates: the FULL graph, copied once per payload (the
  // force engine mutates its input — link endpoints hydrate into node refs,
  // positions land on nodes — and `data` must stay pristine for the memos
  // above). Filters do NOT touch this object (#62): they produce the
  // `visibleIds` mask below, so toggling them never rebuilds the dataset,
  // never reheats the simulation, and the map doesn't jump.
  const graph = useMemo(() => {
    if (!data) {
      return { nodes: [] as GraphNode[], links: [] as GraphLink[] }
    }

    return { nodes: data.nodes.map((n) => ({ ...n })), links: data.links.map((l) => ({ ...l })) }
  }, [data])

  // The filter mask: every facet ANDs into "is this node visible". null = no
  // active constraint (the canvas skips the set lookups entirely).
  const visibleIds = useMemo<Set<string> | null>(
    () =>
      data
        ? computeVisibleIds(data, {
            selected,
            selectedClusters,
            communityMap,
            conn,
            dead,
            linksToGhost,
            tag,
            tagSel,
            inDeg,
            minInDeg,
          })
        : null,
    [
      data,
      conn,
      dead,
      tag,
      tagSel,
      minInDeg,
      selected,
      inDeg,
      linksToGhost,
      communityMap,
      selectedClusters,
    ],
  )

  // The pulse plays what's actually on screen: the visible slice of the graph,
  // lit by the grouping the canvas is colouring it with. Sampled when the gesture
  // fires, so no filter tweak re-binds anything.
  const pulse = useGraphPulse(() => ({
    graph: {
      nodes: graph.nodes.filter((n) => !visibleIds || visibleIds.has(n.id)),
      links: graph.links.filter(
        (l) => !visibleIds || (visibleIds.has(idOf(l.source)) && visibleIds.has(idOf(l.target))),
      ),
    },
    groupOf: canvasGroupOf || groupKey,
  }))

  const stats = data
    ? {
        real: data.nodes.filter((n) => !n.ghost).length,
        ghost: ghosts.length,
        orphan: data.nodes.filter((n) => !n.ghost && (n.degree || 0) === 0).length,
        links: data.links.length,
      }
    : null

  // What's actually on the canvas after the filters — the mini-stat cards show this
  // live, with the total trailing as muted context only when it differs. Ghosts are
  // always rendered, so the unresolved count never narrows and stays the total.
  const shown = useMemo(() => (data ? countShown(data, visibleIds) : null), [data, visibleIds])

  // Search over the *visible* graph (client-side, no backend) so every match is
  // actually focusable. `ids` drives the canvas spotlight (all matches), `list` is the
  // ranked dropdown (title-prefix first, then hubs), and `hidden` counts matches the
  // active filters are keeping out of view — surfaced as a hint so a "no result" for a
  // note you know exists is explained rather than mysterious. The scan runs on a
  // debounced echo of the query, so fast typing costs one pass, not one per key.
  const [scanQuery, setScanQuery] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setScanQuery(query), GRAPH_SCAN_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [query])
  const search = useMemo(
    () =>
      data ? scanGraph(data.nodes, scanQuery, visibleIds) : { ids: null, list: [], hidden: 0 },
    [scanQuery, data, visibleIds],
  )

  // Folder selection toggles — the shared subtree-cascading inclusion algebra
  // (libs/tree). A click adds a folder to the focus; empty = no filter.
  const toggleFolder = (path: string) => setSelected((prev) => toggleFolderSet(prev, path))
  // "Only this folder": select just this one (its whole subtree, nothing else).
  const soloFolder = (path: string) => setSelected(new Set([path]))

  // Reset the folder filter to its default view: nothing selected (all visible),
  // expansion back to the seeded top level.
  const resetFolders = () => {
    setSelected(new Set())
    setTreeOpen(new Set(folderTree.map((f) => f.path)))
  }
  const toggleFolderOpen = (path: string) =>
    setTreeOpen((prev) => {
      const next = new Set(prev)

      if (next.has(path)) {
        next.delete(path)
      } else {
        next.add(path)
      }

      return next
    })

  // Per-row actions live in a context menu (right-click), so the row stays a clean
  // swatch + name + count with nothing overlapping the count.
  const openFolderMenu = (e: ReactMouseEvent, node: FolderNode) => {
    e.preventDefault()
    setFolderMenu({ x: e.clientX, y: e.clientY, node })
  }

  const folderMenuItems = (node: FolderNode): MenuItem[] => {
    const on = selected.has(node.path)
    const items: MenuItem[] = [
      {
        label: 'Show only this folder',
        icon: <IconCrosshair size={15} />,
        onClick: () => soloFolder(node.path),
      },
      {
        label: on ? 'Exclude this folder' : 'Include this folder',
        icon: on ? <IconEyeOff size={15} /> : <IconEye size={15} />,
        onClick: () => toggleFolder(node.path),
      },
    ]

    if (selected.size > 0) {
      items.push(
        { divider: true },
        { label: 'Clear filter', icon: <IconX size={15} />, onClick: resetFolders },
      )
    }

    return items
  }

  // Cluster selection — the same toggle/solo/reset model as folders, but flat (no
  // subtree): toggle one, solo (select only this cluster), or clear. Inclusion: a
  // click adds the cluster to the focus; empty = no filter.
  const toggleCluster = (id: number) =>
    setSelectedClusters((prev) => {
      const next = new Set(prev)

      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }

      return next
    })
  const soloCluster = (id: number) => setSelectedClusters(new Set([id]))
  const resetClusters = () => setSelectedClusters(new Set())

  const openClusterMenu = (e: ReactMouseEvent, node: FolderNode) => {
    e.preventDefault()
    setClusterMenu({ x: e.clientX, y: e.clientY, id: Number(node.path) })
  }

  const clusterMenuItems = (id: number): MenuItem[] => {
    const on = selectedClusters.has(id)
    const items: MenuItem[] = [
      {
        label: 'Show only this cluster',
        icon: <IconCrosshair size={15} />,
        onClick: () => soloCluster(id),
      },
      {
        label: on ? 'Exclude this cluster' : 'Include this cluster',
        icon: on ? <IconEyeOff size={15} /> : <IconEye size={15} />,
        onClick: () => toggleCluster(id),
      },
    ]

    if (selectedClusters.size > 0) {
      items.push(
        { divider: true },
        { label: 'Clear filter', icon: <IconX size={15} />, onClick: resetClusters },
      )
    }

    return items
  }

  // The filters toggle lives in two places, so it takes two skins of the shared
  // IconToggle: a floating `chip` over the canvas while collapsed, and a plain
  // `ghost` in the aside header once expanded (no plashka on a bar — like the
  // doc view). Both carry the same active highlight.
  const filtersToggle = (variant: 'ghost' | 'chip') => (
    <IconToggle
      variant={variant}
      icon={<IconPanelRight size={15} />}
      active={filtersOpen}
      onClick={() => setFiltersOpen((o) => !o)}
      title={filtersOpen ? 'Collapse panel' : 'Open panel'}
    />
  )

  return (
    <div className={styles.graphView}>
      {/* Entering the canvas region kills any lingering aside hover, the mirror of the
          canvas clearing its own hover on pointer-leave. Without it, landing the cursor
          straight from a Focus row onto a node (e.g. one half-clipped at the aside edge)
          let the stale row hover keep winning the highlight until you moved to a second
          node — the two hover sources must be mutually exclusive, not race on priority. */}
      <div className={styles.graphWrap} onPointerEnter={() => setListHover(null)}>
        {error && (
          <div className={styles.graphError}>
            <Notice variant="error">{error}</Notice>
          </div>
        )}

        <div className={styles.graphOverlay}>
          {/* Sidebar collapse/expand — same toggle as the doc-view topbar, in the
              floating `chip` skin so it reads the same but stays legible over the
              canvas. */}
          <IconToggle
            variant="chip"
            icon={<IconPanelLeft size={15} />}
            active={railOpen}
            onClick={onToggleRail}
            title={
              railNarrow
                ? railOpen
                  ? 'Close sidebar'
                  : 'Open sidebar'
                : railOpen
                  ? 'Collapse sidebar'
                  : 'Expand sidebar'
            }
          />
          {/* Presentation controls (Group/Size/…) moved into the aside's Display
              tab — the set outgrew a canvas chip — so the overlay stays light. */}
        </div>

        {/* Panel toggle, top-right, mirroring the doc-view panel toggle. */}
        {!filtersOpen && <div className={styles.graphOverlayRight}>{filtersToggle('chip')}</div>}

        <ForceGraphCanvas
          graph={graph}
          theme={theme}
          // No `activeId` here: on the overview the "current" node is the pinned focus
          // (focusId), nothing else. Forwarding the app's open-note id ringed whatever
          // note you'd last read — an artefact that lingered after navigating to /graph,
          // not a focus state. The local-graph panel still passes its own activeId.
          onOpen={onOpen}
          onFocus={(n) => setFocusId(n.id)}
          onCreateFromGhost={onCreateFromGhost}
          groupBy={groupBy}
          groupOf={canvasGroupOf}
          cluster={groupBy !== 'none'}
          groupColors={canvasGroupColors}
          sizeBy={sizeBy}
          sizeData={sizeByWords ? wordsMap : null}
          sizeScale={sizeScale}
          spacing={spacing + SPACING_SHIFT}
          focusId={focusId}
          matchIds={search.ids}
          externalHover={filtersOpen && asideTab === 'focus' ? listHover : null}
          visibleIds={visibleIds}
          pulse={pulse}
        />

        {/* Only the failure case keeps an on-canvas chip — warm-up progress
            moved to the global sidebar indicator (#60), so a partial-but-honest
            graph no longer wears a banner. Usually the cold-start race (engine
            still coming up) — the scan retries itself, so phrase it as a wait,
            not a failure. */}
        {syncStatus?.scan.phase === SCAN_PHASE.error && (
          <div className={`${styles.syncChip} glass glass-float`} data-testid="graph-sync-chip">
            Waiting for the knowledge engine — retrying…
          </div>
        )}
      </div>

      {filtersOpen && (
        <Aside
          tabs={[
            { id: 'display', label: 'Display' },
            { id: 'filters', label: 'Filters' },
            { id: 'focus', label: 'Focus' },
          ]}
          activeTab={asideTab}
          onTabChange={setAsideTab}
          headerAction={filtersToggle('ghost')}
        >
          {asideTab === 'display' && (
            <div className={styles.gf}>
              {/* "How to show" — presentation, distinct from the Filters tab's
                  "what to show". Group by drives node colour + clustering; Size by
                  the node-size metric; Node size the overall multiplier. */}
              <div className="gf-section">Group by</div>
              <Segmented
                block
                value={groupBy}
                onChange={setGroupBy}
                ariaLabel="Group by"
                options={[
                  { value: 'none', label: 'None' },
                  { value: 'folder', label: 'Folder' },
                  {
                    value: 'community',
                    label: 'Clusters',
                    title: 'Group by how notes link — link-clusters (Louvain communities)',
                  },
                ]}
              />

              {/* Size by — Words is lazy (fetches bodies in the background, progress
                  shown), reusing the Feed/Tags snippet cache. */}
              <div className="gf-section">
                <span>Size by</span>
                {sizeByWords && wordsMap.size < realIds.length && (
                  <span className={styles.muted}>
                    {wordsMap.size}/{realIds.length}
                  </span>
                )}
              </div>
              <Segmented
                block
                value={sizeBy}
                onChange={setSizeBy}
                ariaLabel="Size by"
                options={[
                  { value: 'uniform', label: 'None', title: 'All nodes the same size' },
                  {
                    value: 'connections',
                    label: 'Links',
                    title: 'Total connections — incoming + outgoing links',
                  },
                  {
                    value: 'references',
                    label: 'Refs',
                    title: 'Backlinks — how many notes link to it (how referenced)',
                  },
                  {
                    value: 'words',
                    label: 'Words',
                    title: 'Word count — content size (loads note bodies)',
                  },
                ]}
              />

              {/* Overall node-size multiplier — solves "the spread is too subtle" and
                  lets you dial it live. A plain headless slider (no distribution). */}
              <div className="gf-section">
                <span>
                  Node size
                  <span className={styles.muted}>&nbsp;&nbsp;{Math.round(sizeScale * 100)}%</span>
                </span>
              </div>
              <Slider min={0.4} max={2} step={0.1} value={sizeScale} onChange={setSizeScale} />

              {/* Spacing — scales the layout forces (repulsion + edge length) for a
                  tighter ↔ looser graph. Changing it re-runs the simulation. */}
              <div className="gf-section">
                <span>
                  Spacing
                  <span className={styles.muted}>&nbsp;&nbsp;{Math.round(spacing * 100)}%</span>
                </span>
              </div>
              <Slider min={0.5} max={2.5} step={0.1} value={spacing} onChange={setSpacing} />
            </div>
          )}
          {asideTab === 'focus' && (
            <GraphSearch
              query={query}
              onQueryChange={changeQuery}
              onClear={clearSearch}
              results={search.list}
              matchCount={search.ids ? search.ids.size : 0}
              hiddenCount={search.hidden}
              colorOf={nodeColor}
              onPick={(n) => {
                setFocusId(n.id)
                setQuery('')
              }}
              activeId={focusId}
              focusNode={focusNode}
              focusNeighbors={focusNeighbors}
              onClearFocus={() => setFocusId(null)}
              onRowHover={setListHover}
            />
          )}
          {asideTab === 'filters' && (
            <div className={styles.gf}>
              {/* Dataset summary — mini-stats, like the Feed aside. Totals over the
                whole graph (not the filtered view), the same way Feed's counts are. */}
              {stats && shown && (
                <MiniStats>
                  <MiniStat
                    value={shown.real}
                    of={shown.real !== stats.real ? stats.real : undefined}
                    label="notes"
                  />
                  <MiniStat
                    value={shown.links}
                    of={shown.links !== stats.links ? stats.links : undefined}
                    label="links"
                  />
                  {stats.ghost > 0 && <MiniStat value={stats.ghost} label="unresolved" />}
                </MiniStats>
              )}

              {/* Connections — filter by total degree (your "with/without links"). */}
              <div className="gf-section">Connections</div>
              <Segmented
                block
                value={conn}
                onChange={setConn}
                ariaLabel="Connections"
                options={[
                  { value: 'any', label: 'All' },
                  { value: 'connected', label: 'Connected' },
                  { value: 'isolated', label: 'Isolated' },
                ]}
              />

              {/* Dead links — notes with unresolved outgoing links (only meaningful
                when the base has any). Missing-note placeholders are always shown on
                the canvas, so there's no toggle here. */}
              {(stats?.ghost ?? 0) > 0 && (
                <>
                  <div className="gf-section">Dead links</div>
                  <Segmented
                    block
                    value={dead}
                    onChange={setDead}
                    ariaLabel="Dead links"
                    options={[
                      { value: 'any', label: 'All' },
                      { value: 'with', label: 'With' },
                      { value: 'without', label: 'Without' },
                    ]}
                  />
                </>
              )}

              {/* Tags (#109): one section. The tri-state (All/Tagged/Untagged) is the
                has-any-tag axis; the specific-tag pane below it is the SHARED
                hierarchical-chips widget (identical to the Feed aside, hideHead so the
                section owns the header). A node is shown if it carries ANY selected
                tag (OR), matched hierarchically. The reset clears both. */}
              <div className="gf-section">
                Tags
                <button
                  className="gf-section-reset"
                  onClick={() => {
                    setTagSel(new Set())
                    setTag('any')
                  }}
                  disabled={tagSel.size === 0 && tag === 'any'}
                  title="Clear tag filter"
                  aria-label="Clear tag filter"
                >
                  <IconX size={13} />
                </button>
              </div>
              <Segmented
                block
                value={tag}
                onChange={setTag}
                ariaLabel="Tags"
                options={[
                  { value: 'any', label: 'All' },
                  { value: 'tagged', label: 'Tagged' },
                  { value: 'untagged', label: 'Untagged' },
                ]}
              />
              <TagFilter
                tags={tagFacetNodes}
                selected={tagSel}
                onToggle={toggleTagSel}
                onClear={() => setTagSel(new Set())}
                padded={false}
                hideHead
                testId="graph-tag-filter"
              />

              {/* Hubs: minimum in-degree, with the in-degree distribution behind it.
                Heading is a plain section header (like Folders/Show); the slider is
                headless and the value rides along as a muted count. */}
              {maxInDeg > 0 && (
                <>
                  <div className="gf-section">
                    <span>
                      Min links in<span className={styles.muted}>&nbsp;&nbsp;{minInDeg}</span>
                    </span>
                  </div>
                  <Slider
                    min={0}
                    max={maxInDeg}
                    value={minInDeg}
                    onChange={setMinInDeg}
                    distribution={inDegHist}
                  />
                </>
              )}

              {/* Folder visibility — the shared FolderTree in filter mode (colour
                swatch = on/off toggle; per-row actions via right-click). The reset
                "×" holds a fixed slot so the header never shifts. */}
              {folderTree.length > 0 && (
                <>
                  <div className="gf-section">
                    Folders
                    <button
                      className="gf-section-reset"
                      onClick={resetFolders}
                      disabled={selected.size === 0}
                      title="Clear folder filter"
                      aria-label="Clear folder filter"
                    >
                      <IconX size={13} />
                    </button>
                  </div>
                  <FolderTree
                    nodes={folderTree}
                    expanded={treeOpen}
                    onToggleExpand={toggleFolderOpen}
                    isSelected={(p) => selected.has(p)}
                    onToggle={toggleFolder}
                    onRowContextMenu={openFolderMenu}
                    colorOf={groupBy === 'folder' ? colorOf : () => 'var(--text-faint)'}
                  />
                </>
              )}

              {/* Cluster visibility — the link-community filter, symmetric to Folders
                and available in any grouping mode. Swatches carry the cluster palette
                only while colouring by clusters; otherwise they're neutral toggles,
                so just one palette is ever live (canvas + its matching section). */}
              {clusterNodes.length > 0 && (
                <>
                  <div className="gf-section">
                    <span>
                      Clusters
                      <span className={styles.muted}>&nbsp;·&nbsp;{clusterList.length}</span>
                    </span>
                    <button
                      className="gf-section-reset"
                      onClick={resetClusters}
                      disabled={selectedClusters.size === 0}
                      title="Clear cluster filter"
                      aria-label="Clear cluster filter"
                    >
                      <IconX size={13} />
                    </button>
                  </div>
                  <FolderTree
                    nodes={clusterNodes}
                    expanded={treeOpen}
                    onToggleExpand={() => {}}
                    isSelected={(p) => selectedClusters.has(Number(p))}
                    onToggle={(p) => toggleCluster(Number(p))}
                    onRowContextMenu={openClusterMenu}
                    colorOf={
                      groupBy === 'community'
                        ? (p) => communityColors.get(Number(p)) || 'var(--text-faint)'
                        : () => 'var(--text-faint)'
                    }
                  />
                </>
              )}
            </div>
          )}
        </Aside>
      )}

      {folderMenu && (
        <ContextMenu
          x={folderMenu.x}
          y={folderMenu.y}
          items={folderMenuItems(folderMenu.node)}
          onClose={() => setFolderMenu(null)}
        />
      )}

      {clusterMenu && (
        <ContextMenu
          x={clusterMenu.x}
          y={clusterMenu.y}
          items={clusterMenuItems(clusterMenu.id)}
          onClose={() => setClusterMenu(null)}
        />
      )}
    </div>
  )
}
