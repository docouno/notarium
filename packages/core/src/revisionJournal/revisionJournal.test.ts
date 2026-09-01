import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  activityProjectionInvalid,
  REVISION_ENTRY_ROLE,
  REVISION_KIND,
  STORE_ERROR_REASON,
} from '../knowledgeStore'
import { sha256Hex } from '../libs/hash'
import * as markdown from '../libs/markdown'
import { decodeActivityVersion, encodeActivityVersion } from './helpers'
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

describe('RevisionJournal Activity projection lifecycle', () => {
  it('uses a strict no-secret Activity version codec bound to the space', () => {
    const token = encodeActivityVersion('space-a', {
      through: '42',
      activeGeneration: '7',
      sourceGeneration: '3',
    })

    expect(decodeActivityVersion('space-a', token)).toEqual({
      v: 1,
      space: 'space-a',
      activeGeneration: '7',
      sourceGeneration: '3',
    })
    expect(() => decodeActivityVersion('space-b', token)).toThrow(
      expect.objectContaining({ reason: STORE_ERROR_REASON.activityProjectionInvalid }),
    )
    const extraKey = btoa(
      JSON.stringify({
        v: 1,
        space: 'space-a',
        activeGeneration: '7',
        sourceGeneration: '3',
        mac: 'not-allowed',
      }),
    )
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replace(/=+$/, '')

    expect(() => decodeActivityVersion('space-a', extraKey)).toThrow(
      expect.objectContaining({ reason: activityProjectionInvalid().reason }),
    )
  })

  it('starts one bounded maintenance loop and emits ready once after publication', async () => {
    const persistence = new InMemoryRevisionPersistence()
    const prepare = vi
      .spyOn(persistence, 'prepareActivityProjection')
      .mockResolvedValue({ state: 'rebuilding' })
    const maintain = vi
      .spyOn(persistence, 'maintainActivityProjection')
      .mockResolvedValue({ state: 'ready', processed: 2, published: true })
    const gc = vi
      .spyOn(persistence, 'maintainActivityProjectionGc')
      .mockResolvedValue({ deleted: 0, pending: false })
    const turns: Array<() => void> = []
    const ready = vi.fn()
    const journal = new RevisionJournal({
      persistence,
      space: 'space-a',
      scheduler: {
        awaitTurn: () => new Promise<void>((resolve) => turns.push(resolve)),
      },
      onActivityProjectionReady: ready,
    })

    await Promise.all([journal.prepareActivityProjection(), journal.prepareActivityProjection()])
    expect(prepare).toHaveBeenCalledTimes(2)
    await vi.waitFor(() => expect(turns).toHaveLength(1))
    turns[0]!()
    await vi.waitFor(() => expect(ready).toHaveBeenCalledOnce())
    expect(maintain).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(turns).toHaveLength(2))
    turns[1]!()
    await vi.waitFor(() => expect(gc).toHaveBeenCalledOnce())
    expect(gc).toHaveBeenCalledOnce()
    await journal.stopActivityProjection()
  })

  it('returns from generation GC to a rebuild requested by a concurrent prepare', async () => {
    const persistence = new InMemoryRevisionPersistence()
    let invalidated = false
    const prepare = vi
      .spyOn(persistence, 'prepareActivityProjection')
      .mockImplementation(async () =>
        invalidated
          ? { state: 'rebuilding' }
          : {
              state: 'ready',
              lease: { through: null, activeGeneration: '1', sourceGeneration: '1' },
            },
      )
    const maintain = vi
      .spyOn(persistence, 'maintainActivityProjection')
      .mockResolvedValueOnce({ state: 'ready', processed: 0, published: false })
      .mockResolvedValueOnce({ state: 'ready', processed: 2, published: true })
    const gc = vi
      .spyOn(persistence, 'maintainActivityProjectionGc')
      .mockResolvedValue({ deleted: 1, pending: true })
    const turns: Array<() => void> = []
    const ready = vi.fn()
    const journal = new RevisionJournal({
      persistence,
      space: 'space-a',
      scheduler: {
        awaitTurn: () => new Promise<void>((resolve) => turns.push(resolve)),
      },
      onActivityProjectionReady: ready,
    })

    await journal.prepareActivityProjection()
    await vi.waitFor(() => expect(turns).toHaveLength(1))
    turns.shift()!()
    await vi.waitFor(() => expect(maintain).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(turns).toHaveLength(1))
    turns.shift()!()
    await vi.waitFor(() => expect(gc).toHaveBeenCalledOnce())

    invalidated = true
    await expect(journal.prepareActivityProjection()).resolves.toEqual({ state: 'rebuilding' })
    expect(prepare).toHaveBeenCalledTimes(2)
    await vi.waitFor(() => expect(turns).toHaveLength(1))
    turns.shift()!()
    await vi.waitFor(() => expect(maintain).toHaveBeenCalledTimes(2))
    expect(ready).toHaveBeenCalledOnce()

    await journal.stopActivityProjection()
  })

  it('keeps every grouped response on one opaque lease and rejects malformed pairs', async () => {
    const persistence = new InMemoryRevisionPersistence()
    const journal = new RevisionJournal({ persistence, space: 'space-a' })

    await persistence.append(
      {
        noteId: 'note-a',
        space: 'space-a',
        baseRevisionId: null,
        theirRevisionId: null,
        sourceRevisionId: null,
        kind: REVISION_KIND.write,
        entryRole: REVISION_ENTRY_ROLE.origin,
        principal: 'user:alice',
        contentHash: 'a',
        title: 'A',
        class: 'user-doc',
        slug: null,
        tags: [],
        createdAt: '2026-08-30T00:00:00.000Z',
        charsAdded: 1,
        charsRemoved: 0,
      },
      'a',
    )
    const current = await journal.activityGroupsByNote({
      viewerAuthor: { exact: ['user:alice'], prefixes: [] },
    })

    expect(current).toMatchObject({
      through: '1',
      scopeGate: { hasOtherAuthors: false, through: '1' },
    })
    await expect(journal.activityGroupsByNote({ through: current.through! })).rejects.toMatchObject(
      { reason: STORE_ERROR_REASON.activityProjectionInvalid },
    )
    await expect(
      journal.activityGroupsByNote({
        through: current.through!,
        activityVersion: `${current.activityVersion}.tampered`,
      }),
    ).rejects.toMatchObject({ reason: STORE_ERROR_REASON.activityProjectionInvalid })
    persistence.quarantineForTest(['1'])
    await expect(
      journal.activityGroupsByNote({
        through: current.through!,
        activityVersion: current.activityVersion,
      }),
    ).rejects.toMatchObject({ reason: STORE_ERROR_REASON.activityProjectionStale })
    await journal.stopActivityProjection()
  })
})
