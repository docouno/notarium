import { idOf } from '../../../../libs/graph/graphId'
import type { GraphInput, SimNode } from '../../types'

// Deterministic [0,1) from a string — jitter seed for newcomer placement (the
// same FNV trick the server layout uses; no Math.random, so a given note
// always spawns with the same offset).
export const hash01 = (s: string): number => {
  let h = 2166136261

  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }

  return (h >>> 0) / 4294967296
}

// Mid-session snapshot refresh (#60): the server re-relaxes the WHOLE layout on
// every rebuild, so adopting its coordinates wholesale teleports the map under
// the user's cursor. Instead the client's positions are the session's truth:
//   - existing nodes keep their on-screen spot (including hand-dragged ones —
//     the server's drifted coordinates are ignored for them);
//   - new nodes spawn at the centroid of their already-placed neighbours, with
//     a small deterministic jitter so coincident spawns don't stack;
//   - a newcomer with no placed neighbour (isolate / new cluster) falls back to
//     the server's coordinate.
// Mutates `next`'s nodes in place (they're this component's fresh copies) and
// returns the newcomer ids — the set the pinned relax below then settles.
export const mergeServerRefresh = (prev: GraphInput, next: GraphInput): Set<string> => {
  const pos = new Map<string, SimNode>()

  for (const n of prev.nodes) {
    if (Number.isFinite(n.x) && Number.isFinite(n.y)) {
      pos.set(n.id, n)
    }
  }
  const fresh = new Set<string>()

  for (const n of next.nodes) {
    const p = pos.get(n.id)

    if (p) {
      n.x = p.x
      n.y = p.y
      n.vx = 0
      n.vy = 0
    } else {
      fresh.add(n.id)
    }
  }
  if (!fresh.size) {
    return fresh
  }
  const sums = new Map<string, { x: number; y: number; n: number }>()

  for (const l of next.links) {
    const s = idOf(l.source)
    const t = idOf(l.target)
    const sFresh = fresh.has(s)

    if (sFresh === fresh.has(t)) {
      continue
    } // both new or both placed — no seed signal
    const [freshId, placedId] = sFresh ? [s, t] : [t, s]
    const p = pos.get(placedId)

    if (!p) {
      continue
    }
    const acc = sums.get(freshId) ?? { x: 0, y: 0, n: 0 }
    acc.x += p.x!
    acc.y += p.y!
    acc.n++
    sums.set(freshId, acc)
  }
  for (const n of next.nodes) {
    if (!fresh.has(n.id)) {
      continue
    }
    const s = sums.get(n.id)

    if (!s || !s.n) {
      continue
    } // no placed neighbour — keep the server's coordinate
    const jitter = hash01(n.id) * 2 * Math.PI
    n.x = s.x / s.n + Math.cos(jitter) * 30
    n.y = s.y / s.n + Math.sin(jitter) * 30
  }

  return fresh
}
