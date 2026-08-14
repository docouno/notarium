import { describe, expect, it } from 'vitest'

import { type ConflictNote, NOTE_CLASS, READ_SCOPE } from '../../knowledgeStore'
import { computeVersionToken } from '../../libs/versionToken'
import { EXTERNAL_CONFLICT_BUDGET, NO_PROGRESS_BUDGET } from './consts'
import { buildMemoryIndex, rememberAboutUser } from './memory'
import { type MemRow, memStore } from './memoryTestStore.fixture'

describe('rememberAboutUser', () => {
  it('mints an agent-memory note for a new category, wiring class + summary', async () => {
    const store = memStore()
    const r = await rememberAboutUser(store, {
      observation: 'prefers dark mode',
      category: 'preferences',
      summary: 'UI preferences',
      principal: 'pat:alice:abc',
    })
    expect(store.rows).toHaveLength(1)
    const row = store.rows[0]
    expect(row.class).toBe('agent-memory')
    expect(row.title).toBe('preferences')
    expect(row.content).toBe('prefers dark mode')
    expect(row.summary).toBe('UI preferences')
    expect(store.writes[0].targetClass).toBe('agent-memory')
    expect(store.writes[0].principal).toBe('pat:alice:abc')
    // about-user lands at the agent-mount ROOT — no directory (the engine routes
    // by targetClass to the mount root).
    expect(store.writes[0].directory).toBeUndefined()
    expect(r.id).toBe('mem-preferences')
  })

  it('appends a second observation to the same category (no second note)', async () => {
    const store = memStore([
      {
        id: 'mem-preferences',
        title: 'preferences',
        class: 'agent-memory',
        content: 'prefers dark mode',
        summary: 'UI preferences',
      },
    ])
    await rememberAboutUser(store, { observation: 'uses vim keybindings', category: 'preferences' })
    expect(store.rows).toHaveLength(1)
    expect(store.rows[0].content).toBe('prefers dark mode\n\nuses vim keybindings')
  })

  it('matches the category by slug (case/spacing tolerant)', async () => {
    const store = memStore([
      {
        id: 'mem-ongoing-work',
        title: 'Ongoing Work',
        class: 'agent-memory',
        content: 'shipping #21',
      },
    ])
    await rememberAboutUser(store, { observation: 'review pending', category: 'ongoing work' })
    expect(store.rows).toHaveLength(1)
    expect(store.rows[0].content).toBe('shipping #21\n\nreview pending')
  })

  it('preserves an existing summary when none is given; updates it when provided', async () => {
    const store = memStore([
      { id: 'mem-c', title: 'c', class: 'agent-memory', content: 'a', summary: 'kept' },
    ])
    await rememberAboutUser(store, { observation: 'b', category: 'c' })
    expect(store.rows[0].summary).toBe('kept')
    await rememberAboutUser(store, { observation: 'd', category: 'c', summary: 'fresh' })
    expect(store.rows[0].summary).toBe('fresh')
  })

  it('carries the note tags/type forward on append (an omitted-tags write would clear them)', async () => {
    const store = memStore([
      { id: 'mem-c', title: 'c', class: 'agent-memory', content: 'a', tags: ['memory', 'pinned'] },
    ])
    await rememberAboutUser(store, { observation: 'b', category: 'c' })
    expect(store.writes[0].tags).toEqual(['memory', 'pinned'])
  })

  it('does NOT match a same-slug user-doc — memory writes only touch agent-memory', async () => {
    const store = memStore([
      { id: 'doc-notes', title: 'notes', class: 'user-doc', content: 'a knowledge doc' },
    ])
    await rememberAboutUser(store, { observation: 'a memory', category: 'notes' })
    // The user-doc is untouched; a NEW agent-memory note is minted.
    expect(store.rows).toHaveLength(2)
    expect(store.rows.find((r) => r.class === 'user-doc')!.content).toBe('a knowledge doc')
    expect(store.rows.find((r) => r.class === 'agent-memory')!.content).toBe('a memory')
  })

  it('does NOT match a same-category PROJECT memory note in a subdir — root-scoped (#13)', async () => {
    // none-mode reality: a project's memory shares the space's agent-mount with the
    // user's root memory. A project "general" note must NOT be the one a user
    // remember appends to (or it would corrupt project memory with user facts).
    const store = memStore([
      {
        id: 'proj-general',
        title: 'general',
        class: 'agent-memory',
        content: 'project fact',
        filePath: 'proj-a/general.md',
      },
    ])
    await rememberAboutUser(store, { observation: 'a user fact', category: 'general' })
    // The project note is untouched; a NEW root agent-memory note is minted.
    expect(store.rows).toHaveLength(2)
    expect(store.rows.find((r) => r.id === 'proj-general')!.content).toBe('project fact')
    const userNote = store.rows.find((r) => r.id !== 'proj-general')!
    expect(userNote.content).toBe('a user fact')
    expect(userNote.filePath).toBe('general.md') // root, no subdir
  })

  it('refuses a stale caller versionToken with a conflict, before writing', async () => {
    const store = memStore([{ id: 'mem-c', title: 'c', class: 'agent-memory', content: 'a' }])
    await expect(
      rememberAboutUser(store, { observation: 'b', category: 'c', versionToken: 'stale' }),
    ).rejects.toMatchObject({ isConflict: true })
    expect(store.writes).toHaveLength(0)
  })

  it('treats an explicitly empty caller versionToken as stale, not as absent', async () => {
    const store = memStore([
      { id: 'mem-c', title: 'c', class: 'agent-memory', content: 'a', filePath: 'c.md' },
    ])

    await expect(
      rememberAboutUser(store, { observation: 'blind', category: 'c', versionToken: '' }),
    ).rejects.toMatchObject({ isConflict: true })
    expect(store.writes).toHaveLength(0)
    expect(store.rows[0].content).toBe('a')
  })

  it('retries a lost CAS race internally when it owns the token (no caller guard)', async () => {
    let injected = false
    const store = memStore(
      [{ id: 'mem-c', title: 'c', class: 'agent-memory', content: 'a' }],
      (input) => {
        // First update attempt: mutate the row under us so the CAS check fails,
        // then let the retry succeed against the moved body.
        if (input.originalId && !injected) {
          injected = true
          store.rows[0].content = 'a\n\nconcurrent'
        }
      },
    )
    await rememberAboutUser(store, { observation: 'b', category: 'c' })
    // Appended onto the concurrently-updated body — no lost data.
    expect(store.rows[0].content).toBe('a\n\nconcurrent\n\nb')
  })

  it('converges a concurrent first-create race at the mount root (loser retries → appends)', async () => {
    let raced = false
    const store = memStore([], (input) => {
      // A concurrent writer minted the same root category note just before our
      // create (ifExists:'fail') → the create collides, the op retries → appends.
      if (!input.directory && !input.originalId && !raced) {
        raced = true
        store.rows.push({
          id: 'winner',
          title: 'general',
          class: 'agent-memory',
          content: 'winner fact',
          filePath: 'general.md',
        })
      }
    })
    await rememberAboutUser(store, { observation: 'loser fact', category: 'general' })
    const memory = store.rows.filter((r) => r.class === 'agent-memory')
    expect(memory).toHaveLength(1)
    expect(memory[0].content).toBe('winner fact\n\nloser fact')
  })
})

