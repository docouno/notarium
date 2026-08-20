import { describe, expect, it, vi } from 'vitest'

import { claudeConversationSourceLocator } from '../../../importer'
import type { NoteContent, NoteMeta, RevisionInput } from '../../../knowledgeStore'
import { DOCUMENT_ROLE } from '../../../libs/markdown'
import { analyzeDocumentState } from '../../../libs/markdown'
import { type MutationClaim, MutationCoordinator } from '../../../libs/mutationCoordinator'
import { noteFilePath } from '../../../libs/path'
import { NotesMap } from '../snapshot/notesMap'
import type { WriteHost } from './types'
import { WriteEngine } from './writeEngine'

const PACKAGE_DIR = '.notarium/skills/my-role'

/** One package member and nothing else: the fence questions under test are answered
 *  from the snapshot row and the caller's intent, never from the medium. */
const hostFor = (
  notes: Map<string, NoteMeta>,
  overrides: Partial<WriteHost> = {},
): { host: WriteHost; journalled: RevisionInput[] } => {
  const journalled: RevisionInput[] = []
  const host = {
    inner: {
      capabilities: { identity: false },
      read: vi.fn(),
      write: vi.fn(),
      remove: vi.fn(),
    },
    snap: {
      notes: Object.assign(notes, {
        idsAt:
          'idsAt' in notes
            ? (notes as NotesMap).idsAt.bind(notes)
            : (path: string) =>
                [...notes].filter(([, meta]) => meta.filePath === path).map(([id]) => id),
        idsWithSourceLocator:
          'idsWithSourceLocator' in notes
            ? (notes as NotesMap).idsWithSourceLocator.bind(notes)
            : (locator: string) =>
                [...notes].filter(([, meta]) => meta.sourceLocator === locator).map(([id]) => id),
      }),
      resolvedTargetIds: () => [],
      sourceIdsTargeting: () => [],
      edgesBySource: new Map(),
      batchIndex: () => undefined,
    },
    identity: {
      pathFor: (id: string) => notes.get(id)?.filePath,
      idFor: () => undefined,
      recordFor: () => undefined,
      bindOwnedId: vi.fn(),
      markDeleted: vi.fn(),
    },
    journal: {
      record: async (revision: RevisionInput) => {
        journalled.push(revision)
      },
    },
    previewCache: { delete: vi.fn() },
    dirs: { has: () => true },
    iso: () => '2026-08-18T00:00:00.000Z',
    reconcileSoon: vi.fn(),
    afterNotesReady: (patch: () => void) => patch(),
    rederiveSources: async () => {},
    rederiveGraphContext: async () => {},
    beginGraphTransition: () => () => {},
    markInnerLinkIdentitiesDirty: vi.fn(),
    syncInnerLinkIdentities: vi.fn(),
    flushIdentityPublication: async () => {},
    captureLegacyEvidence: async (finalId: string) => ({ id: finalId }),
    emitChanged: vi.fn(),
    isBulkActive: () => false,
    ...overrides,
  } as unknown as WriteHost

  return { host, journalled }
}

