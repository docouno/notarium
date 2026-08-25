// `frontmatter=strip` is lossy by contract, and the contract names exactly one loss: the
// leading YAML block. Prose is not that block — and the reader that decides which is which
// is the same one the domain uses.
// canon: docs/export.md

import { describe, expect, it } from 'vitest'

import { exportEntryBody } from './exportEntry'

const entry = (content: string, path = 'notes/x.md') => ({
  path,
  content,
  title: 'x',
})

describe('exportEntryBody with frontmatter=strip', () => {
  it('cuts the leading YAML block and the blank line the fence left behind', () => {
    expect(exportEntryBody(entry('---\ntitle: A\n---\n\n# A\n\nbody\n'), true)).toBe(
      '# A\n\nbody\n',
    )
  })

  it('keeps prose that merely opens with a rule the parser calls a thematic break', () => {
    const raw = '\n---\nA thought I wrote between two rules.\n---\nAnd the rest.\n'

    expect(exportEntryBody(entry(raw), true)).toBe(raw.replace(/^\n+/, ''))
  })

  it('keeps a block whose fence is indented — the domain does not read it either', () => {
    const raw = '   ---\ntitle: x\n---\nbody\n'

    expect(exportEntryBody(entry(raw), true)).toBe(raw)
  })

  it('ships the file as it is when the option is off', () => {
    const raw = '---\ntitle: A\n---\nbody\n'

    expect(exportEntryBody(entry(raw), false)).toBe(raw)
  })
})