describe('buildMemoryIndex', () => {
  it('emits the authoritative id returned by a read of a provisional memory row', async () => {
    const store = memStore([
      {
        id: 'provisional-id',
        title: 'preferences',
        class: 'agent-memory',
        content: 'dark mode',
      },
    ])
    const read = store.read.bind(store)

    store.read = async (id, opts) => ({ ...(await read(id, opts)), id: 'durable-id' })
    await expect(buildMemoryIndex(store)).resolves.toEqual([
      expect.objectContaining({ noteId: 'durable-id' }),
    ])
  })

  it('one entry per agent-memory category, keyed off the summary frontmatter', async () => {
    const store = memStore([
      {
        id: 'mem-prefs',
        title: 'preferences',
        class: 'agent-memory',
        content: 'dark mode',
        summary: 'UI prefs',
      },
      { id: 'mem-work', title: 'work', class: 'agent-memory', content: 'shipping the gateway' },
      { id: 'doc-x', title: 'x', class: 'user-doc', content: 'not memory', summary: 'ignored' },
    ])
    const index = await buildMemoryIndex(store)
    expect(index).toHaveLength(2)
    const prefs = index.find((e) => e.category === 'preferences')!
    // `tokens` is the summary's token weight — the eager per-session cost.
    expect(prefs).toEqual({
      noteId: 'mem-prefs',
      category: 'preferences',
      summary: 'UI prefs',
      tokens: expect.any(Number),
      muted: false,
      createdAt: null,
      modifiedAt: null,
    })
    expect(prefs.tokens).toBeGreaterThan(0)
    // No summary recorded → derive one from the content (spec §4 "none → derive").
    const work = index.find((e) => e.category === 'work')!
    expect(work.summary).toContain('shipping the gateway')
    // user-doc never appears in the memory index.
    expect(index.some((e) => e.noteId === 'doc-x')).toBe(false)
    expect(store.listCalls).toEqual([{ scope: 'agentRecall', classes: ['agent-memory'] }])
    expect(store.readIds.sort()).toEqual(['mem-prefs', 'mem-work'])
  })

  it('the default (root) index EXCLUDES project memory in subdirs (#13)', async () => {
    // The about-user profile (start_session, /api/me/memory) must not surface a
    // project's memory as the user's own — the none-mode leak the root scope closes.
    const store = memStore([
      { id: 'mem-prefs', title: 'preferences', class: 'agent-memory', content: 'dark mode' },
      {
        id: 'proj-mem',
        title: 'decisions',
        class: 'agent-memory',
        content: 'chose X',
        filePath: 'proj-a/decisions.md',
      },
    ])
    const index = await buildMemoryIndex(store)
    expect(index.map((e) => e.noteId)).toEqual(['mem-prefs'])
  })

  it('scoped to a project subdir, returns only THAT project memory (#13 I5 prep)', async () => {
    const store = memStore([
      { id: 'mem-prefs', title: 'preferences', class: 'agent-memory', content: 'dark mode' },
      {
        id: 'proj-a-mem',
        title: 'decisions',
        class: 'agent-memory',
        content: 'chose X',
        filePath: 'proj-a/decisions.md',
      },
      {
        id: 'proj-b-mem',
        title: 'decisions',
        class: 'agent-memory',
        content: 'chose Y',
        filePath: 'proj-b/decisions.md',
      },
    ])
    const index = await buildMemoryIndex(store, { subdir: 'proj-a' })
    expect(index.map((e) => e.noteId)).toEqual(['proj-a-mem'])
  })

  it('reports the human-set `muted` opt-out per category (#165)', async () => {
    // The store round-trips `muted` as the YAML-true STRING 'true' (mirroring the
    // real engine's non-coercing parser) — buildMemoryIndex normalises it to a
    // boolean, so the audit can show muted categories while the profile drops them.
    const store = memStore([
      { id: 'mem-loud', title: 'preferences', class: 'agent-memory', content: 'dark mode' },
      {
        id: 'mem-muted',
        title: 'stale-fact',
        class: 'agent-memory',
        content: 'old truth',
        muted: true,
      },
    ])
    const index = await buildMemoryIndex(store)
    expect(index.find((e) => e.noteId === 'mem-loud')?.muted).toBe(false)
    expect(index.find((e) => e.noteId === 'mem-muted')?.muted).toBe(true)
  })

  it('strips an explicit agent-mount prefix off filePath (real-engine notation)', async () => {
    // The production engine prepends `.notarium/memory` to filePath; the root scope
    // must still recognise a root memory note carrying that prefix.
    const store = memStore([
      {
        id: 'mem-prefs',
        title: 'preferences',
        class: 'agent-memory',
        content: 'dark mode',
        filePath: '.notarium/memory/preferences.md',
      },
      {
        id: 'proj-mem',
        title: 'decisions',
        class: 'agent-memory',
        content: 'chose X',
        filePath: '.notarium/memory/proj-a/decisions.md',
      },
    ])
    expect((await buildMemoryIndex(store)).map((e) => e.noteId)).toEqual(['mem-prefs'])
    expect((await buildMemoryIndex(store, { subdir: 'proj-a' })).map((e) => e.noteId)).toEqual([
      'proj-mem',
    ])
  })
})

