import { describe, expect, it } from 'vitest'

import { NoteDetailResponseSchema, NoteRevisionDetailResponseSchema } from '@notarium/contract'
import {
  analyzeDocumentState,
  type NoteContent,
  type NoteMeta,
  type RevisionDetail,
  sha256Hex,
} from '@notarium/core'

import {
  conflictToWire,
  noteDetailToWire,
  noteToWire,
  revisionDetailToWire,
  searchResultToWire,
} from './wire'

describe('note list wire', () => {
  it('projects protected type and view marker separately from requested custom card fields', () => {
    const note: NoteMeta = {
      id: 'note-1',
      title: 'Task',
      filePath: 'task.md',
      modifiedAt: null,
      createdAt: null,
      noteType: 'task',
      viewType: 'board',
      fields: {
        keys: { status: 'doing', hidden: 'kept-off-wire' },
        truncated: ['type', 'view'],
      },
    }

    expect(noteToWire(note, ['status'])).toMatchObject({
      noteType: 'task',
      viewType: 'board',
      fields: { status: 'doing' },
    })
    expect(noteToWire({ ...note, noteType: undefined, fields: { keys: {} } })).toMatchObject({
      noteType: 'note',
    })
  })

  it('keeps the dedicated marker on search discovery rows', () => {
    expect(
      searchResultToWire({
        id: 'view-1',
        title: 'Board',
        snippet: 'Sprint prose',
        viewType: 'board',
      }),
    ).toMatchObject({ id: 'view-1', viewType: 'board' })
  })
})

const baseRevision = (overrides: Partial<RevisionDetail> = {}): RevisionDetail => ({
  id: 'revision-1',
  noteId: 'note-1',
  space: 'space-1',
  baseRevisionId: null,
  theirRevisionId: null,
  sourceRevisionId: null,
  kind: 'write',
  entryRole: 'origin',
  principal: 'ui',
  contentHash: 'hash',
  semanticFingerprint: null,
  restoreSafety: null,
  stateFormat: null,
  title: 'State',
  slug: null,
  class: 'user-doc',
  tags: [],
  createdAt: '2026-08-12T00:00:00.000Z',
  charsAdded: null,
  charsRemoved: null,
  content: 'body\n',
  logicalState: null,
  documentState: null,
  ...overrides,
})

const parseWire = (revision: RevisionDetail, strictRestoreAvailable = true) =>
  NoteRevisionDetailResponseSchema.parse({
    ...revisionDetailToWire(revision, strictRestoreAvailable),
    author: null,
  })

describe('revision detail wire', () => {
  it('serves exact authored Markdown separately from its readable body', async () => {
    const source = new TextEncoder().encode(
      '---\n# authored comment\ntitle: Historical\nplugin: keep\n---\nbody  \n',
    )
    const state = analyzeDocumentState({ source, pathFallbackTitle: 'state' })
    const wire = parseWire(
      baseRevision({
        contentHash: await sha256Hex(source),
        semanticFingerprint: state.semanticFingerprint,
        restoreSafety: state.restoreSafety.status,
        stateFormat: state.format,
        content: state.projection?.body ?? null,
        documentState: state,
      }),
    )

    expect(wire).toMatchObject({
      contentMode: 'markdown',
      content: 'body  \n',
      snapshot: new TextDecoder().decode(source),
      restoreAvailability: 'full',
      stateFormat: 'markdown-v2',
    })
  })

  it('serves opaque source as bytes and never as Markdown content', async () => {
    const source = Uint8Array.from([0xff, 0x00, 0xfe, 0x61])
    const state = analyzeDocumentState({ source, pathFallbackTitle: 'opaque' })
    const wire = parseWire(
      baseRevision({
        contentHash: await sha256Hex(source),
        semanticFingerprint: state.semanticFingerprint,
        restoreSafety: state.restoreSafety.status,
        stateFormat: state.format,
        content: null,
        documentState: state,
      }),
    )

    expect(wire).toEqual(
      expect.objectContaining({
        contentMode: 'source',
        content: null,
        snapshot: null,
        source: { encoding: 'base64', data: Buffer.from(source).toString('base64') },
        restoreAvailability: 'opaque',
        stateFormat: 'opaque-v1',
      }),
    )
  })

  it('distinguishes an honest gap from missing strict-restore capability', () => {
    const gap = parseWire(
      baseRevision({ contentHash: null, content: null, stateFormat: null, restoreSafety: null }),
    )
    const legacyWithoutCapability = parseWire(baseRevision(), false)

    expect(gap).toMatchObject({
      contentMode: 'gap',
      content: null,
      snapshot: null,
      restoreAvailability: 'gap',
    })
    expect(legacyWithoutCapability).toMatchObject({
      contentMode: 'markdown',
      restoreAvailability: 'capability-unavailable',
    })
  })
})

