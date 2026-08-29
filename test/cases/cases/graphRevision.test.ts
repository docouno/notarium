import { describe, expect, it } from 'vitest'

import { buildCaseWorld } from '../build'
import {
  GRAPH_REVISION_CORPUS_BYTES,
  GRAPH_REVISION_NOTE_COUNT,
  GRAPH_REVISION_TARGET_TITLE,
  graphRevisionCorpusFiles,
} from './graphRevision'

describe('graph-revision seed shape', () => {
  it('pins the measured corpus bytes, link density and adjacency target', () => {
    const world = buildCaseWorld('graph-revision')
    const creates = world.events.filter((event) => event.op === 'create')
    const bytes = creates.reduce(
      (total, event) => total + Buffer.byteLength(event.content ?? '', 'utf8'),
      0,
    )
    const links = creates.reduce(
      (total, event) => total + ((event.content ?? '').match(/\[\[/g)?.length ?? 0),
      0,
    )
    let fillerCount = 0
    let fillerBytes = 0
    let fillerLinks = 0

    for (const file of graphRevisionCorpusFiles()) {
      fillerCount++
      fillerBytes += Buffer.byteLength(file.content, 'utf8')
      fillerLinks += file.content.match(/\[\[/g)?.length ?? 0
    }

    expect(creates).toHaveLength(2)
    expect(fillerCount + creates.length).toBe(GRAPH_REVISION_NOTE_COUNT)
    expect(fillerBytes + bytes).toBe(GRAPH_REVISION_CORPUS_BYTES)
    expect(fillerBytes + bytes).toBeGreaterThanOrEqual(Math.ceil(20.3 * 1024 * 1024))
    expect(fillerLinks + links).toBe(2_013)
    expect(
      creates.filter((event) => event.content?.includes('revision-query-marker')),
    ).toHaveLength(1)
    const target = creates.filter((event) => event.tags?.includes('adjacency-target'))

    expect(target).toHaveLength(1)
    expect(target[0].title).toBe(GRAPH_REVISION_TARGET_TITLE)
    expect(target[0].content).not.toMatch(/revision[\s-]+query[\s-]+marker/i)
  })
})
