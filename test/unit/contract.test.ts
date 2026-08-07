import { describe, expect, it } from 'vitest'
import {
  AddAgentRoleRequestSchema,
  AddAgentRoleResponseSchema,
  AgentContextQuerySchema,
  AgentRoleDetailRequestSchema,
  AgentRoleDetailResponseSchema,
  BucketsQuerySchema,
  BucketsResponseSchema,
  ConfigSchema,
  ConflictResponseSchema,
  contract,
  CreateNoteRequestSchema,
  DurablePathSchema,
  DurableScalarSchema,
  ErrorResponseSchema,
  GraphNodeSchema,
  GraphResponseSchema,
  MarkProjectRequestSchema,
  MeAgentContextResponseSchema,
  MeAgentRolesResponseSchema,
  MoveFolderRequestSchema,
  MoveRequestSchema,
  MoveResponseSchema,
  MuteNoteRequestSchema,
  MuteNoteResponseSchema,
  NoteDetailResponseSchema,
  NotesQuerySchema,
  NotesResponseSchema,
  PatchProjectRequestSchema,
  PatchSpaceRequestSchema,
  PinNoteRequestSchema,
  PinNoteResponseSchema,
  PreviewSchema,
  PreviewsRequestSchema,
  PreviewsResponseSchema,
  ProjectAgentContextResponseSchema,
  ProjectRowSchema,
  ProjectsResponseSchema,
  RestoreSpacesRequestSchema,
  RestoreSpacesResponseSchema,
  RoleContextTargetQuerySchema,
  RoleContextViewSchema,
  SaveResponseSchema,
  SearchResponseSchema,
  SpaceSlugSchema,
  SpacesResponseSchema,
  TrashRestoreManyRequestSchema,
  TrashRestoreManyResponseSchema,
  TreeChildrenResponseSchema,
  UpdateNoteRequestSchema,
} from '@notarium/contract'

// These tests give the /api/* contract teeth: they pin the v2 shapes (#54 —
// camelCase, note-ids, ISO instants, no permalink) by validating
// representative responses (including the edge-cases the strategy calls out —
// spaces in paths, root notes, ghost links, notes without createdAt) and by
// rejecting malformed payloads. The fake backend (#18.2) and any future host
// must satisfy exactly these.

describe('GET /api/config', () => {
  it('is just the capability facts (#99 dropped the default-space pointer) and rejects the engine-leak fields', () => {
    expect(ConfigSchema.safeParse({ capabilities: { spaceCreate: false } }).success).toBe(true)
    expect(ConfigSchema.safeParse({ capabilities: { spaceCreate: true } }).success).toBe(true)
    // capabilities is required; the old engine-endpoint leak fields never validated.
    expect(ConfigSchema.safeParse({ space: 'main' }).success).toBe(false)
    expect(
      ConfigSchema.safeParse({ url: 'http://x', prefix: '/mcp', project: 'main' }).success,
    ).toBe(false)
  })
})

describe('durable write strings', () => {
  it('rejects line-breaking scalars and malformed UTF-16 before storage', () => {
    const loneHigh = String.fromCharCode(0xd800)
    const loneLow = String.fromCharCode(0xdc00)

    expect(CreateNoteRequestSchema.safeParse({ title: 'a\nb', content: 'body' }).success).toBe(
      false,
    )
    expect(CreateNoteRequestSchema.safeParse({ title: loneHigh, content: 'body' }).success).toBe(
      false,
    )
    expect(
      CreateNoteRequestSchema.safeParse({ title: 'ok', content: `bad${loneHigh}` }).success,
    ).toBe(false)
    expect(DurableScalarSchema.safeParse(loneLow).success).toBe(false)
    expect(
      UpdateNoteRequestSchema.safeParse({
        title: 'ok',
        originalId: `a${loneHigh}`,
        versionToken: 'v1:abc',
      }).success,
    ).toBe(false)
  })

  it('keeps ordinary Unicode scalars and multiline Markdown valid', () => {
    expect(
      CreateNoteRequestSchema.safeParse({
        title: '第三季度规划 😀',
        content: '# Заголовок\n\nТекст',
      }).success,
    ).toBe(true)
  })

  it('accepts portable path components in every UTF-8 width and fences private paths', () => {
    for (const path of ['ascii/note.md', 'é/note.md', '研/note.md', '🚀/note.md']) {
      expect(DurablePathSchema.safeParse(path).success).toBe(true)
    }
    // Empty and current-directory segments are harmless normalisation forms.
    expect(DurablePathSchema.safeParse('docs//./note.md').success).toBe(true)

    for (const path of ['/absolute', '../escape', '.hidden/note.md', 'bad:name.md']) {
      expect(DurablePathSchema.safeParse(path).success).toBe(false)
    }
  })
})

