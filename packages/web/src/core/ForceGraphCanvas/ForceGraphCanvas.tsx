import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
} from 'd3-force-3d'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import ForceGraph2D from 'react-force-graph-2d'
// The force model is shared with the server-side layout pass (#62): the same
// constants tune the live simulation here and the snapshot pre-layout in core,
// so the positions the server ships are already at rest for THIS simulation.
import {
  CHARGE_DISTANCE_MAX,
  chargeStrength,
  CLUSTER_STRENGTH,
  clusterAngles,
  clusterRingRadius,
  COLLIDE_PAD,
  LINK_GAP,
  LINK_STRENGTH,
  MIN_CLUSTER_GROUPS,
  VELOCITY_DECAY,
} from '@notarium/core/force-model'
import { buildGroupColors, groupKey } from '../../libs/graph/graphColors'
import { idOf } from '../../libs/graph/graphId'
import type { PulseGlow } from '../../libs/graph/graphPulse'
import type { GraphNodeView as GraphNode } from '../../libs/wire'
import {
  ADOPT_ALPHA_DECAY,
  ADOPT_TICKS,
  EDGE_LOD_LINKS,
  EDGE_ZOOM,
  FOCUS_MAX_ZOOM,
  FOCUS_PADDING,
  GESTURE_SETTLE_MS,
  PULSE_COLD_DARK,
  PULSE_COLD_LIGHT,
  PULSE_FLOOR,
  PULSE_FLOOR_REDUCED,
  TIDY_HIDDEN_FRACTION,
} from './consts'
import { mix, toRgb } from './helpers/color'
import { roundRect } from './helpers/roundRect'
import { mergeServerRefresh } from './helpers/serverRefresh'
import { useNodeMetrics } from './hooks/useNodeMetrics'
import { useThemePalette } from './hooks/useThemePalette'
import type { FgMethods, GraphInput, SimLink, SimNode } from './types'
import styles from './ForceGraphCanvas.module.scss'

type ForceGraphCanvasProps = {
  graph: GraphInput
  theme?: string
  activeId?: string | null
  onOpen: (id: string) => void
  onFocus?: ((node: GraphNode) => void) | null
  onCreateFromGhost?: (node: GraphNode) => void
  groupBy?: string
  groupOf?: ((node: GraphNode) => string | null) | null
  cluster?: boolean
  groupColors?: Map<string, string> | null
  focusId?: string | null
  matchIds?: Set<string> | null
  fitPadding?: number
  maxZoom?: number
  sizeBy?: string
  sizeData?: Map<string, number> | null
  sizeScale?: number
  spacing?: number
  externalHover?: string | null
  /** Filtered view (#62): ids that should render. null/undefined = everything.
   *  Visibility is a paint-time mask — the graph object and the simulation keep
   *  ALL nodes, so toggling filters never rebuilds or reheats anything and every
   *  node keeps its place. */
  visibleIds?: ReadonlySet<string> | null
  /** A running pulse: while set, nodes are painted by their beat glow instead of
   *  the usual emphasis. Null the rest of the time. */
  pulse?: PulseGlow | null
}

