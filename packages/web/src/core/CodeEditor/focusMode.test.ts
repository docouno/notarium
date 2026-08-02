import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'

import { activeFocusRange, type FocusGranularity } from './focusMode'

// Resolve the active focus range for a caret at `pos` and return the text it covers,
// so the assertions read as "what stays lit". A two-arg form (anchor/head) exercises
// a non-empty selection.
const lit = (doc: string, granularity: FocusGranularity, anchor: number, head = anchor): string => {
  const state = EditorState.create({ doc, selection: { anchor, head } })
  const r = activeFocusRange(state, granularity)
  return r ? state.sliceDoc(r.from, r.to) : '' // null = nothing focused (blank doc)
}

// Caret offset just inside `needle` (its first char), to place the cursor expressively.
const at = (doc: string, needle: string) => doc.indexOf(needle)

describe('activeFocusRange', () => {
  describe('line granularity', () => {
    const doc = 'Line A.\nLine B continues.\n\nPara two.'
    it('lights only the logical line under the caret', () => {
      expect(lit(doc, 'line', at(doc, 'Line A'))).toBe('Line A.')
      expect(lit(doc, 'line', at(doc, 'continues'))).toBe('Line B continues.')
    })
    it('a fully blank document focuses nothing', () => {
      expect(lit('\n\n', 'line', 1)).toBe('')
    })
  })

  describe('paragraph granularity', () => {
    const doc = 'First line.\nStill first.\n\nSecond block.'
    it('spans the run of non-blank lines around the caret', () => {
      expect(lit(doc, 'paragraph', at(doc, 'Still'))).toBe('First line.\nStill first.')
      expect(lit(doc, 'paragraph', at(doc, 'Second'))).toBe('Second block.')
    })
    it('a caret on a blank line holds focus on the paragraph above (no flash on Enter)', () => {
      const blankPos = doc.indexOf('\n\n') + 1 // on the empty line between the two blocks
      expect(lit(doc, 'paragraph', blankPos)).toBe('First line.\nStill first.')
    })
    it('a leading blank line borrows the paragraph below', () => {
      const d = '\n\nLead paragraph here.'
      expect(lit(d, 'paragraph', 0)).toBe('Lead paragraph here.')
    })
    it('a fully blank document focuses nothing (dims nothing — no flash to cause)', () => {
      expect(lit('\n\n  \n', 'paragraph', 1)).toBe('')
    })
  })

  describe('sentence granularity', () => {
    const doc = 'One. Two? Three!'
    it('isolates the sentence under the caret', () => {
      expect(lit(doc, 'sentence', at(doc, 'One'))).toBe('One.')
      expect(lit(doc, 'sentence', at(doc, 'Two'))).toBe('Two?')
      expect(lit(doc, 'sentence', at(doc, 'Three'))).toBe('Three!')
    })
    it('a caret right after a terminator still lights the finished sentence', () => {
      expect(lit(doc, 'sentence', at(doc, 'One') + 4)).toBe('One.') // just past the '.'
    })
    it('a sentence may cross a hard line break inside its paragraph', () => {
      const d = 'Hello world. This is\na wrapped sentence.'
      expect(lit(d, 'sentence', at(d, 'wrapped'))).toBe('This is\na wrapped sentence.')
    })
    it('does not split on a decimal point (no following whitespace)', () => {
      const d = 'Pi is 3.14 exactly. Next.'
      expect(lit(d, 'sentence', at(d, 'Pi'))).toBe('Pi is 3.14 exactly.')
    })
    it('falls back to the whole paragraph when there is no terminator', () => {
      const d = '# A heading with no period'
      expect(lit(d, 'sentence', at(d, 'heading'))).toBe('# A heading with no period')
    })
    it('treats a run of terminators as a single boundary', () => {
      const d = 'Wow!!! Next.'
      expect(lit(d, 'sentence', at(d, 'Wow'))).toBe('Wow!!!')
      expect(lit(d, 'sentence', at(d, 'Next'))).toBe('Next.')
    })
    it('a caret at the very end lights the last sentence', () => {
      const d = 'One. Two.'
      expect(lit(d, 'sentence', d.length)).toBe('Two.')
    })
    it('splits CJK full-stops with no trailing space (they are hard boundaries)', () => {
      const d = '句子一。句子二。'
      expect(lit(d, 'sentence', d.indexOf('一'))).toBe('句子一。')
      expect(lit(d, 'sentence', d.indexOf('二'))).toBe('句子二。')
    })
    it('a fully blank document focuses nothing', () => {
      expect(lit('\n\n', 'sentence', 1)).toBe('')
    })
  })

  describe('degenerate documents', () => {
    it('an empty document focuses nothing in any granularity', () => {
      expect(lit('', 'line', 0)).toBe('')
      expect(lit('', 'paragraph', 0)).toBe('')
      expect(lit('', 'sentence', 0)).toBe('')
    })
    it('a single-character document lights that character', () => {
      expect(lit('x', 'line', 0)).toBe('x')
      expect(lit('x', 'paragraph', 1)).toBe('x')
      expect(lit('x', 'sentence', 0)).toBe('x') // no terminator → falls back to the paragraph
    })
  })

  describe('non-empty selection (jitter mitigation)', () => {
    const doc = 'Alpha one.\n\nBeta two.\n\nGamma three.'
    it('lights every unit the selection touches, not one jumping unit', () => {
      // Selection from inside the first paragraph to inside the third spans all of it.
      const from = at(doc, 'one')
      const to = at(doc, 'three')
      expect(lit(doc, 'paragraph', from, to)).toBe(doc)
    })
    it('a selection endpoint on a blank line borrows, and the span stays ordered', () => {
      const d = 'Alpha.\n\nBeta.\n\nGamma.'
      const blank1 = d.indexOf('\n\n') + 1 // blank between Alpha and Beta → borrows up to Alpha
      // start borrows to Alpha, end is in Gamma → the Math.min/max span covers it all
      // without violating the RangeSetBuilder sorted/non-overlapping invariant.
      expect(lit(d, 'paragraph', blank1, at(d, 'Gamma'))).toBe(d)
    })
  })
})