describe('spaces (#16)', () => {
  it('SpaceSlug pins the immutable URL-safe key', () => {
    expect(SpaceSlugSchema.safeParse('main').success).toBe(true)
    expect(SpaceSlugSchema.safeParse('my-space-2').success).toBe(true)
    expect(SpaceSlugSchema.safeParse('Main').success).toBe(false) // case would fork URLs
    expect(SpaceSlugSchema.safeParse('a b').success).toBe(false)
    expect(SpaceSlugSchema.safeParse('-lead').success).toBe(false)
    expect(SpaceSlugSchema.safeParse('').success).toBe(false)
    expect(SpaceSlugSchema.safeParse('../up').success).toBe(false) // a slug is also a path segment
  })
  it('GET /api/spaces may answer an empty list (#10: it is the membership filter)', () => {
    expect(
      SpacesResponseSchema.safeParse({
        spaces: [{ id: 'spc-main', slug: 'main', displayName: 'Main' }],
      }).success,
    ).toBe(true)
    // A freshly invited user can hold zero grants — the empty list is honest.
    expect(SpacesResponseSchema.safeParse({ spaces: [] }).success).toBe(true)
  })
  it('accepts only durable bounded display names on the persisted rename surface', () => {
    const lone = String.fromCharCode(0xd800)

    expect(PatchSpaceRequestSchema.safeParse({ displayName: '研究 🚀' }).success).toBe(true)
    expect(PatchSpaceRequestSchema.safeParse({ displayName: '   ' }).success).toBe(false)
    expect(PatchSpaceRequestSchema.safeParse({ displayName: 'bad\nname' }).success).toBe(false)
    expect(PatchSpaceRequestSchema.safeParse({ displayName: `bad${lone}` }).success).toBe(false)
    expect(PatchSpaceRequestSchema.safeParse({ displayName: 'x'.repeat(201) }).success).toBe(false)
  })
})

describe('GET /api/notes', () => {
  it('accepts notes with spaces in paths and root-level notes', () => {
    const r = NotesResponseSchema.safeParse({
      notes: [
        {
          id: 'fake-demo-my-note',
          title: 'My Note',
          filePath: 'demo/My Note.md',
          modifiedAt: '2026-06-04T00:00:00.000Z',
          createdAt: '2026-06-04T10:00:00Z',
        },
        { id: 'fake-root', title: 'Root', filePath: 'root.md', modifiedAt: null, createdAt: null },
      ],
      total: 2,
    })
    expect(r.success).toBe(true)
  })
  // #64: the window response carries the filtered population size.
  it('rejects a response without total', () => {
    expect(NotesResponseSchema.safeParse({ notes: [] }).success).toBe(false)
  })
  it('rejects a note missing filePath', () => {
    expect(
      NotesResponseSchema.safeParse({
        notes: [{ id: 'fake-x', title: 'x', modifiedAt: null, createdAt: null }],
      }).success,
    ).toBe(false)
  })
  // #51 (P7): the internal note-id IS the wire identity — every note must carry one.
  it('rejects a note without id', () => {
    expect(
      NotesResponseSchema.safeParse({
        notes: [{ title: 'x', filePath: 'a.md', modifiedAt: null, createdAt: null }],
        total: 1,
      }).success,
    ).toBe(false)
  })
  // createdAt lives on the one list since #60 (/api/recent is gone): null is
  // the honest "engine doesn't know", but the key must be there.
  it('accepts a note with createdAt: null (engine honestly does not know)', () => {
    const r = NotesResponseSchema.safeParse({
      notes: [
        {
          id: 'fake-a',
          title: 'Old',
          filePath: 'a.md',
          modifiedAt: '2020-01-01T00:00:00.000Z',
          createdAt: null,
        },
      ],
      total: 1,
    })
    expect(r.success).toBe(true)
  })
  it('rejects when createdAt key is absent entirely', () => {
    expect(
      NotesResponseSchema.safeParse({
        notes: [{ id: 'fake-a', title: 'x', filePath: 'a.md', modifiedAt: null }],
      }).success,
    ).toBe(false)
  })
})

