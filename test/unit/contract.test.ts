import { describe, expect, it } from 'vitest'
import {
  ActivityEventsQuerySchema,
  AddAgentRoleRequestSchema,
  AddAgentRoleResponseSchema,
  AddAgentSkillRequestSchema,
  AddAgentSkillResponseSchema,
  AgentAbilityDetailResponseSchema,
  AgentAuditQuerySchema,
  AgentContextQuerySchema,
  AgentPackageLibraryQuerySchema,
  AgentSessionEventsQuerySchema,
  BucketsQuerySchema,
  BucketsResponseSchema,
  ConfigSchema,
  ConflictResponseSchema,
  contract,
  CreateAbilityVersionRequestSchema,
  CreateAgentRoleRequestSchema,
  CreateFolderPageRequestSchema,
  CreateNoteRequestSchema,
  DurablePathSchema,
  DurableScalarSchema,
  ErrorResponseSchema,
  FieldDeclarationSchema,
  FieldsResponseSchema,
  GraphNodeSchema,
  GraphResponseSchema,
  JobSchema,
  MarkProjectRequestSchema,
  MeAgentContextResponseSchema,
  MeAgentRolesResponseSchema,
  MeAgentSkillsResponseSchema,
  MeMemoryQuerySchema,
  MemoryCategorySchema,
  MoveFolderRequestSchema,
  MoveRequestSchema,
  MoveResponseSchema,
  MuteNoteRequestSchema,
  MuteNoteResponseSchema,
  NoteDetailResponseSchema,
  NoteRevisionsQuerySchema,
  NotesQuerySchema,
  NotesResponseSchema,
  parseFieldFilter,
  PatchProjectRequestSchema,
  PatchSpaceRequestSchema,
  PinNoteRequestSchema,
  PinNoteResponseSchema,
  PreviewSchema,
  PreviewsRequestSchema,
  PreviewsResponseSchema,
  ProjectAgentContextResponseSchema,
  ProjectMemoryQuerySchema,
  ProjectRowSchema,
  ProjectsResponseSchema,
  RestoreResponseSchema,
  RestoreSpacesRequestSchema,
  RestoreSpacesResponseSchema,
  RoleContextViewSchema,
  SaveResponseSchema,
  SearchResponseSchema,
  SetAbilityHomeRequestSchema,
  SetAbilityHomeResponseSchema,
  SetAgentAbilityAvailabilityRequestSchema,
  SetAgentAbilityAvailabilityResponseSchema,
  SetAgentAbilityEnabledRequestSchema,
  SetAgentAbilityEnabledResponseSchema,
  SetNoteFieldsRequestSchema,
  SetNoteFieldsResponseSchema,
  SpaceSlugSchema,
  SpacesResponseSchema,
  TrashQuerySchema,
  TrashRestoreManyRequestSchema,
  TrashRestoreManyResponseSchema,
  TreeChildrenQuerySchema,
  TreeChildrenResponseSchema,
  UpdateNoteRequestSchema,
} from '@notarium/contract'
import { RecallInputSchema, RoleSelectorSchema } from '@notarium/contract/tools'

// These tests give the /api/* contract teeth: they pin the v2 shapes (#54 —
// camelCase, note-ids, ISO instants, no permalink) by validating
// representative responses (including the edge-cases the strategy calls out —
// spaces in paths, root notes, ghost links, notes without createdAt) and by
// rejecting malformed payloads. The fake backend (#18.2) and any future host
// must satisfy exactly these.

describe('field declaration contract', () => {
  it('separates an enum option stable key from its editable label', () => {
    expect(
      FieldDeclarationSchema.parse({
        key: 'status',
        type: 'enum',
        values: [{ key: 'in-progress', label: 'In progress', color: 'amber' }],
      }),
    ).toEqual({
      key: 'status',
      type: 'enum',
      values: [{ key: 'in-progress', label: 'In progress', color: 'amber' }],
    })
    expect(
      FieldDeclarationSchema.safeParse({
        key: 'status',
        type: 'enum',
        values: [{ value: 'In progress', color: 'amber' }],
      }).success,
    ).toBe(false)
  })
})

describe('GET /api/me/agent-sessions/:id query', () => {
  it('allows a query fragment across all retrieval tools and keeps tool as an optional narrowing', () => {
    expect(AgentSessionEventsQuerySchema.safeParse({ q: 'same query' }).success).toBe(true)
    expect(
      AgentSessionEventsQuerySchema.safeParse({ q: 'same query', tool: 'search' }).success,
    ).toBe(true)
    expect(AgentSessionEventsQuerySchema.safeParse({ tool: 'search' }).success).toBe(false)
    expect(
      AgentSessionEventsQuerySchema.safeParse({ q: 'same query', filter: 'writes' }).success,
    ).toBe(false)
  })

  it('rejects NUL before binding text filters to a database driver', () => {
    expect(AgentSessionEventsQuerySchema.safeParse({ q: 'before\0after' }).success).toBe(false)
    expect(AgentSessionEventsQuerySchema.safeParse({ agent: 'CLI\0hidden' }).success).toBe(false)
  })
})

