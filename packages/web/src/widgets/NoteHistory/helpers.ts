import { diffWordsWithSpace } from 'diff'
import type { RevisionView } from '../../libs/revisions'

export const KIND_LABEL: Record<RevisionView['kind'], string> = {
  write: 'Edited',
  external: 'External change',
  restore: 'Restored',
  merge: 'Merged',
  delete: 'Deleted',
}

export type DiffSegment = { value: string; kind: 'ctx' | 'add' | 'del' }
export type DiffRow = { num: number; changed: boolean; segments: DiffSegment[] }

// Word-level diff, re-grouped into the lines of the *new* text so the view can
// show a line-number gutter and highlight just the lines that changed (small
// edits are otherwise lost in a wall of flowing text). Line numbers track the
// current revision: a removed line break is kept inline (it isn't a boundary in
// the new text) rather than spawning a phantom numbered line.
//
// `diffWordsWithSpace` (not `diffWords`): whitespace is SIGNIFICANT here. The
// journal records whitespace-only edits (trailing-space `<br>`, blank lines,
// re-normalisation), and the timeline counts them in "+N −M" — `diffWords`
// would swallow them and the view would show a changed revision with no
// visible change.
export const buildDiffRows = (base: string, current: string): DiffRow[] => {
  const rows: DiffRow[] = []
  let segments: DiffSegment[] = []
  let changed = false

  const push = () => {
    rows.push({ num: rows.length + 1, changed, segments })
    segments = []
    changed = false
  }

  for (const part of diffWordsWithSpace(base, current)) {
    const kind: DiffSegment['kind'] = part.added ? 'add' : part.removed ? 'del' : 'ctx'
    const pieces = part.value.split('\n')
    pieces.forEach((text, i) => {
      if (i > 0) {
        if (kind === 'del') {
          segments.push({ value: '\n', kind: 'del' })
          changed = true
        } else {
          push()
        }
      }
      if (text) {
        segments.push({ value: text, kind })
        if (kind !== 'ctx') {
          changed = true
        }
      }
    })
  }
  if (segments.length || rows.length === 0) {
    push()
  }

  return rows
}