describe('previews (#64)', () => {
  it('accepts a preview with no image', () => {
    expect(
      PreviewSchema.safeParse({ snippet: 'hi', image: null, tags: ['t'], words: 3, tokens: 5 })
        .success,
    ).toBe(true)
  })
  it('requires the token estimate (#208)', () => {
    expect(
      PreviewSchema.safeParse({ snippet: 'hi', image: null, tags: ['t'], words: 3 }).success,
    ).toBe(false)
  })
  it('a note may carry an inline preview (warm) or null (cold) — or omit the key entirely', () => {
    const base = { id: 'fake-a', title: 'A', filePath: 'a.md', modifiedAt: null, createdAt: null }
    expect(NotesResponseSchema.safeParse({ notes: [base], total: 1 }).success).toBe(true)
    expect(
      NotesResponseSchema.safeParse({ notes: [{ ...base, preview: null }], total: 1 }).success,
    ).toBe(true)
    expect(
      NotesResponseSchema.safeParse({
        notes: [{ ...base, preview: { snippet: 's', image: null, tags: [], words: 1, tokens: 2 } }],
        total: 1,
      }).success,
    ).toBe(true)
  })
  it('?preview only accepts the literal "1"', () => {
    expect(NotesQuerySchema.safeParse({ preview: '1' }).success).toBe(true)
    expect(NotesQuerySchema.safeParse({ preview: 'yes' }).success).toBe(false)
  })
  it('accepts date range filter days and rejects invalid calendar days (#201)', () => {
    expect(
      NotesQuerySchema.safeParse({
        from: '2026-06-01',
        to: '2026-06-30',
        tz: '180',
        dateField: 'created',
      }).success,
    ).toBe(true)
    expect(NotesQuerySchema.safeParse({ from: '2026-02-30' }).success).toBe(false)
    expect(NotesQuerySchema.safeParse({ from: '2026-06-01T00:00:00.000Z' }).success).toBe(false)
    expect(NotesQuerySchema.safeParse({ from: '2026-06-01', dateField: 'title' }).success).toBe(
      false,
    )
  })
  it('POST /api/previews bounds the batch: 1..100 ids', () => {
    expect(PreviewsRequestSchema.safeParse({ ids: ['a'] }).success).toBe(true)
    expect(PreviewsRequestSchema.safeParse({ ids: [] }).success).toBe(false)
    expect(
      PreviewsRequestSchema.safeParse({ ids: Array.from({ length: 101 }, (_, i) => `${i}`) })
        .success,
    ).toBe(false)
  })
  it('the response maps id → preview; absence of a requested id is legal', () => {
    expect(PreviewsResponseSchema.safeParse({ previews: {} }).success).toBe(true)
    expect(
      PreviewsResponseSchema.safeParse({
        previews: { 'main/a': { snippet: 's', image: null, tags: ['t'], words: 2, tokens: 3 } },
      }).success,
    ).toBe(true)
  })
})

describe('GET /api/tree/children (#64)', () => {
  it('accepts subfolders with counts + windowed notes + total', () => {
    expect(
      TreeChildrenResponseSchema.safeParse({
        folders: [{ path: 'a/b', name: 'b', count: 3, direct: 1 }],
        notes: [
          { id: 'fake-a-n', title: 'N', filePath: 'a/n.md', modifiedAt: null, createdAt: null },
        ],
        total: 10,
      }).success,
    ).toBe(true)
  })
})