// #296 — a category is matched against a note TITLE, so a category with nothing
// sluggable in it used to share the empty key with every other: the second one's
// observation was appended into the first one's note and no note of its own was made.
describe('a letterless memory category', () => {
  it('lands on a path derived from the CATEGORY, not on the id rung', async () => {
    // Find-or-append converges because a concurrent first-touch aims at the SAME path
    // and is refused there. Leave the path to the name formula and a letterless
    // category falls to its id rung, where every racer mints a different id, nobody
    // collides, and one category ends up with two notes. So the file name is pinned to
    // the category: deterministic, and identical for every writer.
    const store = memStore()
    await rememberAboutUser(store, { category: '🎉', observation: 'first' })
    // The SECOND call matters as much as the first: an append that stops pinning the
    // name re-derives it, lands back on the id rung, and frees the pinned path — so the
    // pin would hold for exactly one write.
    await rememberAboutUser(store, { category: '🎉', observation: 'second' })
    const [note] = await store.list({ scope: READ_SCOPE.agentRecall })
    const path = note.filePath

    expect(path).not.toMatch(/mem-/) // not the id rung
    expect(path).toMatch(/^category-[a-f0-9]{24}\.md$/)

    // A second writer that has not yet seen the note aims at the SAME file and is
    // refused, which is what makes the retry converge instead of forking the category.
    await expect(
      store.write({
        title: '🎉',
        content: 'racer',
        targetClass: NOTE_CLASS.agentMemory,
        fileName: path.replace(/\.md$/, ''),
      }),
    ).rejects.toMatchObject({ reason: 'note_already_exists' })
  })

  it('gets its own note instead of appending into another one', async () => {
    const store = memStore()
    await rememberAboutUser(store, { category: '🎉', observation: 'party fact' })
    await rememberAboutUser(store, { category: '✨', observation: 'sparkle fact' })

    const index = await buildMemoryIndex(store)
    const categories = index.map((entry) => entry.category).sort()

    expect(categories).toEqual(['✨', '🎉'])
  })

  it('does not collide on distinct category keys that share the legacy 32-bit hash', async () => {
    const store = memStore()
    const first = '🎟🏃🎩🏒🏋🌈🏚🌢🍔🎣'
    const second = '🍞🏜🏬🏇🎨🍞🍃🎴🌑🎚'

    await rememberAboutUser(store, { category: first, observation: 'first fact' })
    await rememberAboutUser(store, { category: second, observation: 'second fact' })

    const memories = await store.list({ scope: READ_SCOPE.agentRecall })

    expect(memories).toHaveLength(2)
    expect(new Set(memories.map((note) => note.filePath)).size).toBe(2)
  })
})

