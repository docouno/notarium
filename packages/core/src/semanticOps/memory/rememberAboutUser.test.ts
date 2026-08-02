import { describe, expect, it } from 'vitest'

import { buildMemoryIndex, rememberAboutUser } from './memory'
import { memStore } from './memoryTestStore.fixture'

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
    })
    expect(prefs.tokens).toBeGreaterThan(0)
    // No summary recorded → derive one from the content (spec §4 "none → derive").
    const work = index.find((e) => e.category === 'work')!
    expect(work.summary).toContain('shipping the gateway')
    // user-doc never appears in the memory index.
    expect(index.some((e) => e.noteId === 'doc-x')).toBe(false)
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
