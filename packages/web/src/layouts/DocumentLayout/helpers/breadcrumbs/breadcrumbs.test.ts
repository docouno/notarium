import { describe, expect, it } from 'vitest'
import type { NoteDetailView } from '../../../../libs/wire'
import { buildTrail } from './breadcrumbs'

const noteOf = (over: Partial<NoteDetailView>): NoteDetailView =>
  ({ id: 'n1', title: 'Untitled', filePath: 'a.md', ...over }) as NoteDetailView

const labels = (note: NoteDetailView) =>
  buildTrail({ note, virtualFolder: undefined, feedActive: false, tree: null, space: 's' }).map(
    (c) => c.label,
  )

describe('breadcrumbs — the folder-page leaf (#212/#415)', () => {
  it('drops the reserved leaf for a real folder page', () => {
    // The page IS the folder, so the trail ends at the folder rather than repeating
    // the storage name nobody types.
    expect(labels(noteOf({ filePath: 'docs/index.md', title: 'Docs' }))).toEqual(['docs'])
  })

  it('keeps its own leaf for a hidden-class note that merely carries the name', () => {
    // A memory category slugged to `index` lands on the reserved basename inside the
    // agent mount. It is nobody's cover, so hiding its leaf would leave the note with
    // a trail pointing at a folder it does not describe.
    expect(
      labels(
        noteOf({
          filePath: '.notarium/memory/index.md',
          title: 'index',
          class: 'agent-memory',
        }),
      ),
    ).toEqual(['Agents', 'memory', 'index'])
  })

  it('leaves an ordinary note trail alone', () => {
    expect(labels(noteOf({ filePath: 'docs/guide.md', title: 'Guide' }))).toEqual(['docs', 'guide'])
  })
})
