import { describe, expect, it } from 'vitest'

import {
  CreateNoteInputSchema,
  CreateNotesInputSchema,
  CreateNotesOutputSchema,
  DeleteNoteInputSchema,
  DeleteNoteOutputSchema,
  EditNoteInputSchema,
  FolderReorgOutputSchema,
  GetMyProjectsOutputSchema,
  GetNoteInputSchema,
  GetNoteOutputSchema,
  LinkInputSchema,
  LinkManyInputSchema,
  LinkManyOutputSchema,
  LinkOutputSchema,
  ListNotesInputSchema,
  ListNotesOutputSchema,
  ListRolesOutputSchema,
  MoveFolderInputSchema,
  MoveNoteInputSchema,
  MoveNoteOutputSchema,
  RecallInputSchema,
  RecentActivityInputSchema,
  RecentActivityOutputSchema,
  RememberAboutProjectInputSchema,
  RememberAboutUserInputSchema,
  RenameFolderInputSchema,
  RenameNoteInputSchema,
  RenameNoteOutputSchema,
  RenameProjectInputSchema,
  RenameProjectOutputSchema,
  SearchInputSchema,
  SearchOutputSchema,
  StartSessionInputSchema,
  toolActions,
  toolNames,
  tools,
  UseRoleOutputSchema,
  WhoamiOutputSchema,
  WriteResultSchema,
} from '@notarium/contract/tools'

// The MCP-gateway tool contract (#21, toolset-v1-spec §4) gets the same teeth
// the /api/* contract has: the registry resolves every tool by name, the
// inputs apply the spec's defaults, the structuredContent shapes are
// MCP-object-shaped (the spec's array returns are wrapped), and toolActions
// covers the set with the #10 actions the tools/list scope filter reads. The
// transport (stage 3) and the e2e fake must satisfy exactly these.

describe('tool registry', () => {
  it('pins the v2 set of 23 tools, each with input + output schemas', () => {
    expect(toolNames.sort()).toEqual(
      [
        'create_note',
        'create_notes',
        'delete_note',
        'edit_note',
        'get_my_projects',
        'get_note',
        'link',
        'link_many',
        'list_notes',
        'list_roles',
        'move_folder',
        'move_note',
        'recall',
        'recent_activity',
        'remember_about_project',
        'remember_about_user',
        'rename_folder',
        'rename_note',
        'rename_project',
        'search',
        'start_session',
        'use_role',
        'whoami',
      ].sort(),
    )
    for (const name of toolNames) {
      expect(typeof tools[name].input.safeParse).toBe('function')
      expect(typeof tools[name].output.safeParse).toBe('function')
    }
  })

  it('resolves a tool by name and validates a call against it', () => {
    expect(tools.search.input.safeParse({ query: 'roadmap' }).success).toBe(true)
    expect(tools.search.input.safeParse({}).success).toBe(false) // query is required
  })

  it('maps every tool to exactly one #10 action — the scope-filter ceiling', () => {
    expect(Object.keys(toolActions).sort()).toEqual([...toolNames].sort())
    // Read tools sit at read actions, write/intent tools at write actions —
    // so a read-only PAT (scopeAllows) never surfaces the write tools.
    expect(toolActions.search).toBe('space:read')
    expect(toolActions.list_notes).toBe('space:read')
    expect(toolActions.recent_activity).toBe('space:read')
    expect(toolActions.get_note).toBe('note:read')
    expect(toolActions.recall).toBe('space:read')
    expect(toolActions.whoami).toBe('self:read')
    expect(toolActions.get_my_projects).toBe('spaces:list')
    expect(toolActions.list_roles).toBe('space:read')
    expect(toolActions.use_role).toBe('space:read')
    expect(toolActions.remember_about_user).toBe('space:write')
    expect(toolActions.create_note).toBe('space:write')
    expect(toolActions.remember_about_project).toBe('space:write')
    expect(toolActions.edit_note).toBe('note:write')
    // delete_note (#102 phase 3) sits at its OWN write-ranked action, so a future
    // read/append grant could withhold deletion specifically.
    expect(toolActions.delete_note).toBe('note:delete')
    expect(toolActions.link).toBe('note:write')
    // #102 phase 4 batch tools: create_notes is space:write (creating notes), link_many
    // is note:write (writing into the from-notes) — both gated out of a read PAT.
    expect(toolActions.create_notes).toBe('space:write')
    expect(toolActions.link_many).toBe('note:write')
    // #102 phase 5 note reorg: relocating/renaming a note is a write ON the note —
    // note:write, gated out of a read PAT like edit_note/link.
    expect(toolActions.move_note).toBe('note:write')
    expect(toolActions.rename_note).toBe('note:write')
    // #102 phase 6 container reorg: folder move/rename + project rename mutate the SPACE's
    // structure — space:write (the same gate as REST /move-folder + PATCH /projects).
    expect(toolActions.move_folder).toBe('space:write')
    expect(toolActions.rename_folder).toBe('space:write')
    expect(toolActions.rename_project).toBe('space:write')
  })
})

