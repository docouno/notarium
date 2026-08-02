// Edge LOD (#62). On a dense graph ~85% of a frame goes to drawing edges, and at
// overview zoom they're unreadable anyway — so past EDGE_LOD_LINKS the canvas
// stops drawing the bulk: only emphasis edges (hover/focus) show on the
// overview, the rest appear at reading zoom (EDGE_ZOOM, where labels show too)
// and only within the viewport, and hide while a pan/zoom gesture is in flight.
// Below the threshold (the local panel, small bases) every edge renders as ever.
export const EDGE_LOD_LINKS = 1000
export const EDGE_ZOOM = 1.0
export const GESTURE_SETTLE_MS = 180

// Adopting a server layout: the snapshot arrives with settled positions, but
// feeding new graphData always re-heats the engine (alpha back to 1). For those
// ticks the velocity decay is pinned to 1 — forces run, positions cannot move —
// and a steep alpha decay burns the heat off in ~ADOPT_TICKS frames; then the
// dials return to normal and the simulation sits cold at the server's layout,
// alive for drag and explicit re-layouts (spacing/grouping changes).
export const ADOPT_TICKS = 30
export const ADOPT_ALPHA_DECAY = 0.2
// Show the "tidy" control once filters hide this share of the nodes — the
// visible remainder is sparse enough that re-settling it is worth offering.
export const TIDY_HIDDEN_FRACTION = 0.3

// Focus framing. When a node is focused (search pick, or "open in graph" from a
// note) we frame it TOGETHER with its 1-hop neighbours, not just the dot itself — a
// tight close-up hides the very connections the focus is meant to reveal. The node
// stays centred; zoom is whatever fits the farthest neighbour (plus padding), capped
// so a node with one nearby neighbour (or none at all) doesn't slam to an extreme
// close-up where, again, you'd see nothing around it.
export const FOCUS_PADDING = 100
export const FOCUS_MAX_ZOOM = 1.8

// The pulse glow pass. A node that hasn't been struck sits at PULSE_FLOOR alpha in
// a neutral grey, so only the lit cluster carries colour; the greys are picked per
// theme to stay a readable field rather than a wall. The floor is deliberately
// above the faint edge colour — dimmer than that and the mesh reads louder than the
// nodes it connects, which inverts the whole picture (worst on light, where the
// cold grey has to hold its own against a white background).
export const PULSE_FLOOR = 0.28
export const PULSE_COLD_DARK = { r: 92, g: 98, b: 110 }
export const PULSE_COLD_LIGHT = { r: 128, g: 134, b: 146 }
// Under prefers-reduced-motion the field sits nearly lit, so a strike is a change
// of shade instead of a flash (the engine also stretches its decay).
export const PULSE_FLOOR_REDUCED = 0.7