describe('GET /api/notes/buckets (#64)', () => {
  it('requires a granularity and rejects the title sort (no date axis)', () => {
    expect(BucketsQuerySchema.safeParse({ group: 'day' }).success).toBe(true)
    expect(BucketsQuerySchema.safeParse({}).success).toBe(false)
    expect(BucketsQuerySchema.safeParse({ group: 'day', sort: 'title' }).success).toBe(false)
  })
  it('accepts the same date range filter as notes (#201)', () => {
    expect(
      BucketsQuerySchema.safeParse({
        group: 'day',
        sort: 'modified',
        from: '2026-06-01',
        to: '2026-06-30',
        dateField: 'created',
        tz: '-300',
      }).success,
    ).toBe(true)
    expect(BucketsQuerySchema.safeParse({ group: 'day', from: '2026-13-01' }).success).toBe(false)
  })
  it('accepts bucket runs incl. the undated tail (key: "")', () => {
    expect(
      BucketsResponseSchema.safeParse({
        buckets: [
          { key: '2026-06-08', count: 12 },
          { key: '', count: 2 },
        ],
        total: 14,
      }).success,
    ).toBe(true)
  })
})

describe('GET /api/graph', () => {
  it('accepts a mix of real and ghost nodes plus links', () => {
    const r = GraphResponseSchema.safeParse({
      nodes: [
        { id: 'fake-a', title: 'A', filePath: 'a.md', folder: '', ghost: false, degree: 1 },
        {
          id: 'ghost:b',
          title: 'B',
          ghost: true,
          folder: '',
          degree: 1,
          target: 'b',
          prefillTitle: 'B',
          creatable: true,
          sources: [{ id: 'fake-a', title: 'A', folder: '' }],
        },
      ],
      links: [{ source: 'fake-a', target: 'ghost:b', type: 'links_to' }],
    })
    expect(r.success).toBe(true)
  })

  it('discriminates on ghost: a ghost node must carry target/prefillTitle', () => {
    // ghost:true but missing the ghost-only fields → invalid
    expect(
      GraphNodeSchema.safeParse({ id: 'ghost:x', title: 'X', ghost: true, folder: '', degree: 0 })
        .success,
    ).toBe(false)
    // real node must NOT need them
    expect(
      GraphNodeSchema.safeParse({
        id: 'fake-a',
        title: 'A',
        filePath: 'a.md',
        folder: '',
        ghost: false,
        degree: 0,
      }).success,
    ).toBe(true)
  })
})

describe('GET /api/note', () => {
  it('accepts content + frontmatter + id + versionToken, optional storage fields', () => {
    expect(
      NoteDetailResponseSchema.safeParse({
        id: 'fake-a',
        content: '# hi',
        frontmatter: { tags: ['x'] },
        versionToken: 'v1:abc',
      }).success,
    ).toBe(true)
  })
  // #51: the detail response must carry the note-id — clients key on it.
  it('rejects a detail response without id', () => {
    expect(
      NoteDetailResponseSchema.safeParse({
        content: '# hi',
        frontmatter: {},
        versionToken: 'v1:abc',
      }).success,
    ).toBe(false)
  })
  // #50: every read carries the version the editor will echo back on save.
  it('rejects a detail response without versionToken', () => {
    expect(
      NoteDetailResponseSchema.safeParse({ id: 'fake-a', content: '# hi', frontmatter: {} })
        .success,
    ).toBe(false)
  })
})

describe('GET /api/search', () => {
  // #54: every hit is a known note — the id is required.
  it('accepts results with an id + snippet; rejects a hit without id', () => {
    expect(
      SearchResponseSchema.safeParse({
        results: [
          {
            id: 'fake-a',
            title: 'A',
            modifiedAt: '2026-06-08T00:00:00.000Z',
            createdAt: '2026-06-01T09:00:00.000Z',
            noteType: 'meeting',
            snippet: 'hit',
            score: 0.5,
          },
        ],
      }).success,
    ).toBe(true)
    expect(
      SearchResponseSchema.safeParse({ results: [{ snippet: 'hit', title: 'A' }] }).success,
    ).toBe(false)
  })
  it('accepts an empty result set', () => {
    expect(SearchResponseSchema.safeParse({ results: [] }).success).toBe(true)
  })
})

