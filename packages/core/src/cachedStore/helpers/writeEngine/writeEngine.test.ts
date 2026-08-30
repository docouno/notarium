import { describe, expect, it, vi } from 'vitest'

import { claudeConversationSourceLocator } from '../../../importer'
import type { NoteContent, NoteMeta, RevisionInput } from '../../../knowledgeStore'
import { DOCUMENT_ROLE } from '../../../libs/markdown'
import { analyzeDocumentState } from '../../../libs/markdown'
import { type MutationClaim, MutationCoordinator } from '../../../libs/mutationCoordinator'
import { noteFilePath } from '../../../libs/path'
import { exactVersionToken } from '../exactNoteState'
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
      // Prod shape of the path-keyed engine: `capabilities.identity` is false, yet the
      // read-model registry makes the exact stable-id envelope addressable. Omitting
      // `setLinkIdentities` here would test a capability pair no engine ships.
      setLinkIdentities: vi.fn(),
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
      patchNoteEdges: vi.fn(() => false),
      edgesBySource: new Map(),
      batchIndex: () => undefined,
    },
    identity: {
      pathFor: (id: string) => notes.get(id)?.filePath,
      idFor: () => undefined,
      recordFor: () => undefined,
      bindOwnedId: vi.fn(),
      markMaterialized: vi.fn(),
      markDeleted: vi.fn(),
    },
    journal: {
      record: async (revision: RevisionInput) => {
        journalled.push(revision)
      },
    },
    previewCache: { delete: vi.fn(), set: vi.fn() },
    noteFactsCache: { delete: vi.fn() },
    dirs: { has: () => true, add: vi.fn(() => false) },
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
  it('preserves body-derived caches for a host-proven field-only intent', async () => {
    const id = 'field-only-id'
    const path = 'field-only.md'
    const meta: NoteMeta = {
      id,
      title: 'Field only',
      class: 'user-doc',
      filePath: path,
      fields: { keys: { status: 'todo' } },
      modifiedAt: null,
      createdAt: null,
    }
    const notes = new Map([[id, meta]])
    const live = {
      ...meta,
      content: 'unchanged body',
      frontmatter: { status: 'todo' },
      versionToken: 'before-token',
      physicalIncarnation: { adapterId: 'test', claim: { kind: 'test', value: 'before' } },
    } as unknown as NoteContent
    const { host } = hostFor(notes)

    ;(host.inner.read as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(live)
      .mockResolvedValue({ ...live, versionToken: 'after-token' })
    ;(host.inner.write as ReturnType<typeof vi.fn>).mockResolvedValue({
      id,
      title: meta.title,
      class: meta.class,
      filePath: path,
      versionToken: 'after-token',
    })

    await new WriteEngine(host).write({
      originalId: id,
      title: meta.title,
      content: live.content,
      versionToken: exactVersionToken(live),
      fields: { status: 'done' },
      derivedContentUnchanged: true,
    })

    expect(host.previewCache.set).not.toHaveBeenCalled()
    expect(host.noteFactsCache.delete).not.toHaveBeenCalled()
    expect(host.snap.patchNoteEdges).not.toHaveBeenCalled()
    expect(host.emitChanged).toHaveBeenCalledWith([id], [], false, false)
  })

  it.each([
    ['same derived edges', false, false],
    ['changed derived edges', true, true],
  ] as const)(
    'publishes a visible body write with %s as graphChanged=%s',
    async (_label, edgesChanged, expected) => {
      const id = 'visible-note-id'
      const path = 'visible.md'
      const notes = new Map<string, NoteMeta>([
        [
          id,
          {
            id,
            title: 'Visible',
            class: 'user-doc',
            filePath: path,
            modifiedAt: null,
            createdAt: null,
          },
        ],
      ])
      const live = {
        id,
        title: 'Visible',
        class: 'user-doc',
        filePath: path,
        content: 'before',
        frontmatter: {},
        versionToken: 'before-token',
        physicalIncarnation: { adapterId: 'test', claim: { kind: 'test', value: 'before' } },
      } as unknown as NoteContent
      const after = { ...live, content: 'after', versionToken: 'after-token' }
      const { host } = hostFor(notes)

      ;(host.snap.patchNoteEdges as ReturnType<typeof vi.fn>).mockReturnValue(edgesChanged)
      ;(host.inner.read as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(live)
        .mockResolvedValue(after)
      ;(host.inner.write as ReturnType<typeof vi.fn>).mockResolvedValue({
        id,
        title: 'Visible',
        class: 'user-doc',
        filePath: path,
        versionToken: 'after-token',
      })

      await new WriteEngine(host).write({
        originalId: id,
        title: 'Visible',
        content: 'after',
        versionToken: exactVersionToken(live),
      })

      expect(host.emitChanged).toHaveBeenCalledWith([id], [], expected, false)
    },
  )

  it('does not turn an oversized post-write body projection into a failed mutation', async () => {
    const id = 'oversized-body-id'
    const path = 'oversized.md'
    const content = `---\n${'x'.repeat(70 * 1024)}\n---\nrest\n`
    const notes = new Map<string, NoteMeta>([
      [
        id,
        {
          id,
          title: 'Oversized',
          class: 'user-doc',
          filePath: path,
          modifiedAt: null,
          createdAt: null,
        },
      ],
    ])
    const live = {
      id,
      title: 'Oversized',
      class: 'user-doc',
      filePath: path,
      content: 'before',
      frontmatter: {},
      versionToken: 'before-token',
      physicalIncarnation: { adapterId: 'test', claim: { kind: 'test', value: 'before' } },
    } as unknown as NoteContent
    const after = { ...live, content, versionToken: 'after-token' }
    const { host } = hostFor(notes)

    ;(host.inner.read as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(live)
      .mockResolvedValue(after)
    ;(host.inner.write as ReturnType<typeof vi.fn>).mockResolvedValue({
      id,
      title: 'Oversized',
      class: 'user-doc',
      filePath: path,
      versionToken: 'after-token',
    })

    await expect(
      new WriteEngine(host).write({
        originalId: id,
        title: 'Oversized',
        content,
        frontmatterMode: 'replace',
        versionToken: exactVersionToken(live),
      }),
    ).resolves.toBeDefined()
    expect(host.previewCache.set).toHaveBeenCalled()
    expect(host.emitChanged).toHaveBeenCalledWith([id], [], false, false)
  })

  it('enters aroundWrite after the mutation claim and releases it after finalize', async () => {
    const id = 'owned-note-id'
    const path = `${PACKAGE_DIR}/SKILL.md`
    const events: string[] = []
    const notes = new Map<string, NoteMeta>([
      [
        id,
        { id, title: 'Owned', class: 'skill', filePath: path, modifiedAt: null, createdAt: null },
      ],
    ])
    const live = {
      id,
      title: 'Owned',
      class: 'skill',
      filePath: path,
      content: 'before',
      frontmatter: {},
      versionToken: 'before-token',
      physicalIncarnation: { adapterId: 'test', claim: { kind: 'test', value: 'before' } },
    } as unknown as NoteContent
    const after = { ...live, content: 'after', versionToken: 'after-token' }
    const beforeToken = exactVersionToken(live)
    const coordinator = new MutationCoordinator()
    const runStable = coordinator.runStable.bind(coordinator)

    vi.spyOn(coordinator, 'runStable').mockImplementation((claimFor, task) =>
      runStable(claimFor, async () => {
        events.push('claim')
        return task()
      }),
    )
    const { host } = hostFor(notes)
    ;(host.inner.read as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(live)
      .mockResolvedValue(after)
    ;(host.inner.write as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      events.push('inner')
      return { id, title: 'Owned', class: 'skill', filePath: path, versionToken: 'after-token' }
    })

    await new WriteEngine(host, { mutations: coordinator }).write(
      {
        originalId: id,
        title: 'Owned',
        content: 'after',
        versionToken: beforeToken,
      },
      {
        aroundWrite: async (write) => {
          events.push('around:enter')
          try {
            return await write()
          } finally {
            events.push('around:finally')
          }
        },
        prepare: () => {
          events.push('prepare')
        },
        assertCurrent: () => {
          events.push('assert-current')
        },
        finalize: () => {
          events.push('finalize')
        },
      },
    )

    expect(events).toEqual([
      'claim',
      'around:enter',
      'prepare',
      'assert-current',
      'inner',
      'finalize',
      'around:finally',
    ])
    expect(host.emitChanged).toHaveBeenCalledWith([id], [], false, false)
  })

  it('releases aroundWrite when the physical write fails', async () => {
    const id = 'owned-note-id'
    const path = `${PACKAGE_DIR}/SKILL.md`
    const events: string[] = []
    const { host } = hostFor(
      new Map([
        [
          id,
          { id, title: 'Owned', class: 'skill', filePath: path, modifiedAt: null, createdAt: null },
        ],
      ]),
    )
    const live = {
      id,
      title: 'Owned',
      class: 'skill',
      filePath: path,
      content: 'before',
      frontmatter: {},
      versionToken: 'before-token',
      physicalIncarnation: { adapterId: 'test', claim: { kind: 'test', value: 'before' } },
    } as unknown as NoteContent
    const beforeToken = exactVersionToken(live)

    ;(host.inner.read as ReturnType<typeof vi.fn>).mockResolvedValue(live)
    ;(host.inner.write as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('physical failed'))

    await expect(
      new WriteEngine(host).write(
        {
          originalId: id,
          title: 'Owned',
          content: 'after',
          versionToken: beforeToken,
        },
        {
          aroundWrite: async (write) => {
            events.push('around:enter')
            try {
              return await write()
            } finally {
              events.push('around:finally')
            }
          },
        },
      ),
    ).rejects.toThrow('physical failed')
    expect(events).toEqual(['around:enter', 'around:finally'])
  })

  it.each([
    ['path-keyed engine with the identity registry', false],
    ['identity-owning engine', true],
  ] as const)(
    'keeps the pre-write identity observation inside an admitted resource scope (%s)',
    async (_label, identity) => {
      const id = 'owned-note-id'
      const path = `${PACKAGE_DIR}/SKILL.md`
      const notes = new Map<string, NoteMeta>([
        [
          id,
          {
            id,
            title: 'Owned',
            class: 'skill',
            filePath: path,
            modifiedAt: null,
            createdAt: null,
          },
        ],
      ])
      const live = {
        id,
        title: 'Owned',
        class: 'skill',
        filePath: path,
        content: 'before',
        frontmatter: {},
        versionToken: 'before-token',
        physicalIncarnation: { adapterId: 'test', claim: { kind: 'test', value: 'before' } },
      } as unknown as NoteContent
      const after = { ...live, content: 'after', versionToken: 'after-token' }
      const { host } = hostFor(notes)

      ;(host.inner.capabilities as { identity: boolean }).identity = identity
      ;(host.inner.read as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(live)
        .mockResolvedValue(after)
      ;(host.inner.write as ReturnType<typeof vi.fn>).mockResolvedValue({
        id,
        title: 'Owned',
        class: 'skill',
        filePath: path,
        versionToken: 'after-token',
      })

      await new WriteEngine(host).write(
        {
          originalId: id,
          title: 'Owned',
          content: 'after',
          versionToken: exactVersionToken(live),
        },
        { resourceAdmitted: true },
      )

      expect((host.inner.read as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]).toMatchObject({
        resourceAdmitted: true,
      })
    },
  )

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

    const assertCurrent = vi.fn()

    await new WriteEngine(host).remove('role-note-id', { assertCurrent })
    expect(assertCurrent).toHaveBeenCalledWith(live)
    expect(journalled).toHaveLength(1)
    expect(journalled[0]).toMatchObject({ noteId: 'role-note-id', title: 'My Role' })
  })

  it('checks the exact current class before a note move has any effect', async () => {
    const id = 'move-note-id'
    const live = {
      id,
      title: 'Move me',
      class: 'skill',
      filePath: 'move-me.md',
      content: 'Body.',
      frontmatter: {},
      physicalIncarnation: { adapterId: 'test', claim: { kind: 'test', value: 'move' } },
    } as unknown as NoteContent
    const { host } = hostFor(
      new Map([[id, { id, title: 'Move me', class: 'skill', filePath: 'move-me.md' } as NoteMeta]]),
    )
    const move = vi.fn()

    ;(host.inner.read as ReturnType<typeof vi.fn>).mockResolvedValue(live)
    ;(host.inner as typeof host.inner & { move: typeof move }).move = move

    await expect(
      new WriteEngine(host).move(
        { id, destinationPath: 'docs/move-me.md' },
        {
          assertCurrent: (current) => {
            if (current.class === 'skill') {
              throw new Error('blocked current skill')
            }
          },
        },
      ),
    ).rejects.toThrow('blocked current skill')
    expect(move).not.toHaveBeenCalled()
  })
})