describe('WriteEngine destination fence', () => {
  /** `<pkg>/references/SKILL.md` ends like a manifest and is an auxiliary: the engine
   *  renames it, so the claim the fence takes has to cover where it lands. */
  it('claims where a renamed package auxiliary really goes', async () => {
    const path = `${PACKAGE_DIR}/references/SKILL.md`
    const claims: MutationClaim[] = []

    class ClaimSpy extends MutationCoordinator {
      async runStable<T>(claimFor: () => MutationClaim): Promise<T> {
        claims.push(claimFor())
        throw new Error('claim captured')
      }
    }
    const { host } = hostFor(
      new Map([
        ['aux-note-id', { id: 'aux-note-id', title: 'Helper', class: 'skill', filePath: path }],
      ] as Array<[string, NoteMeta]>),
    )
    const engine = new WriteEngine(host, { mutations: new ClaimSpy() })

    await expect(
      engine.write({
        originalId: 'aux-note-id',
        title: 'Field Notes',
        content: 'body\n',
        versionToken: 'v1',
      }),
    ).rejects.toThrow('claim captured')
    expect([...(claims[0]?.paths ?? [])]).toContain(
      noteFilePath('Field Notes', `${PACKAGE_DIR}/references`, undefined, 'aux-note-id'),
    )
  })

  it('claims and re-checks a source-less legacy predecessor with the canonical create', async () => {
    const legacyPath = 'conversations/claude/legacy.md'
    const canonicalPath = 'conversations/claude/canonical.md'
    const notes = new Map<string, NoteMeta>([
      [
        'legacy-id',
        {
          id: 'legacy-id',
          title: 'Legacy',
          filePath: legacyPath,
          modifiedAt: null,
          createdAt: null,
        },
      ],
    ])
    const claims: MutationClaim[] = []

    const coordinator = new MutationCoordinator()
    const runStable = coordinator.runStable.bind(coordinator)
    vi.spyOn(coordinator, 'runStable').mockImplementation(async (claimFor, operation) => {
      claims.push(claimFor())
      return runStable(claimFor, operation)
    })
    const { host } = hostFor(notes)
    const engine = new WriteEngine(host, { mutations: coordinator })

    await expect(
      engine.write({
        id: 'fresh-id',
        title: 'Canonical',
        content: 'body',
        directory: 'conversations/claude',
        fileName: 'canonical',
        sourceLocator: claudeConversationSourceLocator('source-1')!,
        expectedDestinationId: null,
        legacyPredecessorPath: legacyPath,
      }),
    ).rejects.toMatchObject({ reason: 'destination_owner_conflict' })
    expect(claims[0].paths).toEqual(expect.arrayContaining([canonicalPath, legacyPath]))
    expect(host.inner.write).not.toHaveBeenCalled()
  })

  it('re-checks a locator owner through the reverse index without walking the corpus', async () => {
    const notes = new NotesMap()
    const locator = claudeConversationSourceLocator('indexed-owner')!

    for (let index = 0; index < 50_000; index++) {
      notes.set(`note-${index}`, {
        id: `note-${index}`,
        title: `Note ${index}`,
        filePath: `notes/${index}.md`,
        modifiedAt: null,
        createdAt: null,
      })
    }
    notes.set('source-owner', {
      id: 'source-owner',
      title: 'Owner',
      filePath: 'owner.md',
      sourceLocator: locator,
      modifiedAt: null,
      createdAt: null,
    })
    Object.defineProperty(notes, Symbol.iterator, {
      value: () => {
        throw new Error('source lookup walked the corpus')
      },
    })
    const { host } = hostFor(notes)

    await expect(
      new WriteEngine(host).write({
        id: 'fresh-id',
        title: 'Fresh',
        content: 'body',
        fileName: 'fresh',
        sourceLocator: locator,
        expectedDestinationId: null,
      }),
    ).rejects.toMatchObject({
      reason: 'destination_owner_conflict',
      message: expect.stringContaining('source locator is already owned by source-owner'),
    })
    expect(host.inner.write).not.toHaveBeenCalled()
  })
})

describe('WriteEngine tombstone', () => {
  /** The trash is an ordinary user surface, so a deleted package is signed with the
   *  title its manifest displays, not with the machine name that addresses it. */
  it('records a deleted package under its human title', async () => {
    const source = new TextEncoder().encode(
      '---\nname: my-role\ndescription: A role.\n---\n\n# My Role\n\nInstructions.\n',
    )
    const documentState = analyzeDocumentState({
      source,
      role: DOCUMENT_ROLE.skillRoot,
      skillDirectoryName: 'my-role',
      pathFallbackTitle: 'SKILL',
    })

    expect(documentState.projection?.skill).toMatchObject({ name: 'my-role', title: 'My Role' })
    const live = {
      id: 'role-note-id',
      title: 'My Role',
      class: 'skill',
      filePath: `${PACKAGE_DIR}/SKILL.md`,
      content: 'Instructions.\n',
      frontmatter: {},
      documentState,
      physicalIncarnation: { adapterId: 'test', claim: { kind: 'test', value: '1' } },
    } as unknown as NoteContent
    const { host, journalled } = hostFor(
      new Map([
        [
          'role-note-id',
          {
            id: 'role-note-id',
            title: 'my-role',
            class: 'skill',
            filePath: `${PACKAGE_DIR}/SKILL.md`,
          },
        ],
      ] as Array<[string, NoteMeta]>),
    )
    ;(host.inner.read as ReturnType<typeof vi.fn>).mockResolvedValue(live)

    await new WriteEngine(host).remove('role-note-id')
    expect(journalled).toHaveLength(1)
    expect(journalled[0]).toMatchObject({ noteId: 'role-note-id', title: 'My Role' })
  })
})
