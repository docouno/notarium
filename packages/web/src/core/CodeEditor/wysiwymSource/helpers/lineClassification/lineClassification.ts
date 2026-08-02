import { type EditorState, StateField } from '@codemirror/state'
import { calloutLook } from '../../../../../libs/markdown/markdown/callout'
import { ATX, CALLOUT_HEAD, FENCE, HR, LIST, QUOTE } from '../../consts'
import type { Kind } from '../../types'

export const classify = (state: EditorState): Kind[] => {
  const doc = state.doc
  const kinds: Kind[] = new Array(doc.lines + 2).fill('') // 1-indexed, padded both ends
  let inFence = false

  for (let i = 1; i <= doc.lines; i++) {
    const text = doc.line(i).text

    if (FENCE.test(text)) {
      kinds[i] = 'code' // the fence lines belong to the code block
      inFence = !inFence
      continue
    }
    if (inFence) {
      kinds[i] = 'code'
      continue
    }
    if (text.trim() === '') {
      kinds[i] = 'blank'
      continue
    }
    const h = ATX.exec(text)

    if (h) {
      kinds[i] = ('h' + h[1].length) as Kind
      continue
    }
    if (QUOTE.test(text)) {
      kinds[i] = 'quote'
      continue
    }
    // `---` is a horizontal rule UNLESS it sits right under paragraph text, where
    // it's a Setext heading underline — leave that as plain so we don't draw a rule
    // through a heading. (HR before LIST: a spaced `* * *` would match LIST first.)
    if (HR.test(text) && kinds[i - 1] !== '') {
      kinds[i] = 'hr'
      continue
    }
    if (LIST.test(text)) {
      kinds[i] = 'list'
      continue
    }
    kinds[i] = ''
  }

  return kinds
}

// Line classification, computed ONCE per doc change and shared by both consumers
// (the block-layout decorations and the backdrop layer). Without this the layer
// would re-`classify()` the whole doc on every scroll (viewportChanged), since its
// markers are rebuilt per measure — wasteful on a long note.
export const lineKinds = StateField.define<Kind[]>({
  create: (state) => classify(state),
  update: (value, tr) => (tr.docChanged ? classify(tr.state) : value),
})

// Callout membership (#117), 1-indexed line → its callout look, or null. A quote run
// whose FIRST line is a `[!type]` head is a callout; the look propagates to every
// line of the run. This is the SINGLE source of truth for "is this line in a callout
// and which type" — the rail (buildBlockLayout), the fill tint (backdropRuns), the
// `[!type]` head colour and the in-callout link colour (inlineMarks) ALL read it,
// rather than each re-running CALLOUT_HEAD over the doc. Computed once per doc change
// off lineKinds (so the head regex runs only at run starts, not per consumer).
export const classifyCallouts = (state: EditorState): (string | null)[] => {
  const kinds = state.field(lineKinds)
  const doc = state.doc
  const looks = new Array<string | null>(doc.lines + 2).fill(null)

  for (let i = 1; i <= doc.lines; i++) {
    if (kinds[i] === 'quote' && kinds[i - 1] !== 'quote') {
      const m = CALLOUT_HEAD.exec(doc.line(i).text)

      if (m) {
        const look = calloutLook(m[1])

        for (let j = i; j <= doc.lines && kinds[j] === 'quote'; j++) {
          looks[j] = look
        }
      }
    }
  }

  return looks
}

export const calloutRuns = StateField.define<(string | null)[]>({
  create: (state) => classifyCallouts(state),
  update: (value, tr) => (tr.docChanged ? classifyCallouts(tr.state) : value),
})
