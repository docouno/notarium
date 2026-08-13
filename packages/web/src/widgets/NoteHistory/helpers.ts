import { diffWordsWithSpace } from 'diff'
import { REVISION_KIND } from '@notarium/contract/enums'
import type { RevisionView } from '../../libs/revisions'

/** What a WITHHELD row (#327) is labelled instead of its kind. The dashboard feed
 *  says the same word for the same fact (`ActivityFeed`'s `unavailable` verb). */
export const UNAVAILABLE_LABEL = 'Unavailable'

export const KIND_LABEL: Record<RevisionView['kind'], string> = {
  write: 'Edited',
  external: 'External change',
  restore: 'Restored',
  merge: 'Merged',
  delete: 'Deleted',
}

/** What one timeline row says about a revision: the action, and the writer beside
 *  it. A withheld row (#327) gets NEITHER — the server did not fail to capture it,
 *  it refused to attribute it, so its `author: null` must not be worded as "outside
 *  Notarium", the phrase a genuine unsigned external edit earns.
 *  canon: docs/note-history.md#model
 *
 *  `sourceVersion` = the version number of a restore's source when that revision is
 *  in the loaded window; out of window the row stays a plain "Restored". */
export const historyRowLabels = (
  r: RevisionView,
  sourceVersion: number | undefined,
  authorText: string,
): { kind: string; who: string; gap: boolean } => {
  if (r.unavailableReason != null) {
    return { kind: UNAVAILABLE_LABEL, who: '', gap: true }
  }
  const kind =
    r.kind === REVISION_KIND.restore && sourceVersion != null
      ? `Restored from v${sourceVersion}`
      : KIND_LABEL[r.kind]
  const bodyless = r.contentHash == null && r.kind !== REVISION_KIND.delete
  const partial = r.stateFormat == null && r.contentHash != null

  return {
    kind,
    who: bodyless
      ? `${authorText} · body unknown`
      : partial
        ? `${authorText} · partial snapshot`
        : authorText,
    gap: false,
  }
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
