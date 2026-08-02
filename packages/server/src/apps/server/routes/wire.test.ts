import { describe, expect, it } from 'vitest'
import type { GraphHealth } from '@notarium/core'

import { graphHealthToWire } from './wire'

// graphHealthToWire caps the edge ROW list so a huge base never ships thousands of
// rows to a summary card — but the headline counts stay exact, and former-name edges
// (the card's content) must never be starved out of the cap by slug alternates.

const edge = (
  id: number,
  via: GraphHealth['edges'][number]['via'],
): GraphHealth['edges'][number] => ({
  source: { id: `s${id}`, title: `S${id}` },
  target: { id: `t${id}`, title: `T${id}` },
  via,
})

describe('graphHealthToWire (#100 phase 5)', () => {
  it('keeps headline counts exact while capping the edge list, sorting former-name edges first', () => {
    // 120 slug edges ahead of 30 note-alias edges: a naive head-slice would ship
    // 100 slug rows and DROP every stale edge the card actually renders.
    const slugs = Array.from({ length: 120 }, (_, i) => edge(i, 'slug'))
    const stale = Array.from({ length: 30 }, (_, i) => edge(1000 + i, 'note-alias'))
    const h: GraphHealth = {
      totalLinks: 400,
      staleNamed: 30,
      via: { slug: 120, noteAlias: 30, folderAlias: 0 },
      edges: [...slugs, ...stale],
      ghosts: [],
    }
    const wire = graphHealthToWire(h)

    // Counts reflect the FULL graph, untouched by the cap.
    expect(wire.staleNamed).toBe(30)
    expect(wire.via).toEqual({ slug: 120, noteAlias: 30, folderAlias: 0 })
    // The row list is capped…
    expect(wire.edges).toHaveLength(100)
    // …but ALL 30 former-name edges survived (sorted ahead of slug alternates).
    expect(wire.edges.filter((e) => e.via === 'note-alias')).toHaveLength(30)
  })

  it('passes a small graph through verbatim (no truncation, order preserved)', () => {
    const h: GraphHealth = {
      totalLinks: 3,
      staleNamed: 1,
      via: { slug: 1, noteAlias: 1, folderAlias: 0 },
      edges: [edge(1, 'note-alias'), edge(2, 'slug')],
      ghosts: [
        {
          id: 'ghost:x',
          title: 'X',
          target: 'x',
          refCount: 1,
          sources: [{ id: 's9', title: 'S9', folder: '' }],
        },
      ],
    }
    const wire = graphHealthToWire(h)
    expect(wire.edges).toHaveLength(2)
    expect(wire.edges[0].via).toBe('note-alias') // stale-first ordering is stable
    expect(wire.ghosts[0]).toEqual({
      id: 'ghost:x',
      title: 'X',
      target: 'x',
      refCount: 1,
      sources: [{ id: 's9', title: 'S9', folder: '' }],
    })
  })
})
