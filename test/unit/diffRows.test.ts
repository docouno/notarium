import { describe, expect, it } from 'vitest'
import { buildDiffRows, type DiffRow } from '../../packages/web/src/widgets/NoteHistory/helpers'

// The note-history diff (#12): a word-level diff re-grouped into the lines of the
// NEW text, so the revision view can number lines and flag only the changed ones.
// The spec that must hold: every row is a line of the current revision (numbered
// 1..N, in order); a row is `changed` iff it carries an add/del; and the non-del
// segments reconstruct the current text exactly (a removed line break is kept
// inline as a del so it never invents a phantom numbered line).

const text = (row: DiffRow) =>
  row.segments
    .filter((s) => s.kind !== 'del')
    .map((s) => s.value)
    .join('')

/** The new text the rows render back to — the load-bearing invariant. */
const reconstruct = (rows: DiffRow[]) => rows.map(text).join('\n')

describe('buildDiffRows', () => {
  it('numbers every line of the new text 1..N, in order', () => {
    const rows = buildDiffRows('alpha\nbeta\ngamma', 'alpha\nbeta\ngamma')
    expect(rows.map((r) => r.num)).toEqual([1, 2, 3])
    expect(rows.map(text)).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('flags nothing changed when the text is identical', () => {
    const rows = buildDiffRows('alpha\nbeta', 'alpha\nbeta')
    expect(rows.every((r) => !r.changed)).toBe(true)
  })

  it('flags only the line that changed, with word-level add/del inside it', () => {
    const rows = buildDiffRows('the quick brown fox', 'the quick red fox')
    expect(rows).toHaveLength(1)
    expect(rows[0].changed).toBe(true)
    const kinds = rows[0].segments.map((s) => s.kind)
    expect(kinds).toContain('add')
    expect(kinds).toContain('del')
    expect(rows[0].segments.find((s) => s.kind === 'add')?.value).toContain('red')
    expect(rows[0].segments.find((s) => s.kind === 'del')?.value).toContain('brown')
    expect(reconstruct(rows)).toBe('the quick red fox')
  })

  it('an added line is its own changed row; the line above stays unchanged', () => {
    const rows = buildDiffRows('line one', 'line one\nline two')
    expect(rows).toHaveLength(2)
    expect(rows[0].changed).toBe(false)
    expect(rows[1].changed).toBe(true)
    expect(rows[1].segments.some((s) => s.kind === 'add')).toBe(true)
    expect(reconstruct(rows)).toBe('line one\nline two')
  })

  it('a removed line stays inline (no phantom line): numbers track the new text', () => {
    const rows = buildDiffRows('a\nb\nc', 'a\nc')
    // Two lines in the NEW text, not three.
    expect(rows.map((r) => r.num)).toEqual([1, 2])
    expect(rows[0].changed).toBe(false)
    expect(rows[1].changed).toBe(true)
    expect(rows[1].segments.some((s) => s.kind === 'del')).toBe(true)
    expect(reconstruct(rows)).toBe('a\nc')
  })

  it('shows whitespace-only edits (the timeline counts them, so must the diff)', () => {
    // Two trailing spaces added (a markdown <br>) — `diffWords` would swallow
    // this and render no change; `diffWordsWithSpace` keeps it visible.
    const added = buildDiffRows('end of line.', 'end of line.  ')
    expect(added.some((r) => r.changed)).toBe(true)
    expect(
      added.flatMap((r) => r.segments).some((s) => s.kind === 'add' && /\s/.test(s.value)),
    ).toBe(true)
    expect(reconstruct(added)).toBe('end of line.  ')

    // …and a removed trailing newline.
    const removed = buildDiffRows('end of line.\n', 'end of line.')
    expect(removed.some((r) => r.changed)).toBe(true)
    expect(removed.flatMap((r) => r.segments).some((s) => s.kind === 'del')).toBe(true)
  })

  it('a baseline (empty base) is all added', () => {
    const rows = buildDiffRows('', 'hello\nworld')
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.changed)).toBe(true)
    expect(reconstruct(rows)).toBe('hello\nworld')
  })

  it('empty on both sides yields a single empty line', () => {
    const rows = buildDiffRows('', '')
    expect(rows).toHaveLength(1)
    expect(rows[0].changed).toBe(false)
    expect(text(rows[0])).toBe('')
  })
})
