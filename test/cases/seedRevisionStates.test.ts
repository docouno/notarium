import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'

import { decodeDocumentState } from '@notarium/core'

import { mergeWorlds } from './build'
import { WorldBuilder } from './generators'
import { materializeRevisionState } from './revisionStates'
import type { RevisionStateDecl } from './types'

const date = '2026-08-01T12:00:00.000Z'

const exactDeclaration: RevisionStateDecl = {
  note: 'n-1',
  date,
  state: {
    kind: 'document',
    source: {
      encoding: 'utf8',
      data: '---\r\n# kept\r\nnotarium-id: "{{noteId}}"\r\ntitle: Ω\r\n---\r\nBody  \r\n',
    },
    ownerClaims: [{ key: 'notarium-id', ownership: 'value' }],
  },
}

const materialize = (declaration: RevisionStateDecl, noteId = 'note-a') =>
  materializeRevisionState(declaration, {
    noteId,
    path: 'restore/exact.md',
    createdAt: '2026-07-01T12:00:00.000Z',
    title: 'Fallback',
  })

describe('seed revision states (#275)', () => {
  it('preserves exact source while excluding proven owner values from semantic identity', () => {
    const first = materialize(exactDeclaration, 'note-a')
    const second = materialize(exactDeclaration, 'note-b')

    expect(first.stateFormat).toBe('markdown-v2')
    expect(first.restoreSafety).toBe('safe')
    expect(first.restoreAvailability).toBe('full')
    expect(first.semanticFingerprint).toBe(second.semanticFingerprint)
    expect(first.blob).not.toEqual(second.blob)

    const decoded = decodeDocumentState(first.blob as Uint8Array)
    expect(new TextDecoder().decode(decoded.source)).toBe(
      '---\r\n# kept\r\nnotarium-id: "note-a"\r\ntitle: Ω\r\n---\r\nBody  \r\n',
    )
  })

  it('materializes legacy, gap and arbitrary bytes without inventing Markdown', () => {
    expect(
      materialize({ note: 'n-1', date, state: { kind: 'legacy', content: 'old body' } }),
    ).toMatchObject({ stateFormat: null, restoreAvailability: 'partial', content: 'old body' })
    expect(materialize({ note: 'n-1', date, state: { kind: 'gap' } })).toMatchObject({
      blob: null,
      stateFormat: null,
      restoreAvailability: 'gap',
    })

    const opaque = materialize({
      note: 'n-1',
      date,
      state: { kind: 'document', source: { encoding: 'base64', data: '/wD+YQ==' } },
    })

    expect(opaque.stateFormat).toBe('opaque-v1')
    expect(opaque.restoreAvailability).toBe('opaque')
    expect(Buffer.from(decodeDocumentState(opaque.blob as Uint8Array).source)).toEqual(
      Buffer.from([0xff, 0x00, 0xfe, 0x61]),
    )
  })

  it('deduplicates identical declarations and rejects an incompatible duplicate', () => {
    const builder = new WorldBuilder(new Date('2026-08-12T12:00:00.000Z'))
    builder.space({ slug: 'main' })
    const note = builder.note({
      space: 'main',
      path: 'note.md',
      title: 'Note',
      created: '2026-07-01T12:00:00.000Z',
    })
    const declaration = { ...exactDeclaration, note }

    builder.revisionState(declaration).revisionState(declaration)
    expect(builder.build().revisionStates).toEqual([declaration])
    expect(() => builder.revisionState({ ...declaration, state: { kind: 'gap' } })).toThrow(
      /conflicting revision state/,
    )
  })

  it('namespaces dependencies and preserves case/declaration order when worlds merge', () => {
    const world = (title: string) => {
      const builder = new WorldBuilder(new Date('2026-08-12T12:00:00.000Z'))
      builder.space({ slug: 'main' })
      const note = builder.note({
        space: 'main',
        path: `${title}.md`,
        title,
        created: '2026-07-01T12:00:00.000Z',
      })
      builder.revisionState({ note, date, state: { kind: 'gap' } })
      return builder.build()
    }
    const merged = mergeWorlds([
      { name: 'a', world: world('A') },
      { name: 'b', world: world('B') },
    ])

    expect(merged.revisionStates?.map((state) => state.note)).toEqual(['a:n-1', 'b:n-1'])
  })
})