describe('deleted note detail wire', () => {
  const deleted = (restoreAvailability: NonNullable<NoteContent['restoreAvailability']>) =>
    ({
      id: 'note-1',
      title: 'Deleted state',
      content: 'inspectable bytes',
      frontmatter: {},
      versionToken: '',
      deleted: true,
      deletedAt: '2026-08-12T00:00:00.000Z',
      deletedByPrincipal: 'ui',
      restorable: true,
      restoreAvailability,
    }) satisfies NoteContent

  it('keeps inspectable bytes separate from intrinsically blocked restore', () => {
    const wire = NoteDetailResponseSchema.parse(
      noteDetailToWire(deleted('blocked'), 'main', null, true),
    )

    expect(wire).toMatchObject({
      deleted: true,
      restorable: true,
      restoreAvailability: 'blocked',
    })
  })

  it('projects missing strict publication capability without hiding the preview', () => {
    const wire = NoteDetailResponseSchema.parse(
      noteDetailToWire(deleted('full'), 'main', null, false),
    )

    expect(wire).toMatchObject({
      deleted: true,
      restorable: true,
      restoreAvailability: 'capability-unavailable',
    })
  })

  it.each([
    {
      name: 'literal UTF-8',
      source: new TextEncoder().encode(
        '---\nname: invalid--package\ndescription: invalid name\n---\n# literal **source**\n',
      ),
      expected: {
        encoding: 'utf8' as const,
        data: '---\nname: invalid--package\ndescription: invalid name\n---\n# literal **source**\n',
      },
    },
    {
      name: 'base64 for arbitrary bytes',
      source: Uint8Array.from([0xff, 0x00, 0xfe, 0x61]),
      expected: { encoding: 'base64' as const, data: '/wD+YQ==' },
    },
  ])('serves opaque deleted $name outside Markdown content', ({ source, expected }) => {
    const documentState = analyzeDocumentState({
      source,
      role: 'skill-root',
      pathFallbackTitle: 'opaque',
      skillDirectoryName: 'opaque',
    })
    const wire = NoteDetailResponseSchema.parse(
      noteDetailToWire({ ...deleted('opaque'), content: '', documentState }, 'main', null, true),
    )

    expect(documentState.format).toBe('opaque-v1')
    expect(wire).toMatchObject({ content: '', source: expected, restoreAvailability: 'opaque' })
  })
})

describe('live note detail wire', () => {
  const live = (source: string, pathFallbackTitle: string): NoteContent => {
    const documentState = analyzeDocumentState({
      source: new TextEncoder().encode(source),
      pathFallbackTitle,
    })

    return {
      id: 'note-1',
      title: documentState.projection?.title ?? pathFallbackTitle,
      class: 'user-doc',
      filePath: 'note.md',
      content: documentState.projection?.body ?? '',
      frontmatter: documentState.projection?.frontmatter ?? {},
      documentState,
      modifiedAt: null,
      createdAt: null,
      versionToken: 'version-1',
    }
  }

  it('preserves a hidden authored H1 separately from the note identity title', () => {
    const wire = NoteDetailResponseSchema.parse(
      noteDetailToWire(live('# Authored title\n\nBody.\n', 'identity-title')),
    )

    expect(wire).toMatchObject({
      title: 'Authored title',
      documentTitle: 'Authored title',
      content: 'Body.\n',
    })
  })

  it('preserves the H1 coupled to frontmatter title', () => {
    const wire = NoteDetailResponseSchema.parse(
      noteDetailToWire(
        live('---\ntitle: Authored title\n---\n\n# Authored title\n\nBody.\n', 'identity-title'),
      ),
    )

    expect(wire).toMatchObject({
      title: 'Authored title',
      documentTitle: 'Authored title',
      content: 'Body.\n',
    })
  })

  it('derives full detail fields and authored order from the document projection', () => {
    const source = [
      '---',
      'title: Fields',
      'alpha: one',
      'broken:',
      '  nested: value',
      'reviewers:',
      '- ann',
      '- bo',
      '---',
      '',
      '# Fields',
      '',
    ].join('\n')
    const wire = NoteDetailResponseSchema.parse(noteDetailToWire(live(source, 'fields')))

    expect((wire as Record<string, unknown>).fields).toEqual({
      keys: { alpha: 'one', reviewers: ['ann', 'bo'] },
      unreadable: ['broken'],
      order: ['title', 'alpha', 'broken', 'reviewers'],
    })
  })

  it('uses the full detail mapper for a version-conflict current note', () => {
    const current = live(
      '---\ntype: task\nstatus: doing\ncreated: 2026-08-24\n---\n\n# Fields\n\nBody.\n',
      'fields',
    ) as NoteContent & { id: string; versionToken: string }

    expect(NoteDetailResponseSchema.parse(conflictToWire(current))).toEqual(
      NoteDetailResponseSchema.parse(noteDetailToWire(current)),
    )
  })
})
