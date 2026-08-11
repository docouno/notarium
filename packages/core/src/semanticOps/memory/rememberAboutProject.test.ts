import { describe, expect, it } from 'vitest'

import { memoryDirOf, rememberAboutProject } from './memory'
import { memStore } from './memoryTestStore.fixture'

describe('rememberAboutProject', () => {
  const observations = Array.from({ length: 16 }, (_, i) => `obs-${i}`)
  const paragraphs = (body: string): string[] => body.split('\n\n').sort()

  it('mints an agent-memory note in the project subdir, wiring class + mount-relative directory', async () => {
    const store = memStore()
    const r = await rememberAboutProject(store, {
      projectId: 'projAAA',
      observation: 'chose Postgres for the registry',
      category: 'decisions',
      summary: 'architecture decisions',
      principal: 'pat:alice:abc',
    })
    expect(store.rows).toHaveLength(1)
    const row = store.rows[0]
    expect(row.class).toBe('agent-memory')
    expect(row.title).toBe('decisions')
    expect(row.content).toBe('chose Postgres for the registry')
    expect(row.summary).toBe('architecture decisions')
    expect(row.filePath).toBe('projAAA/decisions.md')
    // `directory` is MOUNT-relative — the bare project id, NOT prefixed with
    // `.notarium/memory` (the engine prepends that once; double-prefix trap).
    expect(store.writes[0].directory).toBe('projAAA')
    expect(store.writes[0].targetClass).toBe('agent-memory')
    expect(store.writes[0].principal).toBe('pat:alice:abc')
    expect(r.id).toBe('mem-proj-aaa-decisions')
  })

  it('appends a second observation to the same project category (one note)', async () => {
    const store = memStore([
      {
        id: 'p-decisions',
        title: 'decisions',
        class: 'agent-memory',
        content: 'chose Postgres',
        filePath: 'projAAA/decisions.md',
      },
    ])
    await rememberAboutProject(store, {
      projectId: 'projAAA',
      observation: 'sharded by space',
      category: 'decisions',
    })
    expect(store.rows).toHaveLength(1)
    expect(store.rows[0].content).toBe('chose Postgres\n\nsharded by space')
  })

  it('does NOT cross-contaminate a SIBLING project with the same category (#13)', async () => {
    // Two projects share the space's agent-mount; both have a "general" memory.
    // remember to project B must NOT append into project A's note.
    const store = memStore([
      {
        id: 'a-general',
        title: 'general',
        class: 'agent-memory',
        content: 'A fact',
        filePath: 'projAAA/general.md',
      },
      {
        id: 'b-general',
        title: 'general',
        class: 'agent-memory',
        content: 'B fact',
        filePath: 'projBBB/general.md',
      },
    ])
    await rememberAboutProject(store, {
      projectId: 'projBBB',
      observation: 'new B fact',
      category: 'general',
    })
    expect(store.rows.find((r) => r.id === 'a-general')!.content).toBe('A fact')
    expect(store.rows.find((r) => r.id === 'b-general')!.content).toBe('B fact\n\nnew B fact')
    expect(store.rows).toHaveLength(2) // no new note minted
  })

  it('does NOT match the USER ROOT memory of the same category (#13)', async () => {
    // A root (about-user) "general" note must not be the target of a project remember.
    const store = memStore([
      {
        id: 'user-general',
        title: 'general',
        class: 'agent-memory',
        content: 'user fact',
        filePath: 'general.md',
      },
    ])
    await rememberAboutProject(store, {
      projectId: 'projAAA',
      observation: 'project fact',
      category: 'general',
    })
    expect(store.rows.find((r) => r.id === 'user-general')!.content).toBe('user fact')
    expect(store.rows).toHaveLength(2)
    expect(store.rows.find((r) => r.id !== 'user-general')!.filePath).toBe('projAAA/general.md')
  })

  it('finds an existing note that carries the real-engine mount prefix on its path', async () => {
    // Production filePath is `.notarium/memory/<id>/<cat>.md`; the find must strip
    // the prefix and still recognise the project's own category note.
    const store = memStore([
      {
        id: 'p-decisions',
        title: 'decisions',
        class: 'agent-memory',
        content: 'chose Postgres',
        filePath: '.notarium/memory/projAAA/decisions.md',
      },
    ])
    await rememberAboutProject(store, {
      projectId: 'projAAA',
      observation: 'sharded by space',
      category: 'decisions',
    })
    expect(store.rows).toHaveLength(1)
    expect(store.rows[0].content).toBe('chose Postgres\n\nsharded by space')
  })

  it('refuses a stale caller versionToken with a conflict, before writing', async () => {
    const store = memStore([
      { id: 'p-c', title: 'c', class: 'agent-memory', content: 'a', filePath: 'projAAA/c.md' },
    ])
    await expect(
      rememberAboutProject(store, {
        projectId: 'projAAA',
        observation: 'b',
        category: 'c',
        versionToken: 'stale',
      }),
    ).rejects.toMatchObject({ isConflict: true })
    expect(store.writes).toHaveLength(0)
  })

  it('retries a lost CAS race internally when it owns the token', async () => {
    let injected = false
    const store = memStore(
      [{ id: 'p-c', title: 'c', class: 'agent-memory', content: 'a', filePath: 'projAAA/c.md' }],
      (input) => {
        if (input.originalId && !injected) {
          injected = true
          store.rows[0].content = 'a\n\nconcurrent'
        }
      },
    )
    await rememberAboutProject(store, { projectId: 'projAAA', observation: 'b', category: 'c' })
    expect(store.rows[0].content).toBe('a\n\nconcurrent\n\nb')
  })

  it('converges a concurrent first-create race: the create loser retries → finds → appends', async () => {
    let raced = false
    const store = memStore([], (input) => {
      // Just before OUR create (ifExists:'fail') lands, a concurrent writer minted
      // the same category note in the same subdir → our create collides.
      if (input.directory === 'projAAA' && !input.originalId && !raced) {
        raced = true
        store.rows.push({
          id: 'winner',
          title: 'general',
          class: 'agent-memory',
          content: 'winner fact',
          filePath: 'projAAA/general.md',
        })
      }
    })
    await rememberAboutProject(store, {
      projectId: 'projAAA',
      observation: 'loser fact',
      category: 'general',
    })
    // One note (the winner's), both facts appended — no hard error, no lost data.
    const memory = store.rows.filter((r) => r.class === 'agent-memory')
    expect(memory).toHaveLength(1)
    expect(memory[0].content).toBe('winner fact\n\nloser fact')
  })

  it('lands 16 concurrent observations of one project category exactly once', async () => {
    const store = memStore()
    const results = await Promise.all(
      observations.map((observation) =>
        rememberAboutProject(store, { projectId: 'projAAA', observation, category: 'general' }),
      ),
    )

    expect(store.rows).toHaveLength(1)
    expect(store.rows[0].filePath).toBe('projAAA/general.md')
    expect(paragraphs(store.rows[0].content)).toEqual([...observations].sort())
    expect(results.filter((result) => result.outcome === 'created')).toHaveLength(1)
    expect(results.filter((result) => result.outcome === 'appended')).toHaveLength(15)
  })

  it('keeps concurrent observations in their two project partitions', async () => {
    const store = memStore()

    await Promise.all(
      observations.map((observation, index) =>
        rememberAboutProject(store, {
          projectId: index % 2 === 0 ? 'projAAA' : 'projBBB',
          observation,
          category: 'general',
        }),
      ),
    )

    expect(store.rows).toHaveLength(2)
    expect(
      paragraphs(store.rows.find((row) => row.filePath === 'projAAA/general.md')!.content),
    ).toEqual(observations.filter((_, index) => index % 2 === 0).sort())
    expect(
      paragraphs(store.rows.find((row) => row.filePath === 'projBBB/general.md')!.content),
    ).toEqual(observations.filter((_, index) => index % 2 === 1).sort())
  })

  // Mechanics gate: a fence key that drops `subdir` blocks projBBB behind projAAA.
  it('does not hold one project partition behind another with the same category', async () => {
    const store = memStore()

    let markArrived = (): void => {}

    let releaseHeld = (): void => {}
    const arrived = new Promise<void>((resolve) => {
      markArrived = resolve
    })
    const release = new Promise<void>((resolve) => {
      releaseHeld = resolve
    })
    const write = store.write

    store.write = async (input) => {
      if (input.directory === 'projAAA') {
        markArrived()
        await release
      }

      return write(input)
    }
    const held = rememberAboutProject(store, {
      projectId: 'projAAA',
      observation: 'A',
      category: 'general',
    })

    await arrived
    await expect(
      rememberAboutProject(store, {
        projectId: 'projBBB',
        observation: 'B',
        category: 'general',
      }),
    ).resolves.toMatchObject({ outcome: 'created' })
    releaseHeld()
    await held
  })
})

describe('memoryDirOf', () => {
  it('recovers the mount-relative dir, stripping an optional agent-mount prefix', () => {
    // Fake-engine notation (no prefix).
    expect(memoryDirOf('general.md')).toBe('')
    expect(memoryDirOf('projAAA/general.md')).toBe('projAAA')
    // Real-engine notation (prefixed).
    expect(memoryDirOf('.notarium/memory/general.md')).toBe('')
    expect(memoryDirOf('.notarium/memory/projAAA/general.md')).toBe('projAAA')
    // A custom prefix is honoured.
    expect(memoryDirOf('mem/projAAA/x.md', 'mem')).toBe('projAAA')
  })
})
