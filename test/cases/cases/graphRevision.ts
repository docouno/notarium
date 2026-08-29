import { daysBefore, WorldBuilder } from '../generators'
import type { CaseSpec } from '../types'

const FILLER_NOTE_COUNT = 1_355
const EXTRA_LINK_NOTES = 657
const BODY_BYTES = 16_384
export const GRAPH_REVISION_TARGET_TITLE = 'Adjacency Target'
const TARGET_CONTENT = `# ${GRAPH_REVISION_TARGET_TITLE}\n\nAstronomy-only sentinel quasar nebula pulsar.`

export const GRAPH_REVISION_NOTE_COUNT = FILLER_NOTE_COUNT + 2
export const GRAPH_REVISION_CORPUS_BYTES =
  (FILLER_NOTE_COUNT + 1) * BODY_BYTES + Buffer.byteLength(TARGET_CONTENT, 'utf8')

const sizedBody = (prefix: string): string => {
  const line =
    'Representative graph revision corpus text keeps markdown tokenisation proportional to real authored notes while resolver metadata stays compact. '

  return (prefix + line.repeat(Math.ceil((BODY_BYTES - prefix.length) / line.length))).slice(
    0,
    BODY_BYTES,
  )
}

const fillerBodyOf = (index: number): string => {
  const serial = String(index).padStart(4, '0')
  const next = String((index % FILLER_NOTE_COUNT) + 1).padStart(4, '0')
  const second = String(((index + 1) % FILLER_NOTE_COUNT) + 1).padStart(4, '0')
  const links = [
    `[[Graph corpus ${next}]]`,
    ...(index <= EXTRA_LINK_NOTES ? [`[[Graph corpus ${second}]]`] : []),
  ].join(' ')
  return sizedBody(`# Graph corpus ${serial}\n\n${links}\n\n`)
}

export function* graphRevisionCorpusFiles(): Generator<{
  path: string
  content: string
}> {
  for (let index = 1; index <= FILLER_NOTE_COUNT; index++) {
    const serial = String(index).padStart(4, '0')
    yield {
      path: `corpus/bucket-${String(index % 64).padStart(2, '0')}/note-${serial}.md`,
      content: fillerBodyOf(index),
    }
  }
}

/** The #410 production-shaped graph-revision stand. It is deliberately separate
 * from context-open: this case fixes corpus bytes/link density and changes only
 * one source note during the benchmark. */
export const graphRevision: CaseSpec = {
  name: 'graph-revision',
  description:
    'Production-shaped #410 fixture: one mutation source and one adjacency target; the gate adds its deterministic 1355-note corpus.',
  axes: ['graph', 'search', 'scale', 'structure'],
  build: ({ now }) => {
    const world = new WorldBuilder(now)

    world.space({ slug: 'graph-revision', displayName: 'Graph revision' })
    world.user({
      username: 'admin',
      password: 'admin',
      displayName: 'Graph operator',
      admin: true,
    })
    world.member({ space: 'graph-revision', username: 'admin', role: 'owner' })

    world.note({
      space: 'graph-revision',
      path: 'source/graph-revision-source.md',
      title: 'Graph Revision Source',
      content: sizedBody(
        '# Graph Revision Source\n\nrevision-query-marker [[Graph corpus 0001]]\n\n',
      ),
      tags: ['graph-revision', 'mutation-source'],
      created: daysBefore(now, 2, 9),
      principal: 'user:admin',
    })
    world.note({
      space: 'graph-revision',
      path: 'target/adjacency-target.md',
      title: GRAPH_REVISION_TARGET_TITLE,
      content: TARGET_CONTENT,
      tags: ['graph-revision', 'adjacency-target'],
      created: daysBefore(now, 1, 9),
      principal: 'user:admin',
    })

    return world.build()
  },
}
