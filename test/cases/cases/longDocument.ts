import { composeNote, CORPUS } from '../corpus'
import { daysBefore, WorldBuilder } from '../generators'
import type { CaseSpec } from '../types'

// One very LONG note that stitches the whole content corpus into a single page — the
// case for reading typography S/M/L/XL (#27/#189), the document outline, long-scroll
// virtualization and the history-diff surface at length. Also the honest perf note:
// every feature rendered at once on one page. A short list note links into it.
export const longDocument: CaseSpec = {
  name: 'long-document',
  description:
    'One long note stitching the entire content corpus — reading-size S/M/L/XL, outline, long-scroll and the diff surface at length (#27/#189/#203).',
  axes: ['content', 'scale', 'history'],
  build: ({ now }) => {
    const b = new WorldBuilder(now)
    b.space({ slug: 'reader-cases', displayName: 'Reader Cases' })

    b.note({
      space: 'reader-cases',
      path: 'reading/the-long-read.md',
      title: 'The long read',
      content: composeNote('The long read', CORPUS),
      tags: ['reading', 'long'],
      created: daysBefore(now, 20, 9),
      // A couple of edits so the same long note has a revision chain for the diff view.
      edits: [daysBefore(now, 12, 11), daysBefore(now, 4, 15)],
      principal: 'user:sergey',
    })

    // The folder page of reading/ (index.md, #212) — the folder's own description.
    b.note({
      space: 'reader-cases',
      path: 'reading/index.md',
      title: 'Reading list',
      content:
        '# Reading list\n\nThe folder page for `reading/` — a single, very long page exercising the whole reader: [[The long read]].\n',
      tags: ['reading'],
      created: daysBefore(now, 21, 9),
      principal: 'user:sergey',
    })

    return b.build()
  },
}