describe('role tool boundaries', () => {
  it('accepts only installed scopes in agent-visible role outputs', () => {
    const catalogRole = { name: 'grooming', description: 'Grooming.', scope: 'catalog' }

    expect(ListRolesOutputSchema.safeParse({ roles: [catalogRole], total: 1 }).success).toBe(false)
    expect(UseRoleOutputSchema.safeParse({ status: 'activated', role: catalogRole }).success).toBe(
      false,
    )
    expect(
      ListRolesOutputSchema.safeParse({
        roles: [{ ...catalogRole, scope: 'personal' }],
        total: 1,
      }).success,
    ).toBe(true)
  })

  it('validates the role slice and full surviving base replacement', () => {
    const role = { name: 'research', description: 'Research.', scope: 'project' }
    const note = { noteId: 'note-a', title: 'A' }
    const context = {
      alwaysLoad: [note],
      replacement: {
        profile: {
          memory: [{ noteId: 'memory-a', category: 'general', summary: 'Summary.' }],
          alwaysLoad: [note],
        },
        project: { alwaysLoad: [] },
      },
      truncated: true,
    }

    expect(UseRoleOutputSchema.safeParse({ status: 'activated', role, context }).success).toBe(true)
    expect(
      UseRoleOutputSchema.safeParse({
        status: 'already_active',
        role: { ...role, scope: 'personal' },
        context: {
          alwaysLoad: [],
          replacement: { profile: { memory: [], alwaysLoad: [] } },
        },
      }).success,
    ).toBe(true)
    expect(
      UseRoleOutputSchema.safeParse({
        status: 'activated',
        role,
        context: { ...context, alwaysLoad: [{ noteId: 'note-without-title' }] },
      }).success,
    ).toBe(false)
  })
})

describe('input defaults (session-bootstrap §4, toolset-v1-spec §3)', () => {
  it('search defaults to concise + limit 20; recall to its budget/depth', () => {
    expect(SearchInputSchema.parse({ query: 'x' })).toMatchObject({
      responseFormat: 'concise',
      limit: 20,
    })
    expect(RecallInputSchema.parse({ query: 'x' })).toMatchObject({ budgetTokens: 4000, depth: 1 })
  })
  it('get_note defaults to detailed (you asked for the whole note)', () => {
    expect(GetNoteInputSchema.parse({ ref: 'fake-a' }).responseFormat).toBe('detailed')
  })
  it('list_notes defaults to limit 50; recent_activity to limit 20 (#102 phase 2)', () => {
    expect(ListNotesInputSchema.parse({}).limit).toBe(50)
    expect(RecentActivityInputSchema.parse({}).limit).toBe(20)
  })
  it('discover/recall inputs enforce their numeric bounds (#102 phase 2)', () => {
    expect(ListNotesInputSchema.safeParse({ limit: 0 }).success).toBe(false)
    expect(ListNotesInputSchema.safeParse({ limit: 101 }).success).toBe(false)
    expect(RecentActivityInputSchema.safeParse({ limit: 101 }).success).toBe(false)
    expect(RecallInputSchema.safeParse({ query: 'x', maxPerSource: 0 }).success).toBe(false)
  })
  it('start_session defaults: acknowledge true, concise', () => {
    expect(StartSessionInputSchema.parse({})).toMatchObject({
      acknowledge: true,
      responseFormat: 'concise',
    })
  })
  it('remember_about_user defaults category to "general"', () => {
    expect(RememberAboutUserInputSchema.parse({ observation: 'likes dark mode' }).category).toBe(
      'general',
    )
  })
})

