// serializeNoteFile YAML-safety (#156): a note's title can now be ARBITRARY
// first-line prose (Bear-style body-first), so the frontmatter `title:` must stay
// parseable by a STRICT external YAML reader (Obsidian, exporters) — a title opening
// with a flow indicator is quoted, and any title round-trips back through parse.

import { describe, expect, it } from 'vitest'
import { parseNoteFile, serializeNoteFile } from '@notarium/engine'

describe('serializeNoteFile — YAML-safe title quoting (#156)', () => {
  const ser = (title: string) => serializeNoteFile({ title, body: 'x' })

  it('quotes a title opening with a YAML flow indicator (which #156 makes reachable)', () => {
    expect(ser('[[wiki]]')).toContain('title: "[[wiki]]"') // would be a nested flow seq unquoted
    expect(ser('{a}')).toContain('title: "{a}"')
    expect(ser(', leading')).toContain('title: "')
  })

  it('leaves a plain title unquoted', () => {
    expect(ser('Plain Title')).toContain('title: Plain Title\n')
  })

  it('round-trips an arbitrary first-line title through parse', () => {
    for (const t of ['[[wiki]]', 'He said "hi"', '{x}', 'normal', 'a: b', '- dash']) {
      const file = serializeNoteFile({ title: t, body: 'body' })
      expect(parseNoteFile(file, 'demo/n.md').title).toBe(t)
    }
  })
})
