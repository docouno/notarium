import { daysBefore, WorldBuilder } from '../generators'
import type { CaseSpec } from '../types'

const titleOf = (index: number): string => `Graph load ${String(index + 1).padStart(4, '0')}`
const link = (index: number): string => `[[${titleOf(index)}]]`

/** A scalable linked graph with stable communities and roughly three edges per
 *  node. SCALE=10 reproduces the 3k-node/9k-link cold-enrichment workload. */
export const graphLoad: CaseSpec = {
  name: 'graph-load',
  description:
    'Scalable linked communities for cold graph-enrichment load: 300 nodes / ~900 links per SCALE unit.',
  axes: ['graph', 'scale'],
  build: ({ now, scale }) => {
    const b = new WorldBuilder(now)
    b.space({ slug: 'main', displayName: 'Main' })
    const count = Math.max(12, Math.round(300 * scale))
    const communityCount = Math.min(12, count)
    const communities = Array.from({ length: communityCount }, () => [] as number[])

    for (let index = 0; index < count; index++) {
      communities[index % communityCount].push(index)
    }
    for (let index = 0; index < count; index++) {
      const community = index % communityCount
      const members = communities[community]
      const position = Math.floor(index / communityCount)
      const targets = new Set([
        members[0],
        members[(position - 1 + members.length) % members.length],
        members[(position + 1) % members.length],
      ])

      targets.delete(index)
      if (position === 0) {
        targets.add(communities[(community + 1) % communityCount][0])
      }
      const title = titleOf(index)
      b.note({
        space: 'main',
        path: `graph-load/community-${String(community + 1).padStart(2, '0')}/node-${String(index + 1).padStart(4, '0')}.md`,
        title,
        content: `# ${title}\n\nCommunity ${community + 1}. Links: ${[...targets].map(link).join(', ')}.`,
        tags: ['graph-load', `community-${community + 1}`],
        created: daysBefore(now, index % 365, 10),
        principal: 'user:sergey',
      })
    }

    return b.build()
  },
}