// Shared force-graph renderer. Owns sizing, hover highlighting, fit/zoom
// controls and node/link drawing so both the full-screen GraphView and the
// docked GraphPanel render identically — only the graph slice differs.
export const ForceGraphCanvas = ({
  graph,
  theme,
  activeId,
  onOpen,
  onFocus = null,
  onCreateFromGhost,
  groupBy = 'folder',
  groupOf = null,
  cluster = false,
  groupColors: groupColorsProp = null,
  focusId = null,
  matchIds = null,
  fitPadding = 80,
  maxZoom = Infinity,
  sizeBy = 'connections',
  sizeData = null,
  sizeScale = 1,
  spacing = 1,
  externalHover = null,
  visibleIds = null,
  pulse = null,
}: ForceGraphCanvasProps) => {
  // The grouping function — node → group key — drives BOTH the node colour and the
  // spatial clustering, so colour always reads the active grouping. Defaults to the
  // folder key, which is what the local-graph panel relies on (it passes neither
  // prop and just colours by folder within its slice).
  const groupFn: (node: SimNode) => string | null = groupOf || groupKey
  // E2E flag: only used to suppress the animated zoom-to-node on focus, so visual
  // snapshots stay on the deterministic overview fit (focus reads as emphasis). The
  // simulation/rendering is otherwise unchanged.
  const testMode = typeof window !== 'undefined' && !!window.__NOTARIUM_TEST__
  const wrapRef = useRef<HTMLDivElement>(null)
  const fgRef = useRef<FgMethods>()
  const fittedRef = useRef(false)
  const touchedRef = useRef(false)
  const fittingRef = useRef(false)
  const viewRef = useRef<{ x: number; y: number; k: number } | null>(null) // world camera, captured ONCE per resize gesture, held steady
  const settleRef = useRef<ReturnType<typeof setTimeout> | null>(null) // idle timer that ends a resize gesture (lets the anchor refresh)
  const [size, setSize] = useState({ w: 320, h: 320 })
  const [hover, setHover] = useState<string | null>(null)

  // ── Filtered view (#62) ──────────────────────────────────────────────────────
  // Visibility is a mask over an unchanged graph: nodeVisibility/linkVisibility
  // read it at paint time, so filters never rebuild the graph object, never
  // touch the simulation, and positions stay put.
  const isVisible = useCallback((id: string) => !visibleIds || visibleIds.has(id), [visibleIds])
  const visibleCount = visibleIds ? visibleIds.size : graph.nodes.length
  const hiddenFraction = graph.nodes.length ? 1 - visibleCount / graph.nodes.length : 0

  // ── Server layout adoption (#62) ─────────────────────────────────────────────
  // A graph whose nodes ALL carry positions was laid out at snapshot build; we
  // take those positions as-is instead of boiling our own. The freeze must be in
  // place for the very first engine tick after the data swap, so it's derived
  // during render (a render-phase state update), not in an effect.
  const hasServerLayout = useMemo(
    () =>
      graph.nodes.length > 0 &&
      graph.nodes.every((n) => typeof n.x === 'number' && typeof n.y === 'number'),
    [graph],
  )
  const [adoptingFor, setAdoptingFor] = useState<GraphInput | null>(null)
  const lastAdoptGraph = useRef<GraphInput | null>(null)
  // Newcomer ids of a mid-session refresh, parked for the pinned relax below.
  const refreshFresh = useRef<Set<string> | null>(null)

  if (hasServerLayout && lastAdoptGraph.current !== graph) {
    // A refreshed snapshot mid-session keeps the client's map: merge positions
    // here, render-phase, so the engine's very first ingest of the new data
    // already sees them (an effect would be one painted frame too late).
    refreshFresh.current =
      lastAdoptGraph.current && fittedRef.current
        ? mergeServerRefresh(lastAdoptGraph.current, graph)
        : null
    lastAdoptGraph.current = graph
    setAdoptingFor(graph)
  }
  const adopting = hasServerLayout && adoptingFor === graph

  // ── Edge LOD (#62) ───────────────────────────────────────────────────────────
  const edgeLod = graph.links.length > EDGE_LOD_LINKS
  // Pan/zoom gesture in flight → the bulk edges hide until the camera settles.
  const [gesturing, setGesturing] = useState(false)
  const gestureTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onCameraMove = useCallback(() => {
    if (!edgeLod) {
      return
    }
    setGesturing(true)
    if (gestureTimer.current) {
      clearTimeout(gestureTimer.current)
    }
    gestureTimer.current = setTimeout(() => setGesturing(false), GESTURE_SETTLE_MS)
  }, [edgeLod])
  useEffect(
    () => () => {
      if (gestureTimer.current) {
        clearTimeout(gestureTimer.current)
      }
    },
    [],
  )
  // World-space viewport + zoom, refreshed every frame by the pre-render hook —
  // what the deep-zoom edge pass culls against.
  const viewportRef = useRef<{
    minX: number
    maxX: number
    minY: number
    maxY: number
    k: number
  } | null>(null)

  useEffect(() => {
    const el = wrapRef.current

    if (!el) {
      return
    }
    const measure = () => {
      // Hold the world point at the canvas centre fixed for the whole resize gesture.
      // react-force-graph re-derives its transform from the new size on every width/height
      // tick (synchronously, during the child's render), and tiny per-tick residuals —
      // backing-store rounding at fractional devicePixelRatio, mainly — otherwise pile up
      // into a visible creep when the aside is dragged fast. Capture the centre ONCE at the
      // start of a gesture and keep it (re-capturing each tick let the anchor itself
      // ratchet); the layout effect below restores it after every size change. A short idle
      // timer clears it so a pan/zoom done between gestures is picked up next time.
      const fg = fgRef.current

      if (fittedRef.current && fg && fg.centerAt && !viewRef.current) {
        const c = fg.centerAt()

        if (c && Number.isFinite(c.x)) {
          viewRef.current = { x: c.x, y: c.y, k: fg.zoom() }
        }
      }
      if (settleRef.current) {
        clearTimeout(settleRef.current)
      }
      settleRef.current = setTimeout(() => {
        viewRef.current = null
      }, 250)
      const r = el.getBoundingClientRect()
      setSize({ w: Math.max(120, r.width), h: Math.max(120, r.height) })
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => {
      ro.disconnect()
      if (settleRef.current) {
        clearTimeout(settleRef.current)
      }
    }
  }, [])

  // Re-anchor the camera right after each resize commits. A LAYOUT effect, not passive: the
  // size change drifts the transform during the force-graph child's render, and only a
  // layout effect is guaranteed to run (before paint, on every commit) to correct it —
  // passive effects get deferred under a fast drag, which is exactly when the creep showed.
  useLayoutEffect(() => {
    const fg = fgRef.current
    const v = viewRef.current

    if (!fittedRef.current || !fg || !v || !Number.isFinite(v.x)) {
      return
    }
    fg.centerAt(v.x, v.y, 0)
    fg.zoom(v.k, 0)
  }, [size])

  // Adjacency for hover highlighting.
  const adj = useMemo(() => {
    const m = new Map<string, Set<string>>()

    for (const l of graph.links) {
      const s = idOf(l.source)
      const t = idOf(l.target)

      if (!m.has(s)) {
        m.set(s, new Set())
      }
      if (!m.has(t)) {
        m.set(t, new Set())
      }
      m.get(s)!.add(t)
      m.get(t)!.add(s)
    }

    return m
  }, [graph])

  // New dataset (note / depth / ghost toggle) → fit afresh and forget that the
  // user had grabbed the previous one. Exception: a refreshed server-laid-out
  // snapshot (an SSE refetch mid-session) is the same map with newer data — the
  // camera holds instead of re-fitting.
  useEffect(() => {
    if (hasServerLayout && fittedRef.current) {
      return
    }
    fittedRef.current = false
    touchedRef.current = false
    // hasServerLayout is derived from graph — not an independent trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph])

  // Node sizing (degrees, the active metric and the radius mapping) over the current
  // slice — radiusOf is shared by the renderer, the click hit-area and the collision.
  const { inDeg, metricOf, radiusOf } = useNodeMetrics(graph, sizeBy, sizeData, sizeScale)

  // Tune the d3 forces once the engine exists, re-applying on every dataset swap
  // (react-force-graph reuses one simulation across data changes). The collision
  // force is the most direct fix for nodes — and their labels — overlapping.
  useEffect(() => {
    const fg = fgRef.current

    if (!fg || !graph.nodes.length) {
      return
    }
    // `spacing` (the "Spacing" slider) is one dial for "tighter ↔ looser". It scales
    // every separator at once — repulsion, the edge-length gap and the collision gap
    // — and all three are radius-aware, so raising it opens real air even between
    // large nodes (instead of bottoming out on a fixed pad) and lowering it stays
    // settle-able instead of jittering (edges never demand less room than collision).
    const charge = fg.d3Force('charge')

    if (charge) {
      charge.strength((n: SimNode) => chargeStrength(n) * spacing).distanceMax(CHARGE_DISTANCE_MAX)
    }
    const link = fg.d3Force('link')

    if (link) {
      link
        .distance(
          (l: SimLink) =>
            radiusOf(l.source as SimNode) + radiusOf(l.target as SimNode) + LINK_GAP * spacing,
        )
        .strength(LINK_STRENGTH)
    }
    fg.d3Force(
      'collide',
      forceCollide<SimNode>()
        .radius((n) => radiusOf(n) + COLLIDE_PAD * spacing)
        .iterations(2),
    )

    // Folder clustering: pull each note gently toward its folder-group's slot on a
    // ring around the centre, so the colour groups settle into distinct regions
    // instead of an intermixed blob. Only worthwhile when there are several groups
    // (the full graph); for a tiny local slice we leave it off (strength 0).
    const groups = graph.nodes.map(groupFn).filter((k): k is string => k != null)
    // Cluster only when asked (overview's "Group" toggle) and there are several
    // groups to separate. The local slice never passes the flag — its layout stays
    // link-driven around the active note. Angles/radius come from the shared
    // force model so the server pre-layout anchors clusters identically.
    const doCluster = cluster && new Set(groups).size >= MIN_CLUSTER_GROUPS
    const angleOf = clusterAngles(groups)
    const R = clusterRingRadius(graph.nodes.length, spacing)

    const anchor = (n: SimNode, fn: (a: number) => number) => {
      const g = groupFn(n)
      const a = g == null ? undefined : angleOf.get(g)
      return a == null ? 0 : fn(a) * R
    }
    fg.d3Force(
      'x',
      forceX<SimNode>((n) => anchor(n, Math.cos)).strength(doCluster ? CLUSTER_STRENGTH : 0),
    )
    fg.d3Force(
      'y',
      forceY<SimNode>((n) => anchor(n, Math.sin)).strength(doCluster ? CLUSTER_STRENGTH : 0),
    )

    fg.d3ReheatSimulation()
  }, [graph, radiusOf, cluster, groupFn, spacing])

  // Search focus: centre on the picked node and frame its neighbourhood. The
  // persistent highlight (the node + its neighbours lit, the rest dimmed) is driven by
  // `focusId` in isLit below, not by hijacking `hover` — so it survives the next mouse
  // move instead of vanishing. The camera keeps the node centred but zooms only enough
  // to fit its 1-hop neighbours (the connections), capped by FOCUS_MAX_ZOOM — so this
  // is identical whether the focus comes from a search pick or "open in graph", and you
  // always land seeing the node IN CONTEXT, not a lone dot. Deps stay [focusId, graph]
  // (the only triggers that should move the camera) — size/spacing tweaks must not
  // yank a live focus; the effect reads the latest closures at fire time regardless.
  // Centre + zoom the camera on the focused node so its 1-hop neighbours fit. Pulled
  // out of the effect so the test-hook can re-apply it instantly with the settled size.
  const focusCameraMove = useCallback(
    (duration: number) => {
      if (!focusId) {
        return
      }
      const fg = fgRef.current
      const n = graph.nodes.find((x) => x.id === focusId)

      if (!fg || !n || !Number.isFinite(n.x)) {
        return
      }
      // Symmetric half-extents around the node, so it stays centred while the farthest
      // neighbour still lands inside the frame (circles included).
      let halfW = radiusOf(n),
        halfH = radiusOf(n)

      const extend = (m: SimNode | undefined) => {
        if (!m || !Number.isFinite(m.x)) {
          return
        }
        const r = radiusOf(m)
        halfW = Math.max(halfW, Math.abs(m.x! - n.x!) + r)
        halfH = Math.max(halfH, Math.abs(m.y! - n.y!) + r)
      }
      const neigh = adj.get(focusId)

      if (neigh) {
        for (const id of neigh) {
          extend(graph.nodes.find((x) => x.id === id))
        }
      }
      const w = Math.max(2 * halfW, 1e-3),
        h = Math.max(2 * halfH, 1e-3)
      let k = Math.min((size.w - 2 * FOCUS_PADDING) / w, (size.h - 2 * FOCUS_PADDING) / h)

      if (!Number.isFinite(k) || k <= 0) {
        k = 1
      }
      k = Math.min(k, FOCUS_MAX_ZOOM, maxZoom)
      fg.centerAt(n.x!, n.y!, duration)
      fg.zoom(k, duration)
    },
    [focusId, graph, size, adj, maxZoom, radiusOf],
  )

  useEffect(() => {
    // In E2E the camera stays on the overview fit (focus shows as emphasis), so the
    // zoom-to-node — a non-deterministic animation to snapshot — is suppressed.
    if (!testMode) {
      focusCameraMove(600)
    }
    // Deps stay [focusId, graph] (the only triggers that should move the camera) — a
    // size/spacing tweak must not yank a live focus.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId, graph])

  const dark = theme === 'dark'
  const { accentRgb, bgRgb } = useThemePalette(theme)

  const accent = `rgb(${accentRgb.r}, ${accentRgb.g}, ${accentRgb.b})`
  // Fallback fill for nodes without a group (e.g. a pathless node): the accent
  // muted toward the bg but fully OPAQUE so links stay hidden behind the circle.
  const mutedRgb = mix(accentRgb, bgRgb, 0.45)
  const mutedAccent = `rgb(${mutedRgb.r}, ${mutedRgb.g}, ${mutedRgb.b})`

  // Per-group colour — turns the graph from one uniform blob into coloured groups.
  // Prefer the parent's stable map (so a folder keeps its colour when others are
  // filtered out); fall back to building from this slice (the local-graph panel).
  const localGroupColors = useMemo(() => buildGroupColors(graph.nodes, dark), [graph, dark])
  const groupColors = groupColorsProp || localGroupColors

  const colorOf = (n: SimNode) => {
    const key = groupFn(n)
    return (groupBy !== 'none' && key != null && groupColors.get(key)) || mutedAccent
  }
  const textColor = dark ? '#cfd6e2' : '#33384a'
  const baseLink = dark ? 'rgba(150,160,180,0.22)' : 'rgba(120,130,150,0.28)'
  // A faded link colour for the dimmed background while a spotlight/focus is active.
  const faintLink = dark ? 'rgba(150,160,180,0.07)' : 'rgba(120,130,150,0.09)'
  // A clearly-visible neutral grey for a *pinned* focus's own edges — brighter than
  // baseLink so the focal note's connections trace cleanly out of the dimmed field,
  // yet neutral (not accent) so a live hover still reads as the stronger cue on top.
  const focusLink = dark ? 'rgba(176,184,202,0.55)' : 'rgba(90,100,122,0.5)'
  const ghostColor = dark ? '#5b6270' : '#aab0bd'
  const dotColor = dark ? 'rgba(180,186,202,0.07)' : 'rgba(40,45,60,0.06)'

  // Adaptive "paper" dot grid (the node-editor canvas cue). The world spacing snaps
  // to a power-of-two multiple of BASE so the *on-screen* spacing always lands near
  // DOT_TARGET_PX — the grid refines as you zoom in and coarsens as you zoom out,
  // keeping a constant, bounded density at any zoom and on any graph. (The old fixed
  // world spacing carpeted the screen when a 300-node graph was fitted, so it bailed
  // to nothing — that's why the dots only ever showed up on the tiny local graph.)
  // Every spacing is a subset of the finer one, so the grid stays anchored to world
  // coordinates: it pans with the content and dots never slide. The interleaved
  // half-step dots fade across each octave (smoothstep) so levels blend, not pop.
  const drawDots = (ctx: CanvasRenderingContext2D, scale: number) => {
    const fg = fgRef.current
    const c = fg && fg.centerAt ? fg.centerAt() : null

    if (!c || !Number.isFinite(c.x)) {
      return
    }
    const hw = size.w / 2 / scale,
      hh = size.h / 2 / scale
    const minX = c.x - hw,
      maxX = c.x + hw,
      minY = c.y - hh,
      maxY = c.y + hh
    // Refresh the world-space viewport for this frame — the edge-LOD pass culls
    // against it (this hook runs before links paint).
    viewportRef.current = { minX, maxX, minY, maxY, k: scale }
    const BASE = 16 // smallest world spacing the grid steps through
    const DOT_TARGET_PX = 24 // aimed-for on-screen gap between dots
    const k = Math.ceil(Math.log2(DOT_TARGET_PX / scale / BASE))
    const SP = BASE * Math.pow(2, k) // coarse spacing, on-screen ∈ [T, 2T)
    const fineSP = SP / 2
    // Fine dots fade 0→1 across the octave (screen gap T→2T) so the next finer level
    // is fully present right as the grid is about to halve, then seamlessly inherits.
    const t = Math.min(1, Math.max(0, (SP * scale) / DOT_TARGET_PX - 1))
    const fineAlpha = t * t * (3 - 2 * t)
    const r = 1.1 / scale // ~1.1px on screen at any zoom
    const onGrid = (v: number, sp: number) => Math.abs(v / sp - Math.round(v / sp)) < 1e-6
    ctx.fillStyle = dotColor
    // Coarse dots — full strength, batched into a single fill for speed.
    ctx.beginPath()
    for (let x = Math.ceil(minX / SP) * SP; x <= maxX; x += SP) {
      for (let y = Math.ceil(minY / SP) * SP; y <= maxY; y += SP) {
        ctx.moveTo(x + r, y)
        ctx.arc(x, y, r, 0, 2 * Math.PI)
      }
    }
    ctx.globalAlpha = 1
    ctx.fill()
    // Interleaved half-step dots (those not already on the coarse grid), faded.
    if (fineAlpha > 0.02) {
      ctx.beginPath()
      for (let x = Math.ceil(minX / fineSP) * fineSP; x <= maxX; x += fineSP) {
        const xc = onGrid(x, SP)

        for (let y = Math.ceil(minY / fineSP) * fineSP; y <= maxY; y += fineSP) {
          if (xc && onGrid(y, SP)) {
            continue
          }
          ctx.moveTo(x + r, y)
          ctx.arc(x, y, r, 0, 2 * Math.PI)
        }
      }
      ctx.globalAlpha = fineAlpha
      ctx.fill()
    }
    ctx.globalAlpha = 1
  }

  // Three emphasis sets, each a node + its neighbours: a live hover, a pinned focus
  // (focusId — a picked search target or a note located from its local graph), and a
  // spotlight (the live search matches). Crucially they're a UNION, not a priority
  // chain: a pinned focus stays lit while you hover elsewhere, so its connections
  // remain a stable reference frame instead of vanishing the moment you explore.
  const spotlight = !!matchIds && matchIds.size > 0
  // A hover can come from the canvas itself OR from a synced row in the aside (a search
  // result / focus connection) — either lights the same node + its neighbours, so the
  // list and the graph stay in lockstep. The aside hover WINS when both are set: moving
  // the cursor off a node straight onto the panel can leave the canvas hover stale (no
  // pointer-move fires to clear it), and the row the user is now pointing at must light
  // regardless. (onPointerLeave on the canvas also clears the stale one as a backstop.)
  const hoverId = externalHover || hover
  const anyEmphasis = !!hoverId || !!focusId || spotlight
  const inHover = (id: string) => !!hoverId && (id === hoverId || !!adj.get(hoverId)?.has(id))
  const inFocus = (id: string) => !!focusId && (id === focusId || !!adj.get(focusId)?.has(id))
  const inSpot = (id: string) => spotlight && !!matchIds && matchIds.has(id)
  // Lit = part of any active emphasis; with nothing active, everything is lit.
  const isLit = (id: string) => !anyEmphasis || inHover(id) || inFocus(id) || inSpot(id)
  // Distinct from isLit: false when nothing is active (gates full labels, so they
  // don't all show at any zoom). Otherwise the same union.
  const isHovered = (id: string) => anyEmphasis && (inHover(id) || inFocus(id) || inSpot(id))

  // Which edges paint (#62). Hidden endpoints always hide the edge. Below the
  // LOD threshold everything else shows, as ever. On a dense graph the overview
  // shows NO bulk edges — nodes (colour = cluster, size = degree) are the
  // overview's story and edges are its noise; what does show is emphasis: the
  // hovered node's own edges, the focus neighbourhood's, the spotlight's. The
  // rest appear at reading zoom (EDGE_ZOOM) viewport-only, and hide while a
  // pan/zoom gesture is moving the camera.
  const linkShown = (l: SimLink): boolean => {
    const s = idOf(l.source)
    const t = idOf(l.target)

    if (!isVisible(s) || !isVisible(t)) {
      return false
    }
    if (!edgeLod) {
      return true
    }
    if (hoverId && (s === hoverId || t === hoverId)) {
      return true
    }
    if (focusId && inFocus(s) && inFocus(t)) {
      return true
    }
    if (spotlight && inSpot(s) && inSpot(t)) {
      return true
    }
    if (gesturing) {
      return false
    }
    const vp = viewportRef.current

    if (!vp || vp.k < EDGE_ZOOM) {
      return false
    }
    const a = l.source as SimNode
    const b = l.target as SimNode

    if (typeof a !== 'object' || typeof b !== 'object') {
      return false
    }
    const m = 40 / vp.k // small margin so edges don't pop at the frame border
    const inVp = (n: SimNode) =>
      n.x! >= vp.minX - m && n.x! <= vp.maxX + m && n.y! >= vp.minY - m && n.y! <= vp.maxY + m
    return inVp(a) && inVp(b)
  }

  // A small graph (the local/aside view, or a sparse base) shows every label; a
  // dense one would turn into a wall of overlapping text at fit zoom. There, at an
  // overview zoom, we label only the hubs (top nodes by degree) plus whatever's
  // lit by hover; zooming in past LABEL_SCALE reveals every label. Full titles
  // stay reachable via the native tooltip at any zoom.
  const denseGraph = graph.nodes.length > 60
  // Above this zoom every label shows; a dense graph fits well below it, so its
  // overview is governed by the hub set below, and a modest zoom-in to read crosses
  // the threshold and reveals the rest.
  const LABEL_SCALE = 1.0
  // The set of "hub" nodes labelled in the dense overview: a fixed top-N by
  // in-degree (most-referenced — the same signal that sizes them), a count not a
  // threshold (a threshold ties-in far more than N nodes in a dense core and the
  // overview clutters right back up).
  const hubIds = useMemo<Set<string> | null>(() => {
    if (!denseGraph) {
      return null
    }
    // Over the VISIBLE nodes, so the label budget isn't spent on filtered-out hubs.
    const top = graph.nodes
      .filter((n) => isVisible(n.id))
      .sort((a, b) => (inDeg.get(b.id) || 0) - (inDeg.get(a.id) || 0))
      .slice(0, 24)
    return new Set(top.map((n) => n.id))
  }, [graph, denseGraph, inDeg, isVisible])

  // Compute the fitted view ourselves (capped) and apply it in one shot — no
  // overshoot-then-snap-back, and instant by default so there's no animation
  // for an early scroll/drag to fight.
  const fitView = useCallback(
    (duration = 0) => {
      const fg = fgRef.current

      if (!fg || !graph.nodes.length) {
        return
      }
      // Bound the node *circles*, not just their centres — a node at the edge of the
      // cloud would otherwise sit with its centre on the padding line and spill its
      // radius (and, for the biggest, more) past the canvas. Including radiusOf keeps
      // the whole circle inside the fit on both graphs.
      let minX = Infinity,
        maxX = -Infinity,
        minY = Infinity,
        maxY = -Infinity

      for (const n of graph.nodes) {
        if (!isVisible(n.id)) {
          continue
        } // fit what's on screen, not the hidden rest
        const r = radiusOf(n)

        if (n.x! - r < minX) {
          minX = n.x! - r
        }
        if (n.x! + r > maxX) {
          maxX = n.x! + r
        }
        if (n.y! - r < minY) {
          minY = n.y! - r
        }
        if (n.y! + r > maxY) {
          maxY = n.y! + r
        }
      }
      if (minX === Infinity) {
        return
      } // everything is filtered out
      const w = Math.max(maxX - minX, 1e-3)
      const h = Math.max(maxY - minY, 1e-3)
      let k = Math.min((size.w - 2 * fitPadding) / w, (size.h - 2 * fitPadding) / h)

      if (!Number.isFinite(k) || k <= 0) {
        k = 1
      }
      k = Math.min(k, maxZoom)
      fg.centerAt((minX + maxX) / 2, (minY + maxY) / 2, duration)
      fg.zoom(k, duration)
    },
    [graph, size, fitPadding, maxZoom, radiusOf, isVisible],
  )

  // Animate to the fitted view, but mark it in-flight so a grab can cancel it.
  const animatedFit = useCallback(() => {
    fitView(380)
    fittingRef.current = true
    setTimeout(() => {
      fittingRef.current = false
    }, 400)
  }, [fitView])

  // User grabbed the graph: remember it, and if a fit is animating, freeze it
  // where it is so it can't tug against the user's gesture.
  const onUserGrab = () => {
    touchedRef.current = true
    if (!fittingRef.current) {
      return
    }
    fittingRef.current = false
    const fg = fgRef.current

    if (!fg) {
      return
    }
    const c = fg.centerAt()
    fg.zoom(fg.zoom(), 0)
    if (c && Number.isFinite(c.x)) {
      fg.centerAt(c.x, c.y, 0)
    }
  }

  const zoomBy = (factor: number) => {
    const fg = fgRef.current

    if (!fg) {
      return
    }
    fg.zoom(Math.max(0.05, Math.min(40, fg.zoom() * factor)), 180)
  }

  // "Tidy up" (#62): after a hard filter the visible remainder keeps the
  // positions it had inside the full layout — correct, but airy. This re-settles
  // ONLY the visible subset with a throwaway simulation (same force model, plus
  // a weak pull to its own centroid so it compacts), ticked over a few rAF
  // frames, mutating positions in place. Hidden nodes are untouched — clearing
  // the filter brings the old map back around the tidied part. The main engine
  // stays stopped; each frame bumps state so the canvas repaints the moved
  // coordinates.
  const tidyRun = useRef<{ active: boolean; cleanup?: () => void } | null>(null)
  const [, bumpRepaint] = useState(0)

  const stopTidy = () => {
    const run = tidyRun.current
    tidyRun.current = null
    if (!run || !run.active) {
      return
    }
    run.active = false
    run.cleanup?.()
  }
  useEffect(() => stopTidy, [])
  // A data swap or filter change invalidates an in-flight tidy.
  useEffect(() => {
    stopTidy()
  }, [graph, visibleIds])
  // Drive a throwaway simulation over rAF frames, mutating node positions in
  // place (the main engine stays stopped; each frame bumps state so the canvas
  // repaints). `cleanup` runs once, when the run finishes or is cancelled.
  const driveSim = (
    sim: { tick: (n?: number) => void; alpha: () => number },
    cleanup?: () => void,
  ) => {
    stopTidy()
    const run = { active: true, cleanup }
    tidyRun.current = run
    const step = () => {
      if (!run.active) {
        return
      }
      sim.tick(3)
      bumpRepaint((c) => c + 1)
      if (sim.alpha() > 0.02) {
        requestAnimationFrame(step)
      } else {
        run.active = false
        run.cleanup?.()
      }
    }
    requestAnimationFrame(step)
  }

  const tidy = () => {
    const nodes = graph.nodes.filter((n) => isVisible(n.id) && Number.isFinite(n.x))

    if (nodes.length < 2) {
      return
    }
    let cx = 0,
      cy = 0

    for (const n of nodes) {
      cx += n.x!
      cy += n.y!
    }
    cx /= nodes.length
    cy /= nodes.length
    // Endpoints are hydrated node objects by now (the engine rewrites links in
    // place on ingest); fresh link records keep the engine's own untouched.
    const links = graph.links
      .filter((l) => typeof l.source === 'object' && typeof l.target === 'object')
      .filter((l) => isVisible(idOf(l.source)) && isVisible(idOf(l.target)))
      .map((l) => ({ source: l.source as SimNode, target: l.target as SimNode }))
    type TidyLink = { source: SimNode; target: SimNode }
    const sim = forceSimulation<SimNode>(nodes, 2)
      .force(
        'charge',
        forceManyBody<SimNode>()
          .strength((n) => chargeStrength(n) * spacing)
          .distanceMax(CHARGE_DISTANCE_MAX),
      )
      .force(
        'link',
        forceLink<TidyLink>(links)
          .distance((l) => radiusOf(l.source) + radiusOf(l.target) + LINK_GAP * spacing)
          .strength(LINK_STRENGTH),
      )
      .force(
        'collide',
        forceCollide<SimNode>()
          .radius((n) => radiusOf(n) + COLLIDE_PAD * spacing)
          .iterations(2),
      )
      .force('x', forceX<SimNode>(cx).strength(0.04))
      .force('y', forceY<SimNode>(cy).strength(0.04))
      .velocityDecay(VELOCITY_DECAY)
      .alpha(0.4)
      .alphaDecay(0.04)
      .stop()
    driveSim(sim)
  }

  // Pinned local relax (#60): a mid-session refresh seeds newcomers near their
  // neighbours (mergeServerRefresh above); this settles them IN — every
  // pre-existing node is pinned (fx/fy), so the map is motionless by
  // construction, while collision pushes each newcomer out of whatever it
  // spawned on top of and link forces tug it toward its neighbours. Same
  // throwaway-simulation machinery as tidy(), different pin set.
  const relaxFresh = (fresh: Set<string>) => {
    const nodes = graph.nodes.filter((n) => Number.isFinite(n.x))

    if (!nodes.some((n) => fresh.has(n.id))) {
      return
    }
    const pinned: SimNode[] = []

    for (const n of nodes) {
      if (fresh.has(n.id)) {
        continue
      }
      n.fx = n.x
      n.fy = n.y
      pinned.push(n)
    }
    // The pins MUST come off when the run ends (or is cancelled): a lingering
    // fx/fy would weld the node against every later drag and re-layout.
    const unpin = () => {
      for (const n of pinned) {
        delete n.fx
        delete n.fy
      }
    }
    const links = graph.links
      .filter((l) => typeof l.source === 'object' && typeof l.target === 'object')
      .map((l) => ({ source: l.source as SimNode, target: l.target as SimNode }))
    type RelaxLink = { source: SimNode; target: SimNode }
    const sim = forceSimulation<SimNode>(nodes, 2)
      .force(
        'charge',
        forceManyBody<SimNode>()
          .strength((n) => chargeStrength(n) * spacing)
          .distanceMax(CHARGE_DISTANCE_MAX),
      )
      .force(
        'link',
        forceLink<RelaxLink>(links)
          .distance((l) => radiusOf(l.source) + radiusOf(l.target) + LINK_GAP * spacing)
          .strength(LINK_STRENGTH),
      )
      .force(
        'collide',
        forceCollide<SimNode>()
          .radius((n) => radiusOf(n) + COLLIDE_PAD * spacing)
          .iterations(2),
      )
      .velocityDecay(VELOCITY_DECAY)
      .alpha(0.3)
      .alphaDecay(0.06)
      .stop()
    driveSim(sim, unpin)
  }

  // Run the relax once the adoption freeze has burned off (the engine then
  // sits cold at the merged layout); the newcomer set is consumed exactly once.
  useEffect(() => {
    if (adopting) {
      return
    }
    const fresh = refreshFresh.current
    refreshFresh.current = null
    if (fresh?.size) {
      relaxFresh(fresh)
    }
    // relaxFresh reads the live graph/forces at fire time; only the adoption
    // handoff should trigger a run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adopting])

  // A node click: ghosts trigger create-the-missing-note; on the overview a real
  // node first focuses (camera + lit connections) and only opens on a second
  // click of the already-focused node; the local panel has no onFocus, so a click
  // opens straight away (quick nav is its whole purpose).
  const handleNodeClick = useCallback(
    (n: SimNode | null | undefined) => {
      if (!n) {
        return
      }
      if (n.ghost) {
        onCreateFromGhost?.(n)
        return
      }
      if (onFocus && n.id !== focusId) {
        onFocus(n)
      } else {
        onOpen(n.id)
      }
    },
    [onCreateFromGhost, onFocus, onOpen, focusId],
  )

  // Test-only handle (gated on window.__NOTARIUM_TEST__, set by the E2E harness):
  // lets specs drive the canvas by node id instead of guessing settled pixel
  // coordinates — interactions run through the SAME handlers as a real click/hover,
  // we just bypass the library's hit-testing. Never present in normal use.
  useEffect(() => {
    if (typeof window === 'undefined' || !window.__NOTARIUM_TEST__) {
      return undefined
    }
    window.__graphTest = {
      // The VISIBLE nodes — filters are a paint-time mask now (#62), but to the
      // specs (and the user) a masked node is "not on the graph", same as when
      // filtering rebuilt the dataset.
      nodes: () =>
        graph.nodes
          .filter((n) => isVisible(n.id))
          .map((n) => ({ id: n.id, ghost: !!n.ghost, title: n.title })),
      click: (id) => handleNodeClick(graph.nodes.find((n) => n.id === id)),
      hover: (id) => setHover(id ?? null),
      focusId: () => focusId ?? null,
      // True once the simulation has cooled and the initial fit ran — visual specs
      // wait on this before snapshotting.
      ready: () => fittedRef.current,
      // Re-fit the overview with the CURRENT measured size, animated so the render
      // loop repaints. Always the overview (never the zoom-to-node focus camera):
      // focus reads as node emphasis, which renders deterministically; the focus
      // camera's zoom is a non-pixel-tested animation.
      settle: () => {
        touchedRef.current = false
        animatedFit()
      },
    }
    return () => {
      delete window.__graphTest
    }
  }, [graph, handleNodeClick, focusId, animatedFit, isVisible])

  return (
    <div
      className={styles.graphCanvas}
      ref={wrapRef}
      onPointerDownCapture={onUserGrab}
      onWheelCapture={onUserGrab}
      onPointerLeave={() => setHover(null)}
    >
      <ForceGraph2D
        ref={fgRef}
        width={size.w}
        height={size.h}
        graphData={graph}
        backgroundColor="transparent"
        onRenderFramePre={drawDots}
        // force-graph normally stops repainting once the layout settles (power
        // saving). A pulse animates the node glow every frame off its own clock,
        // so while one runs the canvas keeps repainting; otherwise a settled
        // graph would sample the glow only on stray redraws — dim, laggy and
        // off-beat. Back to power-saving the moment it ends.
        autoPauseRedraw={!pulse?.active}
        // Adopting a server layout: velocity pinned to 1 freezes positions while
        // a steep alpha decay burns off the re-heat the data swap caused; then
        // the dials return to live-simulation values (drag and explicit
        // re-layouts work as ever, from the server's positions).
        cooldownTicks={adopting ? ADOPT_TICKS : 120}
        d3VelocityDecay={adopting ? 1 : VELOCITY_DECAY}
        d3AlphaDecay={adopting ? ADOPT_ALPHA_DECAY : 0.0228}
        onZoom={onCameraMove}
        onEngineStop={() => {
          if (adopting) {
            setAdoptingFor(null)
          }
          if (fittedRef.current) {
            return
          }
          fittedRef.current = true
          // If the user already grabbed the graph, don't yank it back.
          if (!touchedRef.current) {
            animatedFit()
          }
        }}
        nodeVisibility={(n) => isVisible(n.id)}
        linkVisibility={linkShown}
        nodeRelSize={4}
        linkColor={(l) => {
          // While the pulse runs the mesh steps back: nodes are the instrument, and
          // at PULSE_FLOOR a full-strength edge grid would out-shout the very field
          // it's drawn over. This return is also what keeps a stale hover or focus
          // from dimming half the edges through the whole mode.
          if (pulse?.active) {
            return faintLink
          }
          const s = idOf(l.source)
          const t = idOf(l.target)

          // Layered emphasis: a live hover's edges win in accent; a pinned focus's own
          // edges trace in neutral focusLink grey (and survive while you hover others);
          // links between two still-lit nodes keep baseLink; everything else dims.
          if (hoverId && (s === hoverId || t === hoverId)) {
            return accent
          }
          if (focusId && (s === focusId || t === focusId)) {
            return focusLink
          }
          if (anyEmphasis && !(isLit(s) && isLit(t))) {
            return faintLink
          }

          return baseLink
        }}
        linkWidth={(l) => {
          if (pulse?.active) {
            return 1 // same reason as linkColor: the mesh stays out of the way
          }
          const s = idOf(l.source)
          const t = idOf(l.target)

          if (hoverId && (s === hoverId || t === hoverId)) {
            return 2
          }
          if (focusId && (s === focusId || t === focusId)) {
            return 1.6
          }

          return 1
        }}
        linkDirectionalArrowLength={3.5}
        linkDirectionalArrowRelPos={1}
        linkLabel={(l) => l.type}
        nodeLabel={(n) => {
          if (n.ghost) {
            return `${n.title} — missing · click to create`
          }
          const title = n.title || n.id

          if (sizeBy === 'uniform') {
            return title
          }
          const v = metricOf(n)
          const unit =
            sizeBy === 'words' ? 'words' : sizeBy === 'references' ? 'backlinks' : 'links'
          return `${title} · ${v} ${unit}`
        }}
        onNodeHover={(n) => {
          setHover(n ? n.id : null)
          // Real nodes open; ghosts are clickable too when a create handler is
          // wired (click → create the missing note). Otherwise a ghost is a dead
          // end and keeps the default cursor.
          const clickable = n && (!n.ghost || onCreateFromGhost)

          if (wrapRef.current) {
            wrapRef.current.style.cursor = clickable ? 'pointer' : 'default'
          }
        }}
        onNodeClick={handleNodeClick}
        onBackgroundClick={() => setHover(null)}
        nodePointerAreaPaint={(node, color, ctx) => {
          const r = radiusOf(node)
          ctx.fillStyle = color
          ctx.beginPath()
          ctx.arc(node.x!, node.y!, r + 4, 0, 2 * Math.PI)
          ctx.fill()
        }}
        nodeCanvasObject={(node, ctx, scale) => {
          const r = radiusOf(node)
          const nx = node.x!,
            ny = node.y!

          // While a pulse runs, drop the normal emphasis and paint each node by
          // its glow alone — brightness, not size (changing radii would jostle
          // the layout). A struck node keeps its OWN group colour and blooms;
          // everything else falls back to a flat grey field. Strikes arrive in
          // same-colour clusters, so a whole region lights up at once.
          if (pulse?.active) {
            const a = pulse.intensityFor(node.id)
            const own = node.ghost ? accent : colorOf(node)
            // Reduced motion keeps the field close to its lit state, so the swing
            // between struck and cold is a shade rather than a flash.
            const floor = pulse.reduced ? PULSE_FLOOR_REDUCED : PULSE_FLOOR
            ctx.globalAlpha = floor + (1 - floor) * a

            if (a > 0.02 && !pulse.reduced) {
              ctx.shadowColor = own // bloom in the node's real colour
              ctx.shadowBlur = 8 + 34 * a
            }
            // Cold nodes are flat grey; as a node is struck it fades to its own
            // colour, brightened toward white at the peak.
            const hot = mix(toRgb(own, accentRgb), { r: 255, g: 255, b: 255 }, 0.5 * a)
            const fill = mix(dark ? PULSE_COLD_DARK : PULSE_COLD_LIGHT, hot, a)
            ctx.fillStyle = `rgb(${fill.r}, ${fill.g}, ${fill.b})`
            ctx.beginPath()
            ctx.arc(nx, ny, r, 0, 2 * Math.PI)
            ctx.fill()
            ctx.shadowBlur = 0
            ctx.globalAlpha = 1

            return
          }
          const lit = isLit(node.id)
          // The "current" node: the open note (local graph) or the search-picked one
          // (main graph). A single state with one treatment — each view only ever has
          // one, so there's nothing to tell apart, and consistency beats two rings.
          const isCurrent = node.id === activeId || node.id === focusId
          ctx.globalAlpha = lit ? 1 : 0.25

          // node circle — filled with its folder-group colour; the active note keeps
          // an accent ring so it still pops out of its cluster.
          ctx.beginPath()
          ctx.arc(nx, ny, r, 0, 2 * Math.PI)
          if (node.ghost) {
            ctx.setLineDash([2, 2])
            ctx.lineWidth = 1.4
            ctx.strokeStyle = ghostColor
            ctx.stroke()
            ctx.setLineDash([])
          } else {
            ctx.fillStyle = colorOf(node)
            ctx.fill()
          }
          if (isCurrent) {
            // One ring for the current node — an outer halo in the node's *own* fill
            // colour. It sits outside the node (r + 3), so the gap of empty space —
            // not a colour shift — separates it from the fill; and since only the
            // current node gets any ring, its mere presence is the marker. Ghosts have
            // no fill (grey dashed), so a same-colour ring would vanish → use accent.
            ctx.beginPath()
            ctx.arc(nx, ny, r + 3, 0, 2 * Math.PI)
            ctx.lineWidth = 1.8
            ctx.strokeStyle = node.ghost ? accent : colorOf(node)
            ctx.stroke()
          }

          // label — ghosts (missing notes) are always labelled, however dense or
          // zoomed-out, since seeing *what's* missing is the whole point of a
          // dead-link, and they're few. Their label is italic to read as "not real yet".
          const labelled =
            node.ghost ||
            !denseGraph ||
            scale > LABEL_SCALE ||
            isHovered(node.id) ||
            !!hubIds?.has(node.id)

          if (labelled) {
            const fontSize = Math.max(3.4, 11 / scale)
            ctx.font = `${node.ghost ? 'italic ' : ''}${fontSize}px -apple-system, "Segoe UI", sans-serif`
            ctx.textAlign = 'center'
            ctx.textBaseline = 'top'
            // Highlighted nodes get the full title (up to a sane cap); the rest are
            // truncated so dense areas stay legible. Full text is always reachable
            // via the native hover tooltip (nodeLabel).
            const raw = node.title || node.id
            const label =
              lit && raw.length <= 44 ? raw : raw.length > 28 ? raw.slice(0, 28) + '…' : raw
            const ty = ny + r + 2
            // A translucent plate in the bg colour behind the text so labels don't
            // get lost over links and other nodes.
            const tw = ctx.measureText(label).width
            const padX = 2.5 / scale
            const padY = 1.4 / scale
            ctx.fillStyle = `rgba(${bgRgb.r}, ${bgRgb.g}, ${bgRgb.b}, ${lit ? 0.82 : 0.6})`
            roundRect(
              ctx,
              nx - tw / 2 - padX,
              ty - padY,
              tw + padX * 2,
              fontSize + padY * 2,
              2 / scale,
            )
            ctx.fill()
            ctx.fillStyle = isCurrent ? accent : textColor
            ctx.fillText(label, nx, ty)
          }
          ctx.globalAlpha = 1
        }}
      />

      <div className={styles.graphControls}>
        <button onClick={() => zoomBy(1.4)} title="Zoom in" aria-label="Zoom in">
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
        <button onClick={() => zoomBy(1 / 1.4)} title="Zoom out" aria-label="Zoom out">
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <path d="M5 12h14" />
          </svg>
        </button>
        <button onClick={animatedFit} title="Fit to view" aria-label="Fit to view">
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.9"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
          </svg>
        </button>
        {/* Re-settle the visible subset — offered once filters hide enough of the
            graph that the remainder floats in the space the hidden nodes held. */}
        {hiddenFraction > TIDY_HIDDEN_FRACTION && visibleCount > 1 && (
          <button
            onClick={tidy}
            title="Tidy up — re-settle the visible notes"
            aria-label="Tidy up visible notes"
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.9"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M9 9 4 4m5 1v4H5M15 9l5-5m-5 1v4h4M9 15l-5 5m5-1v-4H5M15 15l5 5m-5-1v-4h4" />
            </svg>
          </button>
        )}
      </div>
    </div>
  )
}
