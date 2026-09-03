import { composeNote, CORPUS } from '../corpus'
import { daysBefore, WorldBuilder } from '../generators'
import type { CaseSpec } from '../types'

export const POSITION_SENTINEL = {
  structuredQuarter: 'POSITION-STRUCTURED-QUARTER',
  structuredThreeQuarters: 'POSITION-STRUCTURED-THREE-QUARTERS',
  flatFirst: 'POSITION-FLAT-FIRST',
  flatSecond: 'POSITION-FLAT-SECOND',
} as const

const positionParagraphs = (count: number, sentinels: ReadonlyMap<number, string>): string[] =>
  Array.from(
    { length: count },
    (_, index) =>
      sentinels.get(index) ?? `Position witness paragraph ${String(index + 1).padStart(3, '0')}.`,
  )

const structuredPositionDocument = [
  '# Structured position witness',
  '',
  '## One stable ATX section',
  '',
  ...positionParagraphs(
    420,
    new Map([
      [104, POSITION_SENTINEL.structuredQuarter],
      [314, POSITION_SENTINEL.structuredThreeQuarters],
    ]),
  ).flatMap((line) => [line, '']),
].join('\n')

const flatPositionDocument = [
  '# Flat position witness',
  '',
  ...positionParagraphs(
    420,
    new Map([
      [83, POSITION_SENTINEL.flatFirst],
      [335, POSITION_SENTINEL.flatSecond],
    ]),
  ).flatMap((line) => [line, '']),
].join('\n')

// One very LONG note that stitches the whole content corpus into a single page — the
// case for reading typography S/M/L/XL (#27/#189), the document outline, long-scroll
// virtualization and the history-diff surface at length. Also the honest perf note:
// every feature rendered at once on one page. A short list note links into it.
export const longDocument: CaseSpec = {
  name: 'long-document',
  description:
    'A rich long note plus structured and flat semantic-position witnesses for reader/editor round-trips at scale.',
  axes: ['content', 'editor', 'scale', 'history'],
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

    b.note({
      space: 'reader-cases',
      path: 'reading/structured-position-witness.md',
      title: 'Structured position witness',
      content: structuredPositionDocument,
      tags: ['reading', 'position'],
      created: daysBefore(now, 18, 10),
      principal: 'user:sergey',
    })

    b.note({
      space: 'reader-cases',
      path: 'reading/flat-position-witness.md',
      title: 'Flat position witness',
      content: flatPositionDocument,
      tags: ['reading', 'position'],
      created: daysBefore(now, 17, 10),
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