describe('note writes (#16 split: create is space-scoped, update id-addressed)', () => {
  it('create title is OPTIONAL since #156 (body-first — the leading # H1 titles the note)', () => {
    // No title field at all is valid: the server derives the title from `content`'s
    // leading `# H1` at the write chokepoint.
    expect(CreateNoteRequestSchema.safeParse({ content: '# From the body\n\ntext' }).success).toBe(
      true,
    )
    expect(CreateNoteRequestSchema.safeParse({}).success).toBe(true)
    // An explicit title is still accepted (it wins, and de-dups a leading heading).
    expect(CreateNoteRequestSchema.safeParse({ title: 'New', directory: 'demo' }).success).toBe(
      true,
    )
  })
  it('update structurally requires originalId AND versionToken (#50 made structural)', () => {
    expect(
      UpdateNoteRequestSchema.safeParse({
        title: 'Renamed',
        directory: 'demo',
        originalId: 'fake-demo-old',
        versionToken: 'v1:abc',
      }).success,
    ).toBe(true)
    expect(
      UpdateNoteRequestSchema.safeParse({ title: 'Renamed', originalId: 'fake-demo-old' }).success,
    ).toBe(false)
    expect(
      UpdateNoteRequestSchema.safeParse({ title: 'Renamed', versionToken: 'v1:abc' }).success,
    ).toBe(false)
  })
  // #51: the save response carries the note-id the client navigates to.
  it('SaveResponse requires the saved note-id', () => {
    expect(
      SaveResponseSchema.safeParse({
        ok: true,
        id: 'fake-demo-new',
        filePath: 'demo/new.md',
        versionToken: 'v1:abc',
        result: {},
      }).success,
    ).toBe(true)
    expect(
      SaveResponseSchema.safeParse({
        ok: true,
        filePath: 'demo/new.md',
        versionToken: 'v1:abc',
        result: {},
      }).success,
    ).toBe(false)
  })
  // #50: the save response always answers the fresh version — what a client
  // (or an agent, #21) chains the next save on without an interim read.
  it('SaveResponse requires the fresh versionToken', () => {
    expect(
      SaveResponseSchema.safeParse({ ok: true, id: 'fake-demo-new', result: {} }).success,
    ).toBe(false)
  })
})

describe('POST /api/note — 409 conflict envelope (#50)', () => {
  const current = {
    id: 'fake-a',
    content: 'their text',
    frontmatter: {},
    versionToken: 'v1:fresh',
  }
  it('carries the live note (content + fresh token) so neither side is lost', () => {
    expect(
      ConflictResponseSchema.safeParse({
        error: 'note changed since read: fake-a',
        reason: 'version_conflict',
        current,
      }).success,
    ).toBe(true)
  })
  it('rejects an envelope without the live note', () => {
    expect(
      ConflictResponseSchema.safeParse({ error: 'conflict', reason: 'version_conflict' }).success,
    ).toBe(false)
  })
})

describe('trash bulk restore (#184)', () => {
  it('note batch request accepts explicit ids OR all+q (the existing select-all-N path)', () => {
    expect(TrashRestoreManyRequestSchema.safeParse({ ids: ['fake-a'] }).success).toBe(true)
    expect(
      TrashRestoreManyRequestSchema.safeParse({ all: true, q: 'carbon', onlyRestorable: true })
        .success,
    ).toBe(true)
    expect(TrashRestoreManyRequestSchema.safeParse({}).success).toBe(false)
    expect(TrashRestoreManyRequestSchema.safeParse({ ids: [] }).success).toBe(false)
  })

  it('note batch response carries restored rows plus per-id failures', () => {
    expect(
      TrashRestoreManyResponseSchema.safeParse({
        ok: true,
        restored: [{ id: 'fake-a', filePath: 'demo/a.md', versionToken: 'v1:x' }],
        failed: [{ id: 'fake-b', error: 'gone', reason: 'note_not_in_trash' }],
      }).success,
    ).toBe(true)
  })

  it('space batch restore addresses archived spaces by id and reports best-effort outcomes', () => {
    expect(RestoreSpacesRequestSchema.safeParse({ ids: ['spc-1'] }).success).toBe(true)
    expect(RestoreSpacesRequestSchema.safeParse({ ids: [] }).success).toBe(false)
    expect(
      RestoreSpacesResponseSchema.safeParse({
        ok: true,
        restored: [{ id: 'spc-1', slug: 'gone', displayName: 'Gone' }],
        failed: [{ id: 'spc-2', error: 'space not found', reason: 'not_found' }],
      }).success,
    ).toBe(true)
  })
})

