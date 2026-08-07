import { describe, expect, it } from 'vitest'

import type { GraphView as Graph } from '../../../../libs/wire'
import { filterObservedGraph } from './graphFreshness'

describe('graph response freshness', () => {
  it('drops a removed real node and ghosts reachable only from it', () => {
    const graph: Graph = {
      nodes: [
        {
          id: 'P',
          title: 'Provisional',
          filePath: 'p.md',
          folder: '',
          degree: 1,
          ghost: false,
        },
        { id: 'D', title: 'Durable', filePath: 'd.md', folder: '', degree: 0, ghost: false },
        {
          id: 'ghost:gone',
          title: 'Gone',
          folder: '',
          degree: 1,
          ghost: true,
          target: 'Gone',
          prefillTitle: 'Gone',
          creatable: true,
        },
      ],
      links: [{ source: 'P', target: 'ghost:gone', type: 'links_to' }],
    }

    const filtered = filterObservedGraph(graph, new Set(['D']))

    expect(filtered.nodes.map((node) => node.id)).toEqual(['D'])
    expect(filtered.links).toEqual([])
  })
})
