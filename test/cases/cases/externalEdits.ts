import { daysBefore, WorldBuilder } from '../generators'
import type { CaseSpec } from '../types'

/** The exact #267 failure shape: an editor changes search-visible body text and a
 *  graph edge without changing file size or mtime. The real seed writes the
 *  initial version through the production store, then mutates the markdown file
 *  behind its back. On the restarted stand, list/search/graph must all converge
 *  to the replacement content.
 *
 *  It also carries file SHAPES that must be planted as exact bytes, because they arrive
 *  by the same route — a writer that is not us. They are real-stand only: the fake has no
 *  files, so it shows the notes normalized. */
export const externalEdits: CaseSpec = {
  name: 'external-edits',
  description:
    'A same-size, mtime-preserving external file edit that changes body search text and moves a wikilink edge (#267).',
  axes: ['search', 'graph', 'content'],
  build: ({ now }) => {
    const b = new WorldBuilder(now)
    b.space({ slug: 'main', displayName: 'Main' })
    b.note({
      space: 'main',
      path: 'external/target-a.md',
      title: 'Target A',
      content: '# Target A\n\nThe original graph destination.',
      created: daysBefore(now, 12),
      principal: 'user:sergey',
    })
    b.note({
      space: 'main',
      path: 'external/target-b.md',
      title: 'Target B',
      content: '# Target B\n\nThe replacement graph destination.',
      created: daysBefore(now, 11),
      principal: 'user:sergey',
    })
    const probe = b.note({
      space: 'main',
      path: 'external/probe.md',
      title: 'External edit probe',
      content:
        '# External edit probe\n\nSearch marker: stale-token.\n\nGraph destination: [[Target A]].',
      created: daysBefore(now, 10),
      principal: 'user:sergey',
    })
    b.externalRewrite({
      note: probe,
      replacements: [
        { from: 'stale-token', to: 'fresh-token' },
        { from: '[[Target A]]', to: '[[Target B]]' },
      ],
    })
    // A file a converter led with a UTF-8 mark. Saving this note must not quietly drop
    // that byte — the mark belongs to the file, not to anything Notarium projects.
    const marked = b.note({
      space: 'main',
      path: 'external/byte-order-marked.md',
      title: 'Byte-order marked',
      content: '# Byte-order marked\n\nPlaceholder replaced on disk.',
      created: daysBefore(now, 9),
      principal: 'user:sergey',
    })

    b.externalSource({
      note: marked,
      source: {
        encoding: 'utf8',
        data:
          '\uFEFF---\ntitle: Byte-order marked\nnotarium-id: {{noteId}}\n---\n\n' +
          '# Byte-order marked\n\nA converter stamped this file with an encoding prologue.\n',
      },
    })
    // Prose that OPENS with a horizontal rule. The planted file begins with a separator
    // blank; after read normalization the shared body predicate still keeps its
    // record-less block as content. Save/export/preview must retain the first paragraph.
    const ruled = b.note({
      space: 'main',
      path: 'external/rule-led-prose.md',
      title: 'Rule-led prose',
      content: '# Rule-led prose\n\nPlaceholder replaced on disk.',
      created: daysBefore(now, 8),
      principal: 'user:sergey',
    })

    b.externalSource({
      note: ruled,
      source: {
        encoding: 'utf8',
        data: '\n---\nA thought I wrote between two rules.\n---\nAnd the rest.\n',
      },
    })
    // A complete storage-form CRLF note. Editing one body line through edit_note must
    // preserve the authored title quoting, list indentation and every other terminator.
    const crlf = b.note({
      space: 'main',
      path: 'external/crlf-preserved.md',
      title: 'CRLF preserved',
      content: '# CRLF preserved\n\nPlaceholder replaced on disk.',
      created: daysBefore(now, 7),
      principal: 'user:sergey',
    })

    b.externalSource({
      note: crlf,
      source: {
        encoding: 'utf8',
        data:
          '---\r\ntitle: "CRLF preserved"\r\ntags:\r\n  - external\r\n  - crlf\r\n' +
          'notarium-id: {{noteId}}\r\n---\r\n\r\n# CRLF preserved\r\n\r\n' +
          'Body line one.\r\nBody line two.\r\n',
      },
    })

    return b.build()
  },
}