describe('moves (#16 split: note move is id-addressed, folder move space-scoped)', () => {
  it('note move requires id and destinationPath', () => {
    expect(
      MoveRequestSchema.safeParse({ id: 'fake-a', destinationPath: 'demo/a.md' }).success,
    ).toBe(true)
    expect(MoveRequestSchema.safeParse({ id: 'fake-a' }).success).toBe(false)
  })
  it('folder move addresses by path (folders have no identity beyond their place)', () => {
    expect(
      MoveFolderRequestSchema.safeParse({ path: 'demo', destinationPath: 'archive/demo' }).success,
    ).toBe(true)
    expect(MoveFolderRequestSchema.safeParse({ path: 'demo' }).success).toBe(false)
  })
  it('a Move Failed surfaces as the error envelope, not a success', () => {
    expect(MoveResponseSchema.safeParse({ ok: true, result: 'done' }).success).toBe(true)
    expect(ErrorResponseSchema.safeParse({ error: '# Move Failed: target exists' }).success).toBe(
      true,
    )
  })
})

describe('projects (#13: mark-as-project + list)', () => {
  it('project writes accept only durable bounded display names', () => {
    const lone = String.fromCharCode(0xd800)

    expect(
      MarkProjectRequestSchema.safeParse({ folderPath: 'billing', displayName: '研发 🚀' }).success,
    ).toBe(true)
    expect(MarkProjectRequestSchema.safeParse({ folderPath: '' }).success).toBe(true) // mark the space root
    expect(MarkProjectRequestSchema.safeParse({ displayName: 'no path' }).success).toBe(false)
    for (const displayName of ['   ', 'bad\nname', `bad${lone}`, 'a'.repeat(201)]) {
      expect(MarkProjectRequestSchema.safeParse({ folderPath: 'x', displayName }).success).toBe(
        false,
      )
      expect(PatchProjectRequestSchema.safeParse({ displayName }).success).toBe(false)
    }
  })
  it('the REST ProjectRow carries the bare slug + path on top of the agent-facing shape', () => {
    const row = {
      id: 'Ab3xK9_qZ2mN',
      handle: 'team/billing',
      slug: 'billing',
      path: 'billing',
      displayName: 'Billing',
      space: 'team',
      status: 'active',
    }
    expect(ProjectRowSchema.safeParse(row).success).toBe(true)
    expect(ProjectRowSchema.safeParse({ ...row, path: '' }).success).toBe(true) // root project
    expect(ProjectsResponseSchema.safeParse({ projects: [row] }).success).toBe(true)
    expect(ProjectRowSchema.safeParse({ ...row, status: 'bogus' }).success).toBe(false)
    const { path, ...noPath } = row // path is required (the human management view)
    void path
    expect(ProjectRowSchema.safeParse(noPath).success).toBe(false)
  })
  it('the registry resolves the new operations by name (fake/tests look schemas up here)', () => {
    expect(contract.markProject.request).toBe(MarkProjectRequestSchema)
    expect(contract.markProject.response).toBe(ProjectRowSchema)
    expect(contract.listProjects.response).toBe(ProjectsResponseSchema)
    expect(contract.unmarkProject.response).toBeDefined()
  })
})