describe('zod 4 migration boundaries', () => {
  it('matches the static zod 3 REST coercion/preprocess baseline on 25 ordinary inputs', () => {
    const defaults = { sort: 'modified', offset: 0, depth: 'subtree', tz: 0 }
    const cases: Array<{
      name: string
      input: Record<string, unknown>
      expected: false | Record<string, unknown>
    }> = [
      { name: 'empty object', input: {}, expected: defaults },
      { name: 'offset empty', input: { offset: '' }, expected: defaults },
      { name: 'offset text', input: { offset: 'abc' }, expected: false },
      { name: 'offset null', input: { offset: null }, expected: defaults },
      { name: 'offset boolean', input: { offset: true }, expected: { ...defaults, offset: 1 } },
      { name: 'offset array', input: { offset: [] }, expected: defaults },
      { name: 'offset float', input: { offset: '1.5' }, expected: false },
      { name: 'limit empty', input: { limit: '' }, expected: false },
      { name: 'limit text', input: { limit: 'abc' }, expected: false },
      { name: 'limit null', input: { limit: null }, expected: false },
      { name: 'limit boolean', input: { limit: true }, expected: { ...defaults, limit: 1 } },
      { name: 'limit array', input: { limit: [] }, expected: false },
      { name: 'limit float', input: { limit: '1.5' }, expected: false },
      {
        name: 'folders scalar',
        input: { folders: 'docs' },
        expected: { ...defaults, folders: ['docs'] },
      },
      {
        name: 'folders array',
        input: { folders: ['docs', 'work'] },
        expected: { ...defaults, folders: ['docs', 'work'] },
      },
      { name: 'folders empty', input: { folders: [] }, expected: { ...defaults, folders: [] } },
      { name: 'tags scalar', input: { tags: 'red' }, expected: { ...defaults, tags: ['red'] } },
      {
        name: 'tags array',
        input: { tags: ['red', 'blue'] },
        expected: { ...defaults, tags: ['red', 'blue'] },
      },
      { name: 'tags empty', input: { tags: [] }, expected: { ...defaults, tags: [] } },
      { name: 'timezone empty', input: { tz: '' }, expected: defaults },
      { name: 'timezone text', input: { tz: 'abc' }, expected: false },
      { name: 'timezone null', input: { tz: null }, expected: defaults },
      { name: 'timezone boolean', input: { tz: true }, expected: { ...defaults, tz: 1 } },
      { name: 'timezone array', input: { tz: [] }, expected: defaults },
      { name: 'timezone float', input: { tz: '1.5' }, expected: false },
    ]

    expect(cases).toHaveLength(25)
    for (const { name, input, expected } of cases) {
      const result = NotesQuerySchema.safeParse(input)
      expect(result.success, name).toBe(expected !== false)
      if (result.success && expected !== false) {
        expect(result.data, name).toEqual(expected)
      }
    }
  })

  it('keeps the approved safe-integer narrowing on MCP and every unbounded REST offset', () => {
    const unsafeInteger = Number.MAX_SAFE_INTEGER + 1
    const restOffsetSchemas = [
      NotesQuerySchema,
      TrashQuerySchema,
      NoteRevisionsQuerySchema,
      TreeChildrenQuerySchema,
      ActivityEventsQuerySchema,
      AgentAuditQuerySchema,
    ]

    for (const schema of restOffsetSchemas) {
      const result = schema.safeParse({ offset: String(unsafeInteger) })
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.issues).toContainEqual(
          expect.objectContaining({ code: 'too_big', maximum: Number.MAX_SAFE_INTEGER }),
        )
      }
    }

    const recall = RecallInputSchema.safeParse({ query: 'q', maxPerSource: unsafeInteger })
    expect(recall.success).toBe(false)
    if (!recall.success) {
      expect(recall.error.issues).toContainEqual(
        expect.objectContaining({ code: 'too_big', maximum: Number.MAX_SAFE_INTEGER }),
      )
    }
  })

  it('requires Job.result because every wire producer emits the key', () => {
    const withoutResult = {
      id: 'job-1',
      kind: 'export',
      status: 'pending',
      progress: { done: 0, total: null, ratio: null, phase: null },
      artifact: null,
      error: null,
      createdAt: '2026-08-25T00:00:00.000Z',
      updatedAt: '2026-08-25T00:00:00.000Z',
      completedAt: null,
    }

    const missing = JobSchema.safeParse(withoutResult)
    expect(missing.success).toBe(false)
    if (!missing.success) {
      expect(missing.error.issues).toContainEqual(
        expect.objectContaining({ code: 'invalid_type', path: ['result'] }),
      )
    }
    expect(JobSchema.safeParse({ ...withoutResult, result: null }).success).toBe(true)
  })

  it('keeps all seven custom diagnostics and their paths exact', () => {
    const cases = [
      {
        result: RoleSelectorSchema.safeParse({}),
        expected: { code: 'custom', path: [], message: 'provide exactly one of role or name' },
      },
      {
        result: DurableScalarSchema.safeParse('ok\0bad'),
        expected: {
          code: 'custom',
          path: [],
          message: 'must not contain a control character (U+0000 at line 1, column 3)',
        },
      },
      {
        result: UpdateNoteRequestSchema.safeParse({
          originalId: 'note-1',
          versionToken: 'v1',
          attachments: [],
        }),
        expected: {
          code: 'custom',
          path: [],
          message: 'abilityLocator and attachments must be passed together',
        },
      },
      {
        result: AddAgentRoleRequestSchema.safeParse({ name: 'review', scope: 'project' }),
        expected: { code: 'custom', path: ['project'], message: 'project is required' },
      },
      {
        result: AddAgentRoleRequestSchema.safeParse({
          name: 'review',
          scope: 'personal',
          project: 'main',
        }),
        expected: {
          code: 'custom',
          path: ['project'],
          message: 'project is only valid for project scope',
        },
      },
      {
        result: AgentSessionEventsQuerySchema.safeParse({ tool: 'search' }),
        expected: { code: 'custom', path: [], message: 'tool requires q' },
      },
      {
        result: AgentSessionEventsQuerySchema.safeParse({ q: 'query', filter: 'writes' }),
        expected: { code: 'custom', path: [], message: 'query filter only applies to reads' },
      },
    ]

    expect(cases).toHaveLength(7)
    for (const { result, expected } of cases) {
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.issues).toEqual([expect.objectContaining(expected)])
      }
    }
  })
})

