import { beforeEach, describe, expect, it, vi } from 'vitest'

import { REVISION_ENTRY_ROLE, REVISION_KIND } from '../knowledgeStore'
import { sha256Hex } from '../libs/hash'
import * as markdown from '../libs/markdown'
import { InMemoryRevisionPersistence } from './inMemoryRevisionPersistence'
import { RevisionJournal } from './revisionJournal'

const counters = vi.hoisted(() => ({ decodes: 0 }))

vi.mock('../libs/markdown', async (importOriginal) => {
  const actual = await importOriginal<typeof markdown>()

  return {
    ...actual,
    decodeDocumentState: (...args: Parameters<typeof actual.decodeDocumentState>) => {
      counters.decodes++
      return actual.decodeDocumentState(...args)
    },
  }
})

const encoder = new TextEncoder()

const recordInput = (noteId: string, body: string) => {
  const documentState = markdown.analyzeDocumentState({
    source: encoder.encode(`---\ntitle: ${noteId}\n---\n${body}`),
  })

  return {
    noteId,
    kind: REVISION_KIND.write,
    principal: 'ui',
    content: markdown.documentSourceText(documentState),
    documentState,
    title: noteId,
    class: 'user-doc',
    tags: [] as string[],
    slug: null,
  }
}

describe('RevisionJournal document pass budget', () => {
  beforeEach(() => {
    counters.decodes = 0
  })

  it('deduplicates from the projected fingerprint without fetching or decoding the blob', async () => {
    const persistence = new InMemoryRevisionPersistence()
    const journal = new RevisionJournal({ persistence, space: 'main' })
    const input = recordInput('same', 'body')

    await expect(journal.record(input)).resolves.not.toBeNull()
    counters.decodes = 0
    const content = vi.spyOn(persistence, 'content')

    await expect(journal.record(input)).resolves.toBeNull()
    expect(content).not.toHaveBeenCalled()
    expect(counters.decodes).toBe(0)
  })

  it('keeps the blob fallback for a constructed row without a projected fingerprint', async () => {
    const persistence = new InMemoryRevisionPersistence()
    const journal = new RevisionJournal({ persistence, space: 'main' })
    const input = recordInput('legacy-projection', 'body')
    const blob = markdown.encodeDocumentState(input.documentState)

    await persistence.append(
      {
        noteId: input.noteId,
        space: 'main',
        baseRevisionId: null,
        theirRevisionId: null,
        sourceRevisionId: null,
        kind: REVISION_KIND.write,
        entryRole: REVISION_ENTRY_ROLE.origin,
        principal: 'ui',
        agent: null,
        contentHash: await sha256Hex(blob),
        semanticFingerprint: null,
        restoreSafety: input.documentState.restoreSafety.status,
        stateFormat: input.documentState.format,
        title: input.title,
        class: input.class,
        slug: null,
        tags: [],
        createdAt: '2026-08-28T00:00:00.000Z',
        charsAdded: null,
        charsRemoved: null,
      },
      blob,
    )
    counters.decodes = 0

    await expect(journal.record(input)).resolves.toBeNull()
    expect(counters.decodes).toBe(1)
  })

  it('reads current text directly and decodes only the small base side', async () => {
    const journal = new RevisionJournal({
      persistence: new InMemoryRevisionPersistence(),
      space: 'main',
    })

    await journal.record(recordInput('small', 'before'))
    counters.decodes = 0
    await expect(journal.record(recordInput('small', 'after'))).resolves.not.toBeNull()
    expect(counters.decodes).toBe(1)
  })

  it('refuses an over-budget diff before decoding either document side', async () => {
    const journal = new RevisionJournal({
      persistence: new InMemoryRevisionPersistence(),
      space: 'main',
    })

    await journal.record(recordInput('large', 'a'.repeat(830_000)))
    counters.decodes = 0
    const revision = await journal.record(recordInput('large', 'b'.repeat(830_000)))

    expect(revision).toMatchObject({ charsAdded: null, charsRemoved: null })
    expect(counters.decodes).toBe(0)
  })

  it('reports a malformed frame before applying the early diff-budget refusal', async () => {
    const persistence = new InMemoryRevisionPersistence()
    const input = recordInput('malformed-large', 'b'.repeat(800_000))
    const malformedHeader = encoder.encode('{')
    const blob = new Uint8Array(8 + malformedHeader.byteLength + 900_010)

    blob.set(encoder.encode('NDS1'))
    new DataView(blob.buffer).setUint32(4, malformedHeader.byteLength)
    blob.set(malformedHeader, 8)
    await persistence.append(
      {
        noteId: input.noteId,
        space: 'main',
        baseRevisionId: null,
        theirRevisionId: null,
        sourceRevisionId: null,
        kind: REVISION_KIND.write,
        entryRole: REVISION_ENTRY_ROLE.origin,
        principal: 'ui',
        agent: null,
        contentHash: await sha256Hex(blob),
        semanticFingerprint: 'different',
        restoreSafety: input.documentState.restoreSafety.status,
        stateFormat: input.documentState.format,
        title: input.title,
        class: input.class,
        slug: null,
        tags: [],
        createdAt: '2026-08-28T00:00:00.000Z',
        charsAdded: null,
        charsRemoved: null,
      },
      blob,
    )
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {})

    const revision = await new RevisionJournal({ persistence, space: 'main' }).record(input)

    expect(revision).toMatchObject({ charsAdded: null, charsRemoved: null })
    expect(diagnostic).toHaveBeenCalledWith(
      '[journal] diff stats failed:',
      expect.stringContaining('JSON'),
    )
    diagnostic.mockRestore()
  })
})