describe('input validation (poka-yoke + #50/#54 fields)', () => {
  it('remember_about_user requires a non-empty observation; agent picks no space/folder', () => {
    expect(RememberAboutUserInputSchema.safeParse({ observation: '' }).success).toBe(false)
    const r = RememberAboutUserInputSchema.parse({
      observation: 'o',
      summary: 's',
      versionToken: 'v1',
      idempotencyKey: 'k',
    })
    // No `space`/`project`/`directory`/`class` knobs — scope is hard-wired.
    expect(r).not.toHaveProperty('project')
  })
  it('create_note requires project + body; title is OPTIONAL (body-first #156); escape params + CAS', () => {
    expect(CreateNoteInputSchema.safeParse({ title: 'T', body: 'b' }).success).toBe(false) // no project
    expect(CreateNoteInputSchema.safeParse({ project: 'team/billing', title: 'T' }).success).toBe(
      false,
    ) // no body
    // #156: title is optional — the leading `# H1` of body titles the note.
    expect(
      CreateNoteInputSchema.safeParse({ project: 'team/billing', body: '# From the body\n\nx' })
        .success,
    ).toBe(true)
    expect(
      CreateNoteInputSchema.safeParse({
        project: 'team/billing',
        title: 'T',
        body: 'b',
        path: 'docs',
        type: 'spec',
        tags: ['a'],
      }).success,
    ).toBe(true)
    // CAS/idempotency mixin (shared with the edit path).
    expect(
      CreateNoteInputSchema.safeParse({
        project: 'team/billing',
        title: 'T',
        body: 'b',
        versionToken: 'v1',
        idempotencyKey: 'k',
      }).success,
    ).toBe(true)
    // #102 phase 4 channels: inline links (to OR toTitle), createdAt, fileName.
    expect(
      CreateNoteInputSchema.safeParse({
        project: 'team/billing',
        title: 'T',
        body: 'b',
        links: [
          { to: 'fake-x', relation: 'depends_on' },
          { toTitle: 'Future', relation: 'relates_to' },
        ],
        createdAt: '2020-01-02T03:04:05.000Z',
        fileName: 'custom-name',
      }).success,
    ).toBe(true)
  })
  it('remember_about_project (RECLAIMED as memory) mirrors remember_about_user: observation + category + summary + CAS', () => {
    expect(RememberAboutProjectInputSchema.safeParse({ project: 'team/billing' }).success).toBe(
      false,
    ) // no observation
    const r = RememberAboutProjectInputSchema.parse({
      project: 'team/billing',
      observation: 'we ship on fridays',
      summary: 'cadence',
      versionToken: 'v1',
      idempotencyKey: 'k',
    })
    expect(r.category).toBe('general')
    expect(r.summary).toBe('cadence')
    expect(r.versionToken).toBe('v1')
    // It is MEMORY now — no KB-note knobs (title/body/path).
    expect(r).not.toHaveProperty('title')
    expect(r).not.toHaveProperty('body')
  })
  it('edit_note accepts its five word-based modes and rejects an unknown one (#102 phase 3 adds replace)', () => {
    expect(
      EditNoteInputSchema.safeParse({ ref: 'fake-a', operation: 'append', content: 'x' }).success,
    ).toBe(true)
    expect(
      EditNoteInputSchema.safeParse({
        ref: 'fake-a',
        operation: 'replace',
        content: 'whole new body',
      }).success,
    ).toBe(true)
    // `destroy` is not an edit mode — removing a WHOLE note is the separate `delete_note` tool.
    expect(
      EditNoteInputSchema.safeParse({ ref: 'fake-a', operation: 'destroy', content: 'x' }).success,
    ).toBe(false)
  })
  it('delete_note takes just a ref; its output confirms what was trashed (#102 phase 3)', () => {
    expect(DeleteNoteInputSchema.safeParse({ ref: 'fake-a' }).success).toBe(true)
    expect(DeleteNoteInputSchema.safeParse({}).success).toBe(false) // ref is required
    // The echo carries the id + title + three-state location + class (memory vs note).
    expect(DeleteNoteOutputSchema.safeParse({ noteId: 'fake-a', title: 'Gone' }).success).toBe(true)
    expect(
      DeleteNoteOutputSchema.safeParse({
        noteId: 'fake-a',
        title: 'Gone',
        space: 'team',
        project: 'team',
        path: 'docs/gone',
        class: 'agent-memory',
      }).success,
    ).toBe(true)
    expect(DeleteNoteOutputSchema.safeParse({ title: 'Gone' }).success).toBe(false) // noteId required
  })
  it('move_note takes ref + toFolder (any string incl. root); echoes the new three-state location (#102 phase 5)', () => {
    expect(MoveNoteInputSchema.safeParse({ ref: 'fake-a', toFolder: 'docs/guides' }).success).toBe(
      true,
    )
    expect(MoveNoteInputSchema.safeParse({ ref: 'fake-a', toFolder: '' }).success).toBe(true) // '' = root
    expect(MoveNoteInputSchema.safeParse({ ref: 'fake-a' }).success).toBe(false) // toFolder required
    expect(MoveNoteInputSchema.safeParse({ toFolder: 'docs' }).success).toBe(false) // ref required
    expect(
      MoveNoteOutputSchema.safeParse({
        noteId: 'fake-a',
        path: 'docs/guides/note',
        space: 'team',
        project: 'team',
      }).success,
    ).toBe(true)
    expect(MoveNoteOutputSchema.safeParse({ noteId: 'fake-a' }).success).toBe(true) // location all optional (root, personal)
    expect(MoveNoteOutputSchema.safeParse({}).success).toBe(false) // noteId required
  })
  it('rename_note takes ref + a non-empty title; echoes id + new title + fresh token + location (#102 phase 5)', () => {
    expect(RenameNoteInputSchema.safeParse({ ref: 'fake-a', title: 'New Title' }).success).toBe(
      true,
    )
    expect(RenameNoteInputSchema.safeParse({ ref: 'fake-a', title: '' }).success).toBe(false) // title non-empty
    expect(RenameNoteInputSchema.safeParse({ ref: 'fake-a' }).success).toBe(false) // title required
    // No versionToken in the input — rename reads the note itself (CAS internal).
    expect(
      RenameNoteInputSchema.safeParse({ ref: 'fake-a', title: 'X', versionToken: 'v1' }).success,
    ).toBe(true) // extra ignored
    expect(
      RenameNoteOutputSchema.safeParse({
        noteId: 'fake-a',
        title: 'New Title',
        versionToken: 'v2',
        path: 'docs/new-title',
      }).success,
    ).toBe(true)
    expect(RenameNoteOutputSchema.safeParse({ noteId: 'fake-a', title: 'New Title' }).success).toBe(
      false,
    ) // versionToken required
  })
  it('move_folder/rename_folder take a folder path (+ optional project); echo the new path (#102 phase 6)', () => {
    // move_folder: folder + toFolder (destination parent, '' = root); project optional.
    expect(
      MoveFolderInputSchema.safeParse({ folder: 'docs/old', toFolder: 'archive' }).success,
    ).toBe(true)
    expect(
      MoveFolderInputSchema.safeParse({ folder: 'docs/old', toFolder: '', project: 'team' })
        .success,
    ).toBe(true)
    expect(MoveFolderInputSchema.safeParse({ folder: '', toFolder: 'a' }).success).toBe(false) // folder non-empty
    expect(MoveFolderInputSchema.safeParse({ folder: 'docs/old' }).success).toBe(false) // toFolder required
    // rename_folder: folder + a non-empty name (a leaf, not a path); project optional.
    expect(RenameFolderInputSchema.safeParse({ folder: 'docs/old', name: 'new' }).success).toBe(
      true,
    )
    expect(RenameFolderInputSchema.safeParse({ folder: 'docs/old', name: '' }).success).toBe(false) // name non-empty
    expect(RenameFolderInputSchema.safeParse({ folder: 'docs/old', name: 'a/b' }).success).toBe(
      false,
    )
    expect(RenameFolderInputSchema.safeParse({ folder: 'docs/old', name: 'a\\b' }).success).toBe(
      false,
    )
    expect(RenameFolderInputSchema.safeParse({ folder: 'docs/old' }).success).toBe(false) // name required
    // Shared echo: the folder's new space-relative path + optional space.
    expect(FolderReorgOutputSchema.safeParse({ path: 'archive/old' }).success).toBe(true)
    expect(FolderReorgOutputSchema.safeParse({ path: 'archive/old', space: 'team' }).success).toBe(
      true,
    )
    expect(FolderReorgOutputSchema.safeParse({ space: 'team' }).success).toBe(false) // path required
  })
  it('rename_project takes a handle + slug and/or displayName; echoes the new handle + aliases (#102 phase 6)', () => {
    expect(RenameProjectInputSchema.safeParse({ project: 'team/old', slug: 'new' }).success).toBe(
      true,
    )
    expect(
      RenameProjectInputSchema.safeParse({ project: 'team/old', displayName: 'New Name' }).success,
    ).toBe(true)
    expect(
      RenameProjectInputSchema.safeParse({
        project: 'team/old',
        slug: 'new',
        displayName: 'New Name',
      }).success,
    ).toBe(true)
    // Both omitted is structurally valid (the "at least one" rule is enforced in the
    // handler, not zod — the transport reads `.shape`, so a top-level refine is out).
    expect(RenameProjectInputSchema.safeParse({ project: 'team/old' }).success).toBe(true)
    expect(RenameProjectInputSchema.safeParse({ slug: 'new' }).success).toBe(false) // project required
    expect(RenameProjectInputSchema.safeParse({ project: 'team/old', slug: '' }).success).toBe(
      false,
    ) // slug non-empty if present
    const lone = String.fromCharCode(0xd800)

    for (const displayName of ['   ', 'bad\nname', `bad${lone}`, 'x'.repeat(201)]) {
      expect(RenameProjectInputSchema.safeParse({ project: 'team/old', displayName }).success).toBe(
        false,
      )
    }
    expect(
      RenameProjectOutputSchema.safeParse({ id: 'p1', handle: 'team/new', displayName: 'New Name' })
        .success,
    ).toBe(true)
    expect(
      RenameProjectOutputSchema.safeParse({
        id: 'p1',
        handle: 'team/new',
        displayName: 'New Name',
        aliases: ['old'],
      }).success,
    ).toBe(true)
    expect(
      RenameProjectOutputSchema.safeParse({ handle: 'team/new', displayName: 'New Name' }).success,
    ).toBe(false) // id required
  })
  it('link takes from + a non-empty relation; target is to OR toTitle (forward-ref, #102 phase 4)', () => {
    expect(LinkInputSchema.safeParse({ from: 'a', to: 'b', relation: 'relates_to' }).success).toBe(
      true,
    )
    expect(
      LinkInputSchema.safeParse({ from: 'a', toTitle: 'Future Note', relation: 'relates_to' })
        .success,
    ).toBe(true)
    expect(LinkInputSchema.safeParse({ from: 'a', to: 'b', relation: '' }).success).toBe(false)
    // The exactly-one-of(to,toTitle) rule is enforced in the gateway (a guided error),
    // not the schema — the schema keeps `.shape` for the SDK, so both/neither parse here.
    expect(LinkInputSchema.safeParse({ from: 'a', relation: 'rel' }).success).toBe(true)
  })
  it('create_notes / link_many: batch inputs + per-item result outputs (#102 phase 4)', () => {
    // create_notes: project hoisted, items are create_note minus project (+ inline links).
    expect(
      CreateNotesInputSchema.safeParse({
        project: 'team',
        notes: [{ title: 'A', body: 'a', links: [{ toTitle: 'B', relation: 'depends_on' }] }],
      }).success,
    ).toBe(true)
    expect(CreateNotesInputSchema.safeParse({ project: 'team', notes: [] }).success).toBe(false) // at least one
    // Per-item result: ok + index + title, success carries the echo, failure an error.
    expect(
      CreateNotesOutputSchema.safeParse({
        results: [
          {
            index: 0,
            title: 'A',
            ok: true,
            noteId: 'fake-a',
            versionToken: 'v1',
            outcome: 'created',
            warnings: ['possible-secret'],
          },
          { index: 1, title: 'B', ok: false, error: 'collision' },
        ],
      }).success,
    ).toBe(true)
    // link_many: items mirror the single link (to OR toTitle); results are ok/error per index.
    expect(
      LinkManyInputSchema.safeParse({
        links: [
          { from: 'a', to: 'b', relation: 'depends_on' },
          { from: 'a', toTitle: 'Future', relation: 'relates_to' },
        ],
      }).success,
    ).toBe(true)
    expect(LinkManyInputSchema.safeParse({ links: [] }).success).toBe(false)
    expect(
      LinkManyOutputSchema.safeParse({
        results: [
          { index: 0, ok: true, versionToken: 'v1' },
          { index: 1, ok: false, error: 'self-link' },
        ],
      }).success,
    ).toBe(true)
  })
})