describe('agent context constructor (#165)', () => {
  it('the registry resolves context preview and mutation operations by name', () => {
    expect(contract.meAgentContext.response).toBe(MeAgentContextResponseSchema)
    expect(contract.projectAgentContext.response).toBe(ProjectAgentContextResponseSchema)
    expect(contract.pinNote.request).toBe(PinNoteRequestSchema)
    expect(contract.pinNote.response).toBe(PinNoteResponseSchema)
    expect(contract.muteNote.request).toBe(MuteNoteRequestSchema)
    expect(contract.muteNote.response).toBe(MuteNoteResponseSchema)
  })

  it('selects previews by a bounded role name and mutations by a non-empty project id', () => {
    expect(AgentContextQuerySchema.safeParse({}).success).toBe(true)
    expect(AgentContextQuerySchema.safeParse({ role: 'research' }).success).toBe(true)
    expect(AgentContextQuerySchema.safeParse({ role: 'Research' }).success).toBe(false)
    expect(
      AgentContextQuerySchema.safeParse({ role: 'research', projectId: 'wrong-axis' }).success,
    ).toBe(false)

    expect(RoleContextTargetQuerySchema.safeParse({}).success).toBe(true)
    expect(RoleContextTargetQuerySchema.safeParse({ projectId: 'project-docs' }).success).toBe(true)
    expect(RoleContextTargetQuerySchema.safeParse({ projectId: '' }).success).toBe(false)
    expect(
      RoleContextTargetQuerySchema.safeParse({ projectId: 'project-docs', role: 'research' })
        .success,
    ).toBe(false)
  })

  it('validates every exact owned-role placement in a context preview', () => {
    const fields = {
      name: 'research',
      description: 'Research.',
      pins: [{ noteId: 'note-a', title: 'A', loaded: true, tokens: 12, order: 0 }],
      sets: [],
      loadedTokens: 12,
    }

    expect(RoleContextViewSchema.safeParse({ ...fields, scope: 'personal' }).success).toBe(true)
    expect(
      RoleContextViewSchema.safeParse({ ...fields, scope: 'space', space: 'team' }).success,
    ).toBe(true)
    expect(
      RoleContextViewSchema.safeParse({
        ...fields,
        scope: 'project',
        space: 'team',
        project: 'team/docs',
      }).success,
    ).toBe(true)

    expect(RoleContextViewSchema.safeParse({ ...fields, scope: 'space' }).success).toBe(false)
    expect(
      RoleContextViewSchema.safeParse({ ...fields, scope: 'project', space: 'team' }).success,
    ).toBe(false)
    expect(RoleContextViewSchema.safeParse({ ...fields, scope: 'catalog' }).success).toBe(false)
  })
})

describe('agent roles', () => {
  it('registers inventory, detail, and Add operations in the central REST contract', () => {
    expect(contract.agentRoles.response).toBe(MeAgentRolesResponseSchema)
    expect(contract.agentRoleDetail.request).toBe(AgentRoleDetailRequestSchema)
    expect(contract.agentRoleDetail.response).toBe(AgentRoleDetailResponseSchema)
    expect(contract.agentRoleAdd.request).toBe(AddAgentRoleRequestSchema)
    expect(contract.agentRoleAdd.response).toBe(AddAgentRoleResponseSchema)
  })

  it('combines detail path params and query into one registry request schema', () => {
    expect(
      AgentRoleDetailRequestSchema.safeParse({ name: 'research', scope: 'catalog' }).success,
    ).toBe(true)
    expect(AgentRoleDetailRequestSchema.safeParse({ name: 'research' }).success).toBe(false)
  })

  it('requires a project only for an exact project placement', () => {
    expect(
      AddAgentRoleRequestSchema.safeParse({ name: 'research', scope: 'personal' }).success,
    ).toBe(true)
    expect(
      AddAgentRoleRequestSchema.safeParse({
        name: 'research',
        scope: 'project',
        project: 'team/docs',
      }).success,
    ).toBe(true)
    expect(
      AddAgentRoleRequestSchema.safeParse({ name: 'research', scope: 'project' }).success,
    ).toBe(false)
    expect(
      AddAgentRoleRequestSchema.safeParse({
        name: 'research',
        scope: 'personal',
        project: 'team/docs',
      }).success,
    ).toBe(false)
  })
})
