import { describe, expect, it } from 'vitest'
import { parseFrontmatterLines } from '../frontmatter'
import {
  logicalNoteState,
  logicalNoteStateFromProjection,
  parseLogicalNoteState,
} from './logicalState'

describe('logical note state', () => {
  it('keeps authored frontmatter losslessly but excludes identity/runtime projections', () => {
    const state = logicalNoteState({
      title: 'Canonical',
      body: 'Body\n',
      frontmatter: parseFrontmatterLines(`
# owner comment
aliases:
- contract-2026
plugin:
  nested: yes
title: stale
notarium-id: StableId123
notarium-created: 2026-01-01T00:00:00.000Z
`),
    })

    expect(state.markdown).toBe(`---
title: Canonical
# owner comment
aliases:
- contract-2026
plugin:
  nested: yes
---
Body
`)
    expect(parseLogicalNoteState(state)).toEqual({
      title: 'Canonical',
      body: 'Body\n',
      frontmatter: parseFrontmatterLines(`
# owner comment
aliases:
- contract-2026
plugin:
  nested: yes
`),
    })
  })

  it('has a deterministic compatibility projection for scalar and list fields', () => {
    expect(
      logicalNoteStateFromProjection({
        title: 'A',
        body: 'B',
        frontmatter: { tags: ['x', 'y'], muted: true, nested: { ignored: true } },
      }).markdown,
    ).toBe(`---
title: A
tags:
- x
- y
muted: "true"
---
B`)
  })

  it('keeps an empty compatibility list valid when a restore later patches it', () => {
    expect(
      logicalNoteStateFromProjection({
        title: 'A',
        body: 'B',
        frontmatter: { tags: [] },
      }).markdown,
    ).toBe(`---
title: A
tags: []
---
B`)
  })

  it('normalizes CRLF and lone CR in the body to canonical LF bytes', () => {
    const lf = logicalNoteState({ title: 'A', body: 'one\ntwo\n' })
    const crlf = logicalNoteState({ title: 'A', body: 'one\r\ntwo\r\n' })
    const cr = logicalNoteState({ title: 'A', body: 'one\rtwo\r' })

    expect(crlf).toEqual(lf)
    expect(cr).toEqual(lf)
  })
})