describe('structuredContent shapes (MCP object-wrapped)', () => {
  it('search/get_my_projects wrap their lists in an object (MCP structuredContent is an object)', () => {
    expect(SearchOutputSchema.safeParse({ results: [] }).success).toBe(true)
    expect(SearchOutputSchema.safeParse([]).success).toBe(false) // a bare array is not valid structuredContent
    // A project summary carries id + ready handle + space + status (role is GONE, #13).
    expect(
      GetMyProjectsOutputSchema.safeParse({
        projects: [
          {
            id: 'proj-1',
            handle: 'team/billing',
            displayName: 'Billing',
            space: 'team',
            status: 'active',
          },
        ],
      }).success,
    ).toBe(true)
    expect(
      GetMyProjectsOutputSchema.safeParse({
        projects: [{ slug: 'team', displayName: 'Team', role: 'writer' }],
      }).success,
    ).toBe(false) // old shape rejected
  })
  it('a search hit reports the three-state location (space?/project?) and an optional class', () => {
    // Personal-domain hit: both space and project absent.
    expect(
      SearchOutputSchema.safeParse({
        results: [{ noteId: 'fake-a', title: 'A', snippet: 's', modifiedAt: null }],
      }).success,
    ).toBe(true)
    // In a project: space slug + full project handle.
    expect(
      SearchOutputSchema.safeParse({
        results: [
          {
            noteId: 'fake-a',
            title: 'A',
            snippet: 's',
            space: 'team',
            project: 'team/billing',
            class: 'agent-memory',
            modifiedAt: '2026-06-14T00:00:00Z',
          },
        ],
      }).success,
    ).toBe(true)
    // Free note in a work space: space only, no project.
    expect(
      SearchOutputSchema.safeParse({
        results: [{ noteId: 'fake-a', title: 'A', snippet: 's', space: 'team', modifiedAt: null }],
      }).success,
    ).toBe(true)
  })
  it('get_note carries content + versionToken; provenance + location are optional', () => {
    expect(
      GetNoteOutputSchema.safeParse({
        noteId: 'fake-a',
        title: 'A',
        content: '# hi',
        frontmatter: {},
        versionToken: 'v1',
      }).success,
    ).toBe(true)
    expect(
      GetNoteOutputSchema.safeParse({
        noteId: 'fake-a',
        title: 'A',
        content: '# hi',
        frontmatter: { type: 'spec' },
        space: 'team',
        project: 'team/billing',
        class: 'user-doc',
        versionToken: 'v1',
        provenance: { principal: 'pat:ann:1', kind: 'write', modifiedAt: '2026-06-14T00:00:00Z' },
      }).success,
    ).toBe(true)
    // versionToken is the #50 CAS proof — a read without it is invalid.
    expect(
      GetNoteOutputSchema.safeParse({
        noteId: 'fake-a',
        title: 'A',
        content: '# hi',
        frontmatter: {},
      }).success,
    ).toBe(false)
  })
  it('write tools answer { noteId, versionToken }; link answers { ok:true, versionToken }', () => {
    expect(WriteResultSchema.safeParse({ noteId: 'fake-a', versionToken: 'v2' }).success).toBe(true)
    expect(WriteResultSchema.safeParse({ noteId: 'fake-a' }).success).toBe(false)
    expect(LinkOutputSchema.safeParse({ ok: true, versionToken: 'v2' }).success).toBe(true)
    expect(LinkOutputSchema.safeParse({ ok: false, versionToken: 'v2' }).success).toBe(false)
  })
  it('list_notes answers items + folders + total (paginated ls); recent_activity items (#102 phase 2)', () => {
    expect(
      ListNotesOutputSchema.safeParse({
        items: [
          {
            noteId: 'fake-a',
            title: 'A',
            path: 'docs/a',
            tags: ['x'],
            modifiedAt: '2026-06-14T00:00:00Z',
          },
        ],
        folders: [{ path: 'docs/sub', name: 'sub', count: 3 }],
        total: 1,
        nextCursor: '50',
      }).success,
    ).toBe(true)
    // path is required on an item (the location is the whole point); tags optional.
    // (modifiedAt is valid here — null is allowed — so the ONLY reason this fails is the missing path.)
    expect(
      ListNotesOutputSchema.safeParse({
        items: [{ noteId: 'a', title: 'A', modifiedAt: '2026-06-14T00:00:00Z' }],
        folders: [],
        total: 1,
      }).success,
    ).toBe(false)
    expect(
      RecentActivityOutputSchema.safeParse({
        items: [
          {
            noteId: 'fake-a',
            title: 'A',
            path: 'docs/a',
            space: 'team',
            project: 'team',
            kind: 'write',
            principal: 'pat:ann:1',
            modifiedAt: '2026-06-14T00:00:00Z',
          },
        ],
        truncated: true,
      }).success,
    ).toBe(true)
  })
  it('get_note carries the optional outline + links (#102 phase 2)', () => {
    expect(
      GetNoteOutputSchema.safeParse({
        noteId: 'fake-a',
        title: 'A',
        content: '# hi',
        frontmatter: {},
        versionToken: 'v1',
        outline: [
          { level: 1, title: 'hi' },
          { level: 2, title: 'Details' },
        ],
        links: {
          outgoing: [
            { noteId: 'fake-b', title: 'B', relation: 'depends_on' },
            { title: 'Ghost Note', relation: 'relates_to' },
          ],
          incoming: [{ noteId: 'fake-c', title: 'C', relation: 'supersedes' }],
        },
      }).success,
    ).toBe(true)
  })
  it('recall accepts the optional maxPerSource width cap (#102 phase 2)', () => {
    expect(RecallInputSchema.parse({ query: 'x', maxPerSource: 800 }).maxPerSource).toBe(800)
    expect(RecallInputSchema.parse({ query: 'x' }).maxPerSource).toBeUndefined()
  })
  it('whoami scope is the read|write ceiling; projects use the one ProjectSummary shape; capabilities are declared (#102)', () => {
    const caps = { vector: true, trash: true, revisions: true }
    expect(
      WhoamiOutputSchema.safeParse({
        principal: 'pat:ann:1',
        scope: 'write',
        projects: [
          {
            id: 'proj-1',
            handle: 'team/billing',
            displayName: 'Billing',
            space: 'team',
            status: 'active',
          },
        ],
        capabilities: caps,
      }).success,
    ).toBe(true)
    expect(
      WhoamiOutputSchema.safeParse({
        principal: 'pat:ann:1',
        scope: 'manage',
        projects: [],
        capabilities: caps,
      }).success,
    ).toBe(false)
    // #102 phase 1: capabilities is a required declaration — a whoami without it is invalid.
    expect(
      WhoamiOutputSchema.safeParse({ principal: 'pat:ann:1', scope: 'write', projects: [] })
        .success,
    ).toBe(false)
  })
})