describe('GET /api/config', () => {
  it('is just the capability facts (#99 dropped the default-space pointer) and rejects the engine-leak fields', () => {
    expect(
      ConfigSchema.safeParse({ capabilities: { spaceCreate: false, providers: false } }).success,
    ).toBe(true)
    expect(
      ConfigSchema.safeParse({ capabilities: { spaceCreate: true, providers: true } }).success,
    ).toBe(true)
    expect(ConfigSchema.safeParse({ capabilities: { spaceCreate: false } }).success).toBe(false)
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
  it('parses one field grammar into OR-within-key and AND-between-keys', () => {
    const parsed = NotesQuerySchema.parse({
      field: ['note.status:wip', 'note.status:done', 'note.url:https://example.com'],
      fieldDay: 'note.due:2026-09-01',
      fieldAny: 'note.owner',
      fieldBad: 'note.shape',
    })

    expect(parseFieldFilter(parsed)).toEqual({
      op: 'and',
      nodes: [
        {
          op: 'or',
          ns: 'note',
          key: 'status',
          values: [
            { kind: 'eq', value: 'wip' },
            { kind: 'eq', value: 'done' },
          ],
        },
        {
          op: 'or',
          ns: 'note',
          key: 'url',
          values: [{ kind: 'eq', value: 'https://example.com' }],
        },
        {
          op: 'or',
          ns: 'note',
          key: 'due',
          values: [{ kind: 'day', value: '2026-09-01' }],
        },
        { op: 'or', ns: 'note', key: 'owner', values: [{ kind: 'present' }] },
        { op: 'or', ns: 'note', key: 'shape', values: [{ kind: 'unreadable' }] },
      ],
    })
  })
  it('validates the fieldDay calendar grammar before building the typed predicate', () => {
    expect(NotesQuerySchema.safeParse({ fieldDay: 'note.due:2026-02-29' }).success).toBe(false)
    expect(NotesQuerySchema.safeParse({ fieldDay: 'note.due:2026-09-01' }).success).toBe(true)
    expect(parseFieldFilter(NotesQuerySchema.parse({ fieldDay: 'note.due:2026-09-01' }))).toEqual({
      op: 'and',
      nodes: [
        {
          op: 'or',
          ns: 'note',
          key: 'due',
          values: [{ kind: 'day', value: '2026-09-01' }],
        },
      ],
    })
  })
  it('deduplicates repeated field conditions before the matcher sees them', () => {
    const parsed = NotesQuerySchema.parse({
      field: ['note.status:wip', 'note.status:wip'],
      fieldAny: ['note.status', 'note.status'],
      fieldBad: ['note.status', 'note.status'],
    })

    expect(parseFieldFilter(parsed)?.nodes).toEqual([
      {
        op: 'or',
        ns: 'note',
        key: 'status',
        values: [{ kind: 'eq', value: 'wip' }, { kind: 'present' }, { kind: 'unreadable' }],
      },
    ])
  })
  it.each([
    ['status:wip', 'namespace'],
    ['file.name:x', 'reserved'],
    ['other.name:x', 'only "note"'],
    ['note.status', '<namespace>.<key>:<value>'],
    ['note.:x', 'must not be empty'],
    ['note.tags:work', 'tags query axis'],
    ['note.created:2026-08-21', 'date query axis'],
    ['note.notarium-source:external', 'import provenance'],
    ['note.notarium-id:x', 'storage-owned'],
    ['note.title:Hello', 'projected onto note metadata'],
  ])('rejects field equality %s with an actionable reason', (field, reason) => {
    const result = NotesQuerySchema.safeParse({ field })

    expect(result.success).toBe(false)
    expect(result.success ? '' : result.error.issues[0].message).toContain(reason)
  })
  it('keeps operator-shaped RHS values literal and lets presence address a colon-shaped key', () => {
    expect(NotesQuerySchema.safeParse({ field: 'note.k:*' }).success).toBe(true)
    const parsed = NotesQuerySchema.parse({
      field: ['note.estimate:>3', 'note.period:[2026-01-01..2026-02-01]'],
    })

    expect(parseFieldFilter(parsed)?.nodes).toEqual([
      {
        op: 'or',
        ns: 'note',
        key: 'estimate',
        values: [{ kind: 'eq', value: '>3' }],
      },
      {
        op: 'or',
        ns: 'note',
        key: 'period',
        values: [{ kind: 'eq', value: '[2026-01-01..2026-02-01]' }],
      },
    ])
    expect(NotesQuerySchema.safeParse({ fieldAny: 'note.https://example' }).success).toBe(true)
  })
  it('fails loudly when parseFieldFilter is called without schema validation', () => {
    expect(() => parseFieldFilter({ field: ['garbage'] })).toThrow(/namespace/)
  })
  it('accepts the two-level field facet response', () => {
    expect(
      FieldsResponseSchema.safeParse({
        fields: [
          {
            key: 'status',
            declared: true,
            notes: 2,
            values: [
              { value: 'wip', count: 2 },
              { value: 'done', count: 0 },
            ],
            total: 2,
          },
        ],
        total: 1,
      }).success,
    ).toBe(true)
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
  it('accepts field + direction and keeps the title/asc compatibility default', () => {
    expect(TreeChildrenQuerySchema.parse({})).toMatchObject({
      path: '',
      offset: 0,
      sort: 'title',
    })
    expect(
      TreeChildrenQuerySchema.safeParse({ path: 'a', sort: 'created', dir: 'desc' }).success,
    ).toBe(true)
    expect(TreeChildrenQuerySchema.safeParse({ sort: 'unknown' }).success).toBe(false)
    expect(TreeChildrenQuerySchema.safeParse({ dir: 'sideways' }).success).toBe(false)
  })

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

describe('agent-memory audit order', () => {
  it('accepts the shared sort axes on both routes while keeping project order compatibility', () => {
    expect(MeMemoryQuerySchema.safeParse({ sort: 'created', dir: 'asc' }).success).toBe(true)
    expect(ProjectMemoryQuerySchema.safeParse({ sort: 'title', dir: 'desc' }).success).toBe(true)
    expect(
      ProjectMemoryQuerySchema.safeParse({ order: 'eager', sort: 'created', dir: 'asc' }).success,
    ).toBe(true)
    expect(MeMemoryQuerySchema.safeParse({ dir: 'sideways' }).success).toBe(false)
  })

  it('carries nullable createdAt as part of every category', () => {
    const base = {
      noteId: 'memory-a',
      category: 'a',
      summary: 'A',
      tokens: 1,
      muted: false,
      modifiedAt: null,
      principal: null,
      author: null,
      kind: null,
    }

    expect(MemoryCategorySchema.safeParse({ ...base, createdAt: null }).success).toBe(true)
    expect(MemoryCategorySchema.safeParse(base).success).toBe(false)
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

  it('keeps structured authored fields for the reading-mode inspector', () => {
    const detail = NoteDetailResponseSchema.parse({
      id: 'fake-a',
      content: '# hi',
      frontmatter: { status: 'Doing' },
      versionToken: 'v1:abc',
      fields: {
        keys: { status: 'Doing' },
        unreadable: ['broken'],
        truncated: ['large'],
        truncatedMore: 2,
        order: ['status', 'broken', 'large'],
      },
    })

    expect((detail as Record<string, unknown>).fields).toEqual({
      keys: { status: 'Doing' },
      unreadable: ['broken'],
      truncated: ['large'],
      truncatedMore: 2,
      order: ['status', 'broken', 'large'],
    })
  })
})

describe('GET /api/s/:space/notes card fields', () => {
  it('keeps only the compact key/value map on a list row', () => {
    const page = NotesResponseSchema.parse({
      notes: [
        {
          id: 'fake-a',
          title: 'A',
          filePath: 'a.md',
          modifiedAt: '2026-08-22T00:00:00.000Z',
          createdAt: '2026-08-22T00:00:00.000Z',
          noteType: 'task',
          fields: { status: 'Doing', reviewers: ['ann', 'bo'] },
        },
      ],
      total: 1,
    })

    expect((page.notes[0] as Record<string, unknown>).fields).toEqual({
      status: 'Doing',
      reviewers: ['ann', 'bo'],
    })
    expect((page.notes[0] as Record<string, unknown>).noteType).toBe('task')
  })
})

describe('ordinary note Save fields', () => {
  it('keeps the field patch on both create and update requests', () => {
    const fields = { status: 'Doing', reviewers: ['ann'], removed: null }
    const created = CreateNoteRequestSchema.parse({ content: '# A', fields })
    const updated = UpdateNoteRequestSchema.parse({
      content: '# A',
      originalId: 'note-a',
      versionToken: 'v1:a',
      fields,
    })
    const folderPage = CreateFolderPageRequestSchema.parse({
      folderPath: 'docs',
      content: '# Docs',
      fields,
    })

    expect((created as Record<string, unknown>).fields).toEqual(fields)
    expect((updated as Record<string, unknown>).fields).toEqual(fields)
    expect((folderPage as Record<string, unknown>).fields).toEqual(fields)
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
  it('replaces Role attachments only when the exact locator and full list arrive together', () => {
    const base = { originalId: 'role-note', versionToken: 'v1:abc' }
    const locator = {
      source: 'owned' as const,
      kind: 'role' as const,
      packageId: 'RolePackage1',
      location: { scope: 'personal' as const, spaceId: 'personal-space' },
    }

    expect(UpdateNoteRequestSchema.safeParse({ ...base, abilityLocator: locator }).success).toBe(
      false,
    )
    expect(UpdateNoteRequestSchema.safeParse({ ...base, attachments: [] }).success).toBe(false)
    expect(
      UpdateNoteRequestSchema.safeParse({ ...base, abilityLocator: locator, attachments: [] })
        .success,
    ).toBe(true)
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

describe('POST /api/note/restore — typed conflict reasons', () => {
  const conflict = {
    status: 'conflict',
    error: 'restore conflict',
    operationId: 'restore-op',
  }

  it('accepts the coordinator canonical stale-CAS reason and rejects spelling drift', () => {
    expect(
      RestoreResponseSchema.safeParse({ ...conflict, reason: 'version-conflict' }).success,
    ).toBe(true)
    expect(
      RestoreResponseSchema.safeParse({ ...conflict, reason: 'version_conflict' }).success,
    ).toBe(false)
  })
})

describe('trash bulk restore (#184)', () => {
  it('note batch request accepts explicit ids OR all+q (the existing select-all-N path)', () => {
    expect(
      TrashRestoreManyRequestSchema.safeParse({ ids: ['fake-a'], idempotencyKey: 'bulk-1' })
        .success,
    ).toBe(true)
    expect(
      TrashRestoreManyRequestSchema.safeParse({
        all: true,
        q: 'carbon',
        onlyRestorable: true,
        idempotencyKey: 'bulk-2',
      }).success,
    ).toBe(true)
    expect(TrashRestoreManyRequestSchema.safeParse({}).success).toBe(false)
    expect(TrashRestoreManyRequestSchema.safeParse({ ids: [] }).success).toBe(false)
  })

  it('note batch response carries one stable terminal outcome per frozen item', () => {
    expect(
      TrashRestoreManyResponseSchema.safeParse({
        status: 'completed',
        operationId: 'bulk-op',
        items: [
          {
            id: 'fake-a',
            revisionId: 'tomb-a',
            status: 'succeeded',
            operationId: 'child-a',
            restoredRevisionId: 'restored-a',
            filePath: 'demo/a.md',
            versionToken: 'v3:x',
          },
          {
            id: 'fake-b',
            revisionId: null,
            status: 'conflict',
            reason: 'note_not_in_trash',
          },
        ],
        counts: {
          total: 2,
          queued: 0,
          pending: 0,
          succeeded: 1,
          conflict: 1,
          notRestorable: 0,
        },
      }).success,
    ).toBe(true)
    expect(
      TrashRestoreManyResponseSchema.safeParse({
        status: 'completed',
        operationId: 'bulk-op',
        items: [
          {
            id: 'fake-b',
            revisionId: null,
            status: 'conflict',
            reason: 'note-not-in-trash',
          },
        ],
        counts: {
          total: 1,
          queued: 0,
          pending: 0,
          succeeded: 0,
          conflict: 1,
          notRestorable: 0,
        },
      }).success,
    ).toBe(false)
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
  it('the registry resolves context preview and mutation operations by exact locator', () => {
    expect(contract.meAgentContext.response).toBe(MeAgentContextResponseSchema)
    expect(contract.projectAgentContext.response).toBe(ProjectAgentContextResponseSchema)
    expect(contract.pinNote.request).toBe(PinNoteRequestSchema)
    expect(contract.pinNote.response).toBe(PinNoteResponseSchema)
    expect(contract.muteNote.request).toBe(MuteNoteRequestSchema)
    expect(contract.setNoteFields.request).toBe(SetNoteFieldsRequestSchema)
    expect(contract.setNoteFields.response).toBe(SetNoteFieldsResponseSchema)
    expect(contract.muteNote.response).toBe(MuteNoteResponseSchema)
  })

  it('carries one bounded opaque role locator and rejects a second addressing axis', () => {
    expect(AgentContextQuerySchema.safeParse({}).success).toBe(true)
    expect(AgentContextQuerySchema.safeParse({ role: 'encoded-locator' }).success).toBe(true)
    expect(AgentContextQuerySchema.safeParse({ role: '' }).success).toBe(false)
    expect(AgentContextQuerySchema.safeParse({ role: 'x'.repeat(4097) }).success).toBe(false)
    expect(
      AgentContextQuerySchema.safeParse({ role: 'encoded-locator', projectId: 'wrong-axis' })
        .success,
    ).toBe(false)
  })

  it('validates every exact owned-role placement in a context preview', () => {
    const fields = {
      // A context view is an OWNED placement by construction, and now says so: the
      // effective-role shape became a union on `source` when System roles entered the
      // resolver, and only the Owned arm carries a placement at all.
      source: 'owned' as const,
      name: 'research',
      title: 'Research',
      description: 'Research.',
      pins: [{ noteId: 'note-a', title: 'A', loaded: true, tokens: 12, order: 0 }],
      sets: [],
      loadedTokens: 12,
    }

    expect(
      RoleContextViewSchema.safeParse({
        ...fields,
        scope: 'personal',
        locator: {
          source: 'owned',
          kind: 'role',
          packageId: 'RoleAAAAAAAA',
          location: { scope: 'personal', spaceId: 'personal-a' },
        },
      }).success,
    ).toBe(true)
    expect(
      RoleContextViewSchema.safeParse({
        ...fields,
        scope: 'space',
        space: 'team',
        locator: {
          source: 'owned',
          kind: 'role',
          packageId: 'RoleBBBBBBBB',
          location: { scope: 'space', spaceId: 'space-a' },
        },
      }).success,
    ).toBe(true)
    expect(
      RoleContextViewSchema.safeParse({
        ...fields,
        scope: 'project',
        space: 'team',
        project: 'team/docs',
        locator: {
          source: 'owned',
          kind: 'role',
          packageId: 'RoleCCCCCCCC',
          location: { scope: 'project', spaceId: 'space-a', projectId: 'project-a' },
        },
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
    expect(contract.agentAbilityDetail.response).toBe(AgentAbilityDetailResponseSchema)
    expect(contract.agentAbilityEnabled.request).toBe(SetAgentAbilityEnabledRequestSchema)
    expect(contract.agentAbilityEnabled.response).toBe(SetAgentAbilityEnabledResponseSchema)
    expect(contract.agentAbilityAvailability.request).toBe(SetAgentAbilityAvailabilityRequestSchema)
    expect(contract.agentAbilityAvailability.response).toBe(
      SetAgentAbilityAvailabilityResponseSchema,
    )
    expect(contract.agentRoles.request).toBe(AgentPackageLibraryQuerySchema)
    expect(contract.agentRoles.response).toBe(MeAgentRolesResponseSchema)
    // Detail is ONE operation for both kinds, addressed by an exact locator. A
    // per-kind, name-addressed detail entry would be a second way to say the same
    // thing — and the one that cannot tell two same-name placements apart.
    expect(contract).not.toHaveProperty('agentRoleDetail')
    expect(contract).not.toHaveProperty('agentSkillDetail')
    expect(contract.agentRoleAdd.request).toBe(AddAgentRoleRequestSchema)
    expect(contract.agentRoleAdd.response).toBe(AddAgentRoleResponseSchema)
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

  it('accepts only the approved role install availability wire shape', () => {
    const page = {
      items: [],
      projects: [],
      activeRole: null,
      filteredTotal: 0,
      nextCursor: null,
      facets: {
        source: { system: 0, catalog: 0, owned: 0 },
        home: { personal: 0, space: 0 },
        availability: { all: 0, selected: 0 },
        projects: [],
      },
    }

    expect(
      MeAgentRolesResponseSchema.safeParse({
        ...page,
        installAvailability: { personal: true, projects: { 'team/docs': false } },
      }).success,
    ).toBe(true)
    expect(
      MeAgentRolesResponseSchema.safeParse({
        ...page,
        installAvailability: { personal: true, targets: { 'team/docs': false } },
      }).success,
    ).toBe(false)
  })

  it('carries a role\u2019s project versions as a property, never as items of their own', () => {
    const base = {
      locator: {
        source: 'owned',
        kind: 'role',
        packageId: 'AbCdefGhij_1',
        location: { scope: 'space', spaceId: 'team-space-id' },
      },
      title: 'Launch review',
      name: 'launch-review',
      description: 'Review launch readiness.',
      noteId: 'ZyXwvUtsrq_1',
      origin: 'custom',
      source: 'owned',
      enabled: true,
      availability: { mode: 'selected-projects', projectIds: ['project-web'] },
      versions: [
        {
          projectId: 'project-web',
          locator: {
            source: 'owned',
            kind: 'role',
            packageId: 'AbCdefGhij_2',
            location: { scope: 'project', spaceId: 'team-space-id', projectId: 'project-web' },
          },
        },
      ],
    }
    const page = {
      projects: [],
      activeRole: null,
      filteredTotal: 1,
      nextCursor: null,
      facets: {
        source: { system: 0, catalog: 0, owned: 1 },
        home: { personal: 0, space: 1 },
        availability: { all: 0, selected: 1 },
        projects: [],
      },
    }

    expect(MeAgentRolesResponseSchema.safeParse({ ...page, items: [base] }).success).toBe(true)
    // A version is addressed by an exact ROLE locator; a skill locator there would
    // mean the collapse mixed two kinds into one entry.
    expect(
      MeAgentRolesResponseSchema.safeParse({
        ...page,
        items: [
          {
            ...base,
            versions: [
              {
                projectId: 'project-web',
                locator: {
                  source: 'owned',
                  kind: 'skill',
                  packageId: 'AbCdefGhij_2',
                  location: { scope: 'space', spaceId: 'team-space-id' },
                },
              },
            ],
          },
        ],
      }).success,
    ).toBe(false)
  })

  it('states where an ability is effective and where it lives, refusing empty answers', () => {
    expect(contract.agentAbilityVersions.request).toBe(CreateAbilityVersionRequestSchema)
    expect(contract.agentAbilityHome.request).toBe(SetAbilityHomeRequestSchema)
    expect(
      SetAgentAbilityAvailabilityRequestSchema.safeParse({ mode: 'all-projects' }).success,
    ).toBe(true)
    // "Selected, but nothing selected" is not a reach — it is an ability nobody can
    // use, arrived at by accident.
    expect(
      SetAgentAbilityAvailabilityRequestSchema.safeParse({
        mode: 'selected-projects',
        projectIds: [],
      }).success,
    ).toBe(false)
    expect(CreateAbilityVersionRequestSchema.safeParse({ projectId: 'project-web' }).success).toBe(
      true,
    )
    expect(CreateAbilityVersionRequestSchema.safeParse({}).success).toBe(false)
    // One direction only: a project version becomes the Space base. Sending a role
    // DOWN or sideways had no caller — where an ability belongs is edited as a
    // property, and a project body is created through `/versions`. Personal is a
    // different space besides, and the engine cannot move a note between two.
    expect(SetAbilityHomeRequestSchema.safeParse({ scope: 'space' }).success).toBe(true)
    expect(
      SetAbilityHomeRequestSchema.safeParse({ scope: 'project', projectId: 'project-web' }).success,
    ).toBe(false)
    expect(SetAbilityHomeRequestSchema.safeParse({ scope: 'project' }).success).toBe(false)
    expect(SetAbilityHomeRequestSchema.safeParse({ scope: 'personal' }).success).toBe(false)
    // The reach a promotion keeps is not optional: a move that stated nothing would
    // read as the Space-wide default and silently widen the role.
    expect(
      SetAbilityHomeResponseSchema.safeParse({
        locator: {
          source: 'owned',
          kind: 'role',
          packageId: 'AAAAAAAAAAAA',
          location: { scope: 'space', spaceId: 'space-team' },
        },
        noteId: 'AAAAAAAAAAAA',
      }).success,
    ).toBe(false)
  })

  it('accepts an H1-authored Role without a description', () => {
    expect(
      CreateAgentRoleRequestSchema.safeParse({
        name: 'review-changes',
        description: '',
        instructions: '# Review changes',
        scope: 'personal',
      }).success,
    ).toBe(true)
    expect(
      CreateAgentRoleRequestSchema.safeParse({
        name: 'review-changes',
        description: '',
        instructions: 'Review the changes.',
        scope: 'personal',
      }).success,
    ).toBe(false)
  })
})

describe('agent skills', () => {
  const project = {
    id: 'project-docs',
    handle: 'team/docs',
    displayName: 'Docs',
    space: 'team',
    status: 'active' as const,
  }

  it('registers a separate bounded inventory and catalog preview', () => {
    expect(contract.agentSkills.request).toBe(AgentPackageLibraryQuerySchema)
    expect(contract.agentSkills.response).toBe(MeAgentSkillsResponseSchema)
    expect(contract.agentSkillAdd.request).toBe(AddAgentSkillRequestSchema)
    expect(contract.agentSkillAdd.response).toBe(AddAgentSkillResponseSchema)
  })

  it('accepts only the approved skill install availability wire shape', () => {
    const page = {
      items: [],
      projects: [],
      filteredTotal: 0,
      nextCursor: null,
      facets: {
        source: { system: 0, catalog: 0, owned: 0 },
        home: { personal: 0, space: 0 },
        availability: { all: 0, selected: 0 },
        projects: [],
      },
    }

    expect(
      MeAgentSkillsResponseSchema.safeParse({
        ...page,
        installAvailability: { personal: true, spaces: { team: false } },
      }).success,
    ).toBe(true)
    expect(
      MeAgentSkillsResponseSchema.safeParse({
        ...page,
        installAvailability: { personal: true, targets: { team: false } },
      }).success,
    ).toBe(false)
  })

  it('keeps catalog identities read-only and owned identities note-addressable', () => {
    expect(
      MeAgentSkillsResponseSchema.safeParse({
        items: [
          {
            locator: { source: 'catalog', kind: 'skill', packageId: 'CatalogProof' },
            title: 'Grooming evidence',
            name: 'grooming-evidence',
            description: 'Catalog template.',
            source: 'catalog',
          },
          {
            locator: {
              source: 'owned',
              kind: 'skill',
              packageId: 'PersonalProo',
              location: { scope: 'personal', spaceId: 'personal-space-id' },
            },
            title: 'Personal proof',
            name: 'personal-proof',
            description: 'Custom.',
            noteId: 'AbCdefGhij_1',
            source: 'owned',
            origin: 'custom',
            enabled: true,
          },
          {
            locator: {
              source: 'owned',
              kind: 'skill',
              packageId: 'SpaceProof12',
              location: { scope: 'space', spaceId: 'team-space-id' },
            },
            title: 'Space proof',
            name: 'space-proof',
            description: 'Forked.',
            noteId: 'ZyXwvUtsrq_2',
            origin: 'catalog',
            originRevision: `sha256:${'a'.repeat(64)}`,
            source: 'owned',
            enabled: false,
          },
        ],
        projects: [project],
        filteredTotal: 3,
        nextCursor: null,
        facets: {
          source: { system: 0, catalog: 1, owned: 2 },
          home: { personal: 1, space: 1 },
          availability: { all: 1, selected: 1 },
          projects: [{ project, count: 2 }],
        },
        truncated: true,
      }).success,
    ).toBe(true)
    expect(
      MeAgentSkillsResponseSchema.safeParse({
        items: [
          {
            locator: { source: 'catalog', kind: 'skill', packageId: 'CatalogProof' },
            title: 'Grooming evidence',
            name: 'grooming-evidence',
            description: 'Catalog template.',
            source: 'catalog',
            noteId: 'must-not-exist',
          },
        ],
        projects: [],
        filteredTotal: 1,
        nextCursor: null,
        facets: {
          source: { system: 0, catalog: 1, owned: 0 },
          home: { personal: 0, space: 0 },
          availability: { all: 0, selected: 0 },
          projects: [],
        },
      }).success,
    ).toBe(false)
    expect(
      AddAgentSkillRequestSchema.safeParse({
        name: 'grooming-evidence',
        scope: 'space',
        space: 'team',
        availability: { mode: 'selected-projects', projects: ['team/docs'] },
      }).success,
    ).toBe(true)
    expect(
      AddAgentSkillRequestSchema.safeParse({
        name: 'grooming-evidence',
        scope: 'space',
        space: 'team',
      }).success,
    ).toBe(false)
  })

  it('shares the server-side library query without accepting the old active-space dump', () => {
    const query = {
      q: 'evidence',
      source: 'owned',
      home: 'space',
      availability: 'selected',
      project: 'team/docs',
      limit: '25',
      cursor: 'opaque',
    }

    // Roles and Skills share ONE query schema: the same three filters, the same
    // bound, the same cursor — a second copy is how the two libraries drift.
    expect(contract.agentRoles.request).toBe(contract.agentSkills.request)
    expect(AgentPackageLibraryQuerySchema.safeParse(query).success).toBe(true)
    expect(AgentPackageLibraryQuerySchema.safeParse({}).success).toBe(true)
    expect(AgentPackageLibraryQuerySchema.safeParse({ space: 'team' }).success).toBe(false)
    expect(AgentPackageLibraryQuerySchema.safeParse({ limit: 101 }).success).toBe(false)
  })
})