// The fixture models the engines, so its refusals have to look like theirs: refused
// BEFORE anything is written, and shaped as a move failure rather than the
// `note_already_exists` the create path retries on.
describe('the memory fixture refuses a rename the engines refuse', () => {
  it('leaves the note untouched when the destination is occupied', async () => {
    const store = memStore([
      { id: 'a', title: '🎉', class: NOTE_CLASS.agentMemory, content: 'old', filePath: 'other.md' },
      {
        id: 'b',
        title: '✨',
        class: NOTE_CLASS.agentMemory,
        content: 'x',
        filePath: 'category-6146299cd54818a0e659eb6a.md',
      },
    ])

    await expect(
      rememberAboutUser(store, { category: '🎉', observation: 'NEW' }),
    ).rejects.toMatchObject({ isToolError: true })

    // Half-applied is the thing to rule out: the body must not have moved on.
    expect(store.rows.find((r) => r.id === 'a')!.content).toBe('old')
    expect(store.rows.find((r) => r.id === 'a')!.filePath).toBe('other.md')
  })
})

// The convergence contract (#341): concurrent remembers of ONE category converge —
// every accepted observation lands exactly once — while other categories stay
// parallel. Direct calls under Promise.all are racy in the fixture WITHOUT the fence
// (baseline: 3 of 16 succeeded, the rest threw version_conflict), so these need no
// interleaving seam; the two that gate retry MECHANICS instead of the defect are
// marked and name the wrong implementation they are red on.
describe('memory append convergence', () => {
  /** What a CAS-refusing engine throws. `current` is optional on purpose: both real
   *  engines ride the live token on the error, the fixture does not — and the
   *  progress test has to cover both sources. */
  const casConflict = (current?: ConflictNote): Error => {
    const err = new Error('conflict') as Error & {
      isConflict: boolean
      current?: ConflictNote
    }

    err.isConflict = true
    if (current) {
      err.current = current
    }

    return err
  }

  const seeded = (over: Partial<MemRow> = {}): MemRow[] => [
    {
      id: 'mem-notes',
      title: 'notes',
      class: NOTE_CLASS.agentMemory,
      content: 'seed',
      ...over,
    },
  ]

  /** The body's paragraphs, sorted — comparing the SET pins "every observation, each
   *  exactly once, and nothing else" in one assertion. Substring counting would not:
   *  `obs-1` also occurs inside `obs-10`. */
  const paragraphs = (body: string): string[] => body.split('\n\n').sort()

  const observations = (count: number): string[] =>
    Array.from({ length: count }, (_, i) => `obs-${i}`)

  const concurrently = (
    store: ReturnType<typeof memStore>,
    count: number,
    category: (i: number) => string = () => 'notes',
  ) =>
    Promise.all(
      observations(count).map((observation, i) =>
        rememberAboutUser(store, { observation, category: category(i) }),
      ),
    )

  it('lands all 16 concurrent observations of one category in one note, exactly once', async () => {
    const store = memStore()
    const results = await concurrently(store, 16)

    expect(store.rows).toHaveLength(1)
    expect(paragraphs(store.rows[0].content)).toEqual(observations(16).sort())
    expect(results.filter((r) => r.outcome === 'created')).toHaveLength(1)
    expect(results.filter((r) => r.outcome === 'appended')).toHaveLength(15)
  })

  it('appends all 16 onto an existing category without disturbing its body', async () => {
    const store = memStore(seeded())
    const results = await concurrently(store, 16)

    expect(store.rows).toHaveLength(1)
    expect(store.rows[0].content.split('\n\n')[0]).toBe('seed')
    expect(results.every((r) => r.outcome === 'appended')).toBe(true)
    expect(paragraphs(store.rows[0].content)).toEqual(['seed', ...observations(16)].sort())
  })

  // MECHANICS GATE, not a defect gate — green on main, red on a fence that claims
  // `{ global: true }` or a prefix instead of the single category key: there the held
  // writer of `c0` would hold every other category's writer behind it too.
  it('keeps other categories running while one category writer is held', async () => {
    const store = memStore()
    const held = { resolve: (): void => {} }
    const release = new Promise<void>((resolve) => {
      held.resolve = resolve
    })
    const write = store.write

    store.write = async (input) => {
      if (input.title === 'c0') {
        await release
      }

      return write(input)
    }
    const calls = observations(8).map((observation, i) =>
      rememberAboutUser(store, { observation, category: `c${i}` }),
    )
    // The seven unrelated writers must SETTLE while c0 is still parked in write().
    const others = await Promise.all(calls.slice(1))

    expect(others).toHaveLength(7)
    held.resolve()
    await calls[0]
    expect(store.rows).toHaveLength(8)
  })

  it('fails an explicit stale caller token fast, without writing, under concurrency', async () => {
    const store = memStore(seeded())
    const settled = await Promise.allSettled([
      ...observations(8).map((observation) =>
        rememberAboutUser(store, { observation, category: 'notes' }),
      ),
      rememberAboutUser(store, {
        observation: 'stale-token-observation',
        category: 'notes',
        versionToken: 'stale',
      }),
    ])

    expect(settled.slice(0, 8).every((r) => r.status === 'fulfilled')).toBe(true)
    const loser = settled[8]

    expect(loser.status).toBe('rejected')
    expect((loser as PromiseRejectedResult).reason).toMatchObject({ isConflict: true })
    // The observable that survives a re-run: its observation is nowhere in the body.
    expect(store.rows[0].content).not.toContain('stale-token-observation')
  })

  // MECHANICS GATE, not a defect gate — red on ONE shared attempt counter: there the
  // productive-retry budget pays for a conflict that can never converge, and the op
  // either gives up early or spins.
  it('gives up with a named reason when a conflict makes no progress', async () => {
    let attempts = 0
    const store = memStore(seeded(), (input) => {
      if (input.originalId) {
        attempts += 1
        // Body untouched → the live token still equals the one we failed on.
        throw casConflict()
      }
    })

    await expect(
      rememberAboutUser(store, { observation: 'obs', category: 'notes' }),
    ).rejects.toMatchObject({ reason: 'memory_convergence_exhausted', isConflict: true })
    expect(attempts).toBe(NO_PROGRESS_BUDGET + 1)
  })

  it('keeps summary, tags and type intact under 8 concurrent appends', async () => {
    const store = memStore(
      seeded({ summary: 'kept', tags: ['memory', 'pinned'], type: 'memory-note' }),
    )
    const results = await concurrently(store, 8)

    expect(store.rows[0].summary).toBe('kept')
    expect(store.rows[0].tags).toEqual(['memory', 'pinned'])
    expect(store.rows[0].type).toBe('memory-note')
    expect(results.every((r) => r.summaryUpdated === false)).toBe(true)
    expect(paragraphs(store.rows[0].content)).toEqual(['seed', ...observations(8)].sort())
  })

  it('applies the one concurrent summary overwrite and reports it on that call alone', async () => {
    const store = memStore(seeded({ summary: 'kept' }))
    const results = await Promise.all(
      observations(8).map((observation, i) =>
        rememberAboutUser(store, {
          observation,
          category: 'notes',
          summary: i === 3 ? 'fresh' : undefined,
        }),
      ),
    )

    expect(store.rows[0].summary).toBe('fresh')
    expect(results[3].summaryUpdated).toBe(true)
    expect(results.filter((r) => r.summaryUpdated)).toHaveLength(1)
  })

  it('converges a letterless category onto its single hashed file', async () => {
    const store = memStore()

    await concurrently(store, 16, () => '🎉')

    expect(store.rows).toHaveLength(1)
    expect(store.rows[0].filePath).toMatch(/^category-[0-9a-f]+\.md$/)
    expect(paragraphs(store.rows[0].content)).toEqual(observations(16).sort())
  })

  it('converges two spellings the find treats as one category into one note', async () => {
    const store = memStore()

    // `ᾳ` and `ΑΙ` share the name KEY (`ai`) but not the slug (`a` vs `ai`) — a fence
    // keyed on the file name would let them run in parallel and mint two notes (#296).
    await concurrently(store, 16, (i) => (i % 2 ? 'ᾳ' : 'ΑΙ'))

    expect(store.rows).toHaveLength(1)
    expect(paragraphs(store.rows[0].content)).toEqual(observations(16).sort())
  })

  it('retries productively while a foreign writer keeps committing', async () => {
    // Three, not one or two: the pre-fix budget allowed three passes, so a smaller
    // number is green without the fix and proves nothing.
    const foreign = 3
    let injected = 0
    const store = memStore(seeded(), (input) => {
      if (input.originalId && injected < foreign) {
        injected += 1
        // A commit by somebody else, THEN the refusal our write gets for it.
        store.rows[0].content = `${store.rows[0].content}\n\nforeign-${injected}`
        throw casConflict()
      }
    })

    const r = await rememberAboutUser(store, { observation: 'obs', category: 'notes' })

    expect(r.outcome).toBe('appended')
    expect(store.rows[0].content).toBe('seed\n\nforeign-1\n\nforeign-2\n\nforeign-3\n\nobs')
    // Every retry re-FINDS the category (it never re-targets the note id), so the
    // list runs once per pass: the initial one plus one per conflict.
    expect(store.listCalls).toHaveLength(foreign + 1)
  })

  it('reads the live token off the error when the engine rides one', async () => {
    const foreign = 3
    let injected = 0
    const store = memStore(seeded(), (input) => {
      if (input.originalId && injected < foreign) {
        injected += 1
        store.rows[0].content = `${store.rows[0].content}\n\nforeign-${injected}`
        throw casConflict({
          id: store.rows[0].id,
          title: store.rows[0].title,
          class: store.rows[0].class,
          content: store.rows[0].content,
          frontmatter: {},
          filePath: store.rows[0].filePath,
          versionToken: computeVersionToken(store.rows[0].content),
        })
      }
    })

    const r = await rememberAboutUser(store, { observation: 'obs', category: 'notes' })

    expect(r.outcome).toBe('appended')
    // One read per pass and no more: `err.current` answered the progress question, so
    // the re-read fallback never ran (it would add one read per conflict).
    expect(store.readIds).toHaveLength(foreign + 1)
  })

  it('gives up with a named reason when foreign commits outlast the budget', async () => {
    let attempts = 0
    const store = memStore(seeded(), (input) => {
      if (input.originalId) {
        attempts += 1
        store.rows[0].content = `${store.rows[0].content}\n\nforeign-${attempts}`
        throw casConflict({
          id: store.rows[0].id,
          title: store.rows[0].title,
          class: store.rows[0].class,
          content: store.rows[0].content,
          frontmatter: {},
          filePath: store.rows[0].filePath,
          versionToken: computeVersionToken(store.rows[0].content),
        })
      }
    })

    const failure = await rememberAboutUser(store, { observation: 'obs', category: 'notes' }).then(
      () => undefined,
      (err: unknown) => err,
    )

    expect(failure).toMatchObject({
      reason: 'memory_convergence_exhausted',
      isConflict: true,
      // The count is the point: it separates this from the no-progress exhaustion.
      message: expect.stringContaining(`${EXTERNAL_CONFLICT_BUDGET + 1} intervening commit`),
      current: {
        content: store.rows[0].content,
        versionToken: computeVersionToken(store.rows[0].content),
      },
    })
    expect(attempts).toBe(EXTERNAL_CONFLICT_BUDGET + 1)
    expect(store.rows[0].content).not.toContain('obs')
  })
})
