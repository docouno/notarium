import { describe, expect, it } from 'vitest'
import type { KnowledgeStore, NoteClass, TagMutationInput, WriteInput } from '@notarium/core'

import {
  curatePersonalScope,
  curateProjectScope,
  enqueueConditionalNotePin,
  personalProfilePin,
  resolveContextSets,
  resolveScopePins,
  SCOPE_ITEM_CAP,
  type ScopeSetRefs,
  setNoteMuted,
  setNotePinned,
  weighAlwaysLoad,
  type WeighedSet,
} from './agentContext'

// The scope-curation composition (#208/#209): one SINGLE budget over an ordered chain
// — local pins, then attached SET items, then memory — with the flat curateBudget
// loaded[] split back onto pins vs sets vs memory (and, in a project, project-first
// then embedded personal). curateBudget's flat primitive is unit-tested in core; THIS
// pins down the split/offset arithmetic, the muted exclusion, the pin→set→memory
// priority, and the cross-set/pin DEDUP the pult + start_session ride.

const pin = (noteId: string, tokens: number) => ({ noteId, title: noteId.toUpperCase(), tokens })
/** A LOOSE cross-space pin (#209): a pin carrying its home `space`, merged into the pin
 *  list by the callers alongside the same-space (space-less) tag pins. */
const crossPin = (noteId: string, tokens: number, space: string) => ({
  noteId,
  title: noteId.toUpperCase(),
  tokens,
  space,
})
const mem = (noteId: string, tokens: number, muted = false) => ({ noteId, tokens, muted })
const set = (id: string, ...items: Array<[string, number]>): WeighedSet => ({
  id,
  name: id,
  homeSpace: 'sp',
  items: items.map(([noteId, tokens]) => ({
    noteId,
    title: noteId.toUpperCase(),
    tokens,
    space: 'sp',
  })),
})

const BIG = 1_000_000 // a budget nothing can exhaust

const rawSet = (id: string, count: number, read: ScopeSetRefs['read']): ScopeSetRefs => ({
  id,
  name: id,
  homeSpace: 'sp',
  items: Array.from({ length: count }, (_, index) => ({ noteId: `${id}-${index}` })),
  read,
  coordinatesVisible: true,
})

const rekeyingStore = (noteClass: NoteClass = 'user-doc') => {
  const writes: WriteInput[] = []
  const tagMutations: TagMutationInput[] = []
  const store = {
    list: async () => [
      {
        id: 'provisional-id',
        title: 'Listed title',
        class: noteClass,
        filePath: 'listed.md',
        tags: ['always-load'],
        modifiedAt: null,
        createdAt: null,
      },
    ],
    read: async () => ({
      id: 'durable-id',
      title: 'Read title',
      class: noteClass,
      filePath: 'listed.md',
      content: 'body',
      frontmatter: { tags: [] },
      versionToken: 'token',
    }),
    write: async (input: WriteInput) => {
      writes.push(input)
      return { id: 'durable-id', versionToken: 'next' }
    },
    mutateTags: async (input: TagMutationInput) => {
      tagMutations.push(input)
      return { changed: true, tags: [...(input.add ?? [])] }
    },
  } as unknown as KnowledgeStore
  return { store, writes, tagMutations }
}

describe('agent-context identity producers', () => {
  it('uses the authoritative read id for cross-space pins and set items', async () => {
    const read = async () => ({
      noteId: 'durable-id',
      title: 'Target',
      content: 'body',
      spaceSlug: 'docs',
      filePath: 'handbook/index.md',
    })

    await expect(resolveScopePins(['provisional-id'], read)).resolves.toEqual([
      expect.objectContaining({ noteId: 'durable-id', folderPage: true }),
    ])
    const [resolved] = await resolveContextSets(
      [
        {
          id: 'set-id',
          homeSpace: 'home',
          name: 'Set',
          items: [{ space: 'docs', noteId: 'provisional-id' }],
          createdAt: '2026-08-05T00:00:00.000Z',
        },
      ],
      read,
    )
    expect(resolved.items).toEqual([
      expect.objectContaining({ noteId: 'durable-id', folderPage: true }),
    ])
  })

  it('uses the authoritative read id for always-load and profile pins', async () => {
    const tagged = rekeyingStore()
    const profile = rekeyingStore('profile')

    await expect(weighAlwaysLoad(tagged.store)).resolves.toEqual([
      expect.objectContaining({ noteId: 'durable-id', title: 'Read title' }),
    ])
    await expect(personalProfilePin(profile.store)).resolves.toMatchObject({
      noteId: 'durable-id',
      title: 'Read title',
    })
  })

  it('uses identity-published metadata and facts without opening pin/profile bodies', async () => {
    const tagged = rekeyingStore()
    const profile = rekeyingStore('profile')
    const facts = async () => ({
      'provisional-id': {
        title: 'Projected title',
        summary: null,
        snippet: 'Body',
        muted: false,
        bodyTokens: 17,
      },
    })

    tagged.store.noteFacts = facts
    profile.store.noteFacts = facts
    tagged.store.read = async () => {
      throw new Error('pin body should stay unread')
    }
    profile.store.read = async () => {
      throw new Error('profile body should stay unread')
    }

    await expect(weighAlwaysLoad(tagged.store)).resolves.toEqual([
      expect.objectContaining({ noteId: 'provisional-id', title: 'Projected title', tokens: 17 }),
    ])
    await expect(personalProfilePin(profile.store)).resolves.toMatchObject({
      noteId: 'provisional-id',
      title: 'Projected title',
    })
  })

  it('routes pin toggles through the atomic tag port while mute keeps its CAS path', async () => {
    const { store, writes, tagMutations } = rekeyingStore()

    await setNotePinned(store as never, 'provisional-id', true)
    await setNoteMuted(store, 'provisional-id', true)
    expect(tagMutations).toEqual([
      expect.objectContaining({ id: 'durable-id', add: ['always-load'] }),
    ])
    expect(writes.map((write) => write.originalId)).toEqual(['durable-id'])
  })

  it('refuses a mute it cannot place in a memory partition instead of guessing one', async () => {
    // A pathless note leaves the fence key underivable, and the tempting `?? ''`
    // default is a WRONG key, not a missing one: it aims at the about-user root.
    const store = {
      read: async () => ({ id: 'x', title: 'Read title', class: 'agent-memory', content: 'b' }),
      write: async () => ({ id: 'x', versionToken: 'next' }),
    } as unknown as KnowledgeStore

    await expect(setNoteMuted(store, 'x', true)).rejects.toMatchObject({ isToolError: true })
  })

  it('propagates a mute CAS conflict after one write attempt instead of retrying', async () => {
    let reads = 0
    let writes = 0
    const conflict = Object.assign(new Error('conflict'), { isConflict: true })
    const store = {
      read: async () => {
        reads += 1
        return {
          id: 'memory-id',
          title: 'general',
          class: 'agent-memory',
          filePath: '.notarium/memory/project-id/general.md',
          content: 'body',
          frontmatter: {},
          versionToken: 'token',
        }
      },
      write: async () => {
        writes += 1
        throw conflict
      },
    } as unknown as KnowledgeStore

    await expect(setNoteMuted(store, 'memory-id', true)).rejects.toBe(conflict)
    expect(reads).toBe(2)
    expect(writes).toBe(1)
  })
})

describe('pin mutation FIFO', () => {
  it('runs a later manual unpin after a delayed conditional auto-pin', async () => {
    let openTransition!: (created: boolean) => void
    const transition = new Promise<boolean>((resolve) => {
      openTransition = resolve
    })
    let releaseAdd!: () => void
    const addBlocked = new Promise<void>((resolve) => {
      releaseAdd = resolve
    })
    let addEntered!: () => void
    const sawAdd = new Promise<void>((resolve) => {
      addEntered = resolve
    })
    const calls: TagMutationInput[] = []
    const store = {
      read: async (id: string) => ({ id, title: 'Overview', class: 'user-doc', content: '' }),
      mutateTags: async (input: TagMutationInput) => {
        calls.push(input)
        if (input.add?.includes('always-load')) {
          addEntered()
          await addBlocked
        }

        return { changed: true, tags: [] }
      },
    }

    const automatic = enqueueConditionalNotePin(store as never, 'overview', transition)
    const manual = setNotePinned(store as never, 'overview', false)
    openTransition(true)
    await sawAdd
    expect(calls).toHaveLength(1)
    releaseAdd()
    await Promise.all([automatic.completion, manual])
    expect(calls.map((input) => ({ add: input.add, remove: input.remove }))).toEqual([
      { add: ['always-load'], remove: undefined },
      { add: undefined, remove: ['always-load'] },
    ])
  })

  it('reserves before a slow provisional read so a later durable unpin stays last', async () => {
    let openTransition!: (created: boolean) => void
    const transition = new Promise<boolean>((resolve) => {
      openTransition = resolve
    })
    let openReadEntered!: () => void
    const readEntered = new Promise<void>((resolve) => {
      openReadEntered = resolve
    })
    let openReadRelease!: () => void
    const readRelease = new Promise<void>((resolve) => {
      openReadRelease = resolve
    })
    const calls: TagMutationInput[] = []
    const store = {
      read: async (id: string) => {
        if (id === 'provisional-overview') {
          openReadEntered()
          await readRelease
        }

        return {
          id: 'durable-overview',
          title: 'Overview',
          class: 'user-doc',
          content: '',
        }
      },
      mutateTags: async (input: TagMutationInput) => {
        calls.push(input)
        return { changed: true, tags: [] }
      },
    }

    const automatic = enqueueConditionalNotePin(store as never, 'provisional-overview', transition)
    await readEntered
    const manual = setNotePinned(store as never, 'durable-overview', false)
    openTransition(true)
    openReadRelease()
    await Promise.all([automatic.completion, manual])

    expect(calls.map((input) => ({ id: input.id, add: input.add, remove: input.remove }))).toEqual([
      { id: 'durable-overview', add: ['always-load'], remove: undefined },
      { id: 'durable-overview', add: undefined, remove: ['always-load'] },
    ])
  })

  it('serializes identity reservation without blocking a different note mutation', async () => {
    let openTransition!: (created: boolean) => void
    const transition = new Promise<boolean>((resolve) => {
      openTransition = resolve
    })
    const calls: string[] = []
    const store = {
      read: async (id: string) => ({ id, title: id, class: 'user-doc', content: '' }),
      mutateTags: async (input: TagMutationInput) => {
        calls.push(input.id)
        return { changed: true, tags: [] }
      },
    }

    const waiting = enqueueConditionalNotePin(store as never, 'waiting', transition)
    await expect(setNotePinned(store as never, 'independent', true)).resolves.toEqual({
      pinned: true,
      changed: true,
    })
    expect(calls).toEqual(['independent'])
    openTransition(false)
    await expect(waiting.completion).resolves.toEqual({ pinned: true, changed: false })
  })

  it('a false transition is a no-op and a failed task does not poison the tail', async () => {
    const calls: TagMutationInput[] = []
    let fail = true
    const store = {
      read: async (id: string) => ({ id, title: 'Overview', class: 'user-doc', content: '' }),
      mutateTags: async (input: TagMutationInput) => {
        calls.push(input)
        if (fail) {
          fail = false
          throw new Error('first failed')
        }

        return { changed: true, tags: [] }
      },
    }

    const conditional = enqueueConditionalNotePin(
      store as never,
      'overview',
      Promise.resolve(false),
    )
    await expect(conditional.completion).resolves.toEqual({ pinned: true, changed: false })
    await expect(setNotePinned(store as never, 'overview', true)).rejects.toThrow('first failed')
    await expect(setNotePinned(store as never, 'overview', false)).resolves.toEqual({
      pinned: false,
      changed: true,
    })
    expect(calls).toHaveLength(2)
  })
})

describe('curatePersonalScope (#208/#209)', () => {
  it('loads everything under budget; muted memory is off the budget but still listed (loaded:false)', async () => {
    const r = await curatePersonalScope(
      [pin('p1', 10), pin('p2', 10)],
      [],
      [mem('m1', 5), mem('m2', 5, true), mem('m3', 5)],
      BIG,
    )
    expect(r.pins.map((p) => p.loaded)).toEqual([true, true])
    expect(r.memory.map((m) => [m.noteId, m.loaded])).toEqual([
      ['m1', true],
      ['m2', false],
      ['m3', true],
    ])
    expect(r.loadedTokens).toBe(30)
  })

  it('pins load FIRST, then memory — the strict prefix trims memory once the budget is spent', async () => {
    // pins 10+10 = 20 fit budget 22; the first memory (5) overflows → memory all trimmed.
    const r = await curatePersonalScope(
      [pin('p1', 10), pin('p2', 10)],
      [],
      [mem('m1', 5), mem('m2', 5, true), mem('m3', 5)],
      22,
    )
    expect(r.pins.map((p) => p.loaded)).toEqual([true, true])
    expect(r.memory.map((m) => [m.noteId, m.loaded])).toEqual([
      ['m1', false],
      ['m2', false],
      ['m3', false],
    ])
    expect(r.loadedTokens).toBe(20)
  })

  it('a pin that overflows trims itself and every later pin AND all memory (priority preserved)', async () => {
    const r = await curatePersonalScope(
      [pin('p1', 10), pin('p2', 10), pin('p3', 10)],
      [],
      [mem('m1', 1)],
      15,
    )
    expect(r.pins.map((p) => p.loaded)).toEqual([true, false, false])
    expect(r.memory.map((m) => m.loaded)).toEqual([false])
    expect(r.loadedTokens).toBe(10)
  })

  it('is a no-op on empty inputs', async () => {
    expect(await curatePersonalScope([], [], [], BIG)).toEqual({
      pins: [],
      sets: [],
      memory: [],
      loadedTokens: 0,
      stopReason: 'exhausted',
    })
  })

  it('SET items load AFTER local pins, BEFORE memory (specific > general)', async () => {
    // chain [p1:10, s.a:10, s.b:10, m1:10] against 25: 10+10=20 fit, +10=30 overflows → 2 loaded.
    const r = await curatePersonalScope(
      [pin('p1', 10)],
      [set('front', ['a', 10], ['b', 10])],
      [mem('m1', 10)],
      25,
    )
    expect(r.pins.map((p) => p.loaded)).toEqual([true])
    expect(r.sets[0].items.map((item) => [item.noteId, item.loaded])).toEqual([
      ['a', true],
      ['b', false],
    ])
    expect(r.memory.map((m) => m.loaded)).toEqual([false])
    expect(r.loadedTokens).toBe(20)
  })

  it('DEDUP: a note pinned AND carried by a set loads once (as the pin), dropped from the set view', async () => {
    const r = await curatePersonalScope(
      [pin('a', 10)],
      [set('front', ['a', 10], ['b', 10])],
      [],
      BIG,
    )
    expect(r.pins.map((p) => p.noteId)).toEqual(['a'])
    // 'a' deduped out of the set; only 'b' survives there.
    expect(r.sets[0].items.map((item) => item.noteId)).toEqual(['b'])
    expect(r.loadedTokens).toBe(20)
  })

  it('keeps a folder-page marker when an ordered set wins pin/set dedup', async () => {
    const markedSet: WeighedSet = {
      id: 'overview-set',
      name: 'Overview set',
      homeSpace: 'sp',
      items: [
        {
          noteId: 'overview',
          title: 'Product',
          tokens: 10,
          space: 'sp',
          folderPage: true,
        },
      ],
    }
    const r = await curatePersonalScope([pin('overview', 10)], [markedSet], [], BIG, [
      { kind: 'set', ref: 'overview-set' },
      { kind: 'pin', ref: 'overview' },
    ])

    expect(r.pins).toEqual([])
    expect(r.sets[0].items).toEqual([
      expect.objectContaining({ noteId: 'overview', folderPage: true }),
    ])
  })

  it('DEDUP across two sets: the same note in set A and set B survives only in A (first wins)', async () => {
    const r = await curatePersonalScope(
      [],
      [set('A', ['x', 5]), set('B', ['x', 5], ['y', 5])],
      [],
      BIG,
    )
    expect(r.sets[0].items.map((item) => item.noteId)).toEqual(['x'])
    expect(r.sets[1].items.map((item) => item.noteId)).toEqual(['y'])
  })

  it('LOOSE cross-space pins ride the pin bucket and keep their `space` on the wire; a plain pin carries none', async () => {
    const r = await curatePersonalScope(
      [pin('local', 10), crossPin('far', 10, 'conventions')],
      [],
      [],
      BIG,
    )
    expect(r.pins.map((p) => p.noteId)).toEqual(['local', 'far'])
    expect(r.pins.find((p) => p.noteId === 'far')?.space).toBe('conventions')
    // A same-space (tag) pin stays space-less — the UI reads that as "no home chip".
    expect(r.pins.find((p) => p.noteId === 'local')?.space).toBeUndefined()
  })

  it('DEDUP: a note both TAG-pinned and CROSS-pinned (or in a set) loads once, first occurrence wins', async () => {
    // Local tag pin 'a' precedes a cross-space pin 'a' and a set carrying 'a' → one load.
    const r = await curatePersonalScope(
      [pin('a', 10), crossPin('a', 10, 'other')],
      [set('s', ['a', 10], ['b', 10])],
      [],
      BIG,
    )
    expect(r.pins.map((p) => p.noteId)).toEqual(['a']) // the tag pin wins (space-less)
    expect(r.pins[0].space).toBeUndefined()
    expect(r.sets[0].items.map((item) => item.noteId)).toEqual(['b'])
  })
})

describe('bounded context-set resolve (#406)', () => {
  it('gives 250- and 1000-ref sets the same exact resolve-cap prefix', async () => {
    const run = async (count: number) => {
      const calls: string[] = []
      let materialized = 0
      const scopeSet = rawSet('same-prefix', count, async (noteId) => {
        calls.push(noteId)
        return { noteId, title: noteId, tokens: 1, spaceSlug: 'sp', filePath: `${noteId}.md` }
      })

      for (const item of scopeSet.items) {
        const noteId = item.noteId

        Object.defineProperty(item, 'noteId', {
          configurable: true,
          get: () => {
            materialized += 1
            return noteId
          },
        })
      }

      return {
        calls,
        materialized: () => materialized,
        result: await curatePersonalScope([], [scopeSet], [], BIG),
      }
    }
    const bounded = await run(250)
    const oversized = await run(1000)

    expect(bounded.calls).toHaveLength(250)
    expect(oversized.calls).toHaveLength(250)
    expect(bounded.materialized()).toBe(250)
    expect(oversized.materialized()).toBe(250)
    expect(oversized.calls).toEqual(bounded.calls)
    expect(bounded.result.stopReason).toBe('resolve-cap')
    expect(oversized.result.stopReason).toBe('resolve-cap')
    expect(bounded.result.sets[0]).toMatchObject({
      itemsLoaded: 250,
      itemsCursor: 250,
      trimmed: true,
    })
    expect(oversized.result.sets[0]).toMatchObject({
      itemsLoaded: 250,
      itemsCursor: 250,
      trimmed: true,
    })
    expect(oversized.result.sets[0].items).toEqual(bounded.result.sets[0].items)
  })

  it('does not resolve a lazy set row after pins already exhausted the item cap', async () => {
    let reads = 0
    const pins = Array.from({ length: SCOPE_ITEM_CAP }, (_, index) => pin(`pin-${index}`, 0))
    const tail = rawSet('tail', 1, async (noteId) => {
      reads += 1
      return { noteId, title: noteId, tokens: 1, spaceSlug: 'sp', filePath: `${noteId}.md` }
    })
    const result = await curatePersonalScope(pins, [tail], [], BIG)

    expect(reads).toBe(0)
    expect(result.stopReason).toBe('item-cap')
    expect(result.sets[0]).toMatchObject({
      items: [],
      itemsLoaded: 0,
      itemsCursor: 0,
      trimmed: true,
    })
  })

  it('resolves exactly one overflow row and blocks later groups', async () => {
    const calls: string[] = []
    const scopeSet = rawSet('heavy', 10, async (noteId) => {
      calls.push(noteId)
      return { noteId, title: noteId, tokens: 10, spaceSlug: 'sp', filePath: `${noteId}.md` }
    })
    const result = await curatePersonalScope([], [scopeSet], [], 25, [
      { kind: 'set', ref: 'heavy' },
    ])

    expect(calls).toHaveLength(3)
    expect(result.stopReason).toBe('budget')
    expect(result.sets[0].items.map((item) => item.loaded)).toEqual([true, true, false])
    expect(result.sets[0]).toMatchObject({ itemsLoaded: 2, itemsCursor: 3, trimmed: true })
  })

  it('caps degraded refs and counts loaded dedup refs honestly', async () => {
    const degraded = await curatePersonalScope(
      [],
      [rawSet('missing', 1000, async () => null)],
      [],
      BIG,
    )
    expect(degraded.stopReason).toBe('resolve-cap')
    expect(degraded.sets[0]).toMatchObject({
      itemsLoaded: 0,
      itemsCursor: 0,
      trimmed: true,
    })

    const duplicate = rawSet('duplicate', 2, async () => ({
      noteId: 'canonical',
      title: 'Canonical',
      tokens: 1,
      spaceSlug: 'sp',
      filePath: 'canonical.md',
    }))
    const complete = await curatePersonalScope([], [duplicate], [], BIG)
    expect(complete.stopReason).toBe('exhausted')
    expect(complete.sets[0]).toMatchObject({
      itemsLoaded: 2,
      itemsTotal: 2,
      itemsCursor: 1,
      trimmed: false,
    })
    expect(complete.sets[0].items).toHaveLength(1)
  })

  it('keeps every more-general layer unloaded after a hard resolve stop', async () => {
    const projectSet = rawSet('project-heavy', 1000, async (noteId) => ({
      noteId,
      title: noteId,
      tokens: 1,
      spaceSlug: 'sp',
      filePath: `${noteId}.md`,
    }))
    const personalSet = rawSet('personal-later', 1, async (noteId) => ({
      noteId,
      title: noteId,
      tokens: 1,
      spaceSlug: 'sp',
      filePath: `${noteId}.md`,
    }))
    const result = await curateProjectScope(
      [],
      [projectSet],
      [pin('personal-pin', 1)],
      [personalSet],
      [mem('personal-memory', 1)],
      BIG,
    )

    expect(result.stopReason).toBe('resolve-cap')
    expect(result.personal.pins[0].loaded).toBe(false)
    expect(result.personal.sets[0]).toMatchObject({
      items: [],
      itemsLoaded: 0,
      itemsCursor: 0,
      trimmed: true,
    })
    expect(result.personal.memory[0].loaded).toBe(false)
  })
})

describe('curateProjectScope (#208/#209)', () => {
  it('project pins load FIRST, then the personal background embeds fully into the remainder', async () => {
    const r = await curateProjectScope(
      [pin('j1', 10)],
      [],
      [pin('p1', 8), pin('p2', 8)],
      [],
      [mem('m1', 4), mem('m2', 4, true)],
      BIG,
    )
    expect(r.pins.map((p) => p.loaded)).toEqual([true])
    expect(r.projectLoadedTokens).toBe(10)
    expect(r.personal.pins.map((p) => p.loaded)).toEqual([true, true])
    expect(r.personal.memory.map((m) => [m.noteId, m.loaded])).toEqual([
      ['m1', true],
      ['m2', false],
    ])
    expect(r.personal.loadedTokens).toBe(20) // 8 + 8 + 4 active memory
    expect(r.loadedTokens).toBe(30)
  })

  it('SQUEEZE: fat project pins take the front of Q → personal embeds only PARTIALLY (loaded:false on the tail)', async () => {
    // chain [j1:10, p1:8, p2:8, m1:4] against 24: 10+8=18 fit, +8=26 overflows → loadedCount 2.
    const r = await curateProjectScope(
      [pin('j1', 10)],
      [],
      [pin('p1', 8), pin('p2', 8)],
      [],
      [mem('m1', 4)],
      24,
    )
    expect(r.projectLoadedTokens).toBe(10)
    expect(r.personal.pins.map((p) => p.loaded)).toEqual([true, false]) // p1 fits, p2 trimmed
    expect(r.personal.memory.map((m) => m.loaded)).toEqual([false]) // memory beyond the break
    expect(r.personal.loadedTokens).toBe(8)
    expect(r.loadedTokens).toBe(18)
  })

  it('the flat loaded[] maps to the RIGHT segment — a personal pin gets its own verdict, not a shifted one', async () => {
    // chain [j1:5, j2:5, p1:5, p2:5, m1:5] against 17: first three fit (15), p2 overflows.
    const r = await curateProjectScope(
      [pin('j1', 5), pin('j2', 5)],
      [],
      [pin('p1', 5), pin('p2', 5)],
      [],
      [mem('m1', 5)],
      17,
    )
    expect(r.pins.map((p) => p.loaded)).toEqual([true, true]) // both project pins
    expect(r.personal.pins.map((p) => p.loaded)).toEqual([true, false]) // p1 (chain idx 2) loaded, p2 (idx 3) trimmed
    expect(r.personal.memory.map((m) => m.loaded)).toEqual([false]) // m1 (chain idx 4) trimmed
    expect(r.projectLoadedTokens).toBe(10)
    expect(r.personal.loadedTokens).toBe(5)
  })

  it('project-DOMINANT: the project pins alone spend Q → the personal background loads nothing', async () => {
    const r = await curateProjectScope([pin('j1', 14)], [], [pin('p1', 8)], [], [mem('m1', 4)], 15)
    expect(r.projectLoadedTokens).toBe(14)
    expect(r.personal.pins.map((p) => p.loaded)).toEqual([false])
    expect(r.personal.memory.map((m) => m.loaded)).toEqual([false])
    expect(r.personal.loadedTokens).toBe(0)
  })

  it('project SETS load after project pins, before personal; project set tokens count as project-loaded', async () => {
    // chain [j1:5, projSet.a:5, p1:5, m1:5] against BIG — all load.
    const r = await curateProjectScope(
      [pin('j1', 5)],
      [set('canon', ['a', 5])],
      [pin('p1', 5)],
      [],
      [mem('m1', 5)],
      BIG,
    )
    expect(r.sets[0].items.map((item) => [item.noteId, item.loaded])).toEqual([['a', true]])
    expect(r.projectLoadedTokens).toBe(10) // j1 (5) + project set a (5)
    expect(r.personal.loadedTokens).toBe(10) // p1 (5) + memory (5)
    expect(r.loadedTokens).toBe(20)
  })

  it('DEDUP: a note in a project pin AND a personal set loads once under the project (project wins)', async () => {
    const r = await curateProjectScope(
      [pin('a', 5)],
      [],
      [],
      [set('mine', ['a', 5], ['b', 5])],
      [],
      BIG,
    )
    expect(r.pins.map((p) => p.noteId)).toEqual(['a'])
    expect(r.personal.sets[0].items.map((item) => item.noteId)).toEqual(['b']) // 'a' deduped to the project pin
  })
})

describe('role-first context curation (#308)', () => {
  it('loads Role → Project → Personal under one budget and deduplicates to the role', async () => {
    const r = await curateProjectScope(
      [pin('shared', 5), pin('project', 5)],
      [],
      [pin('personal', 5)],
      [],
      [mem('memory', 5)],
      16,
      [],
      [],
      { pins: [pin('role', 5), pin('shared', 5)], sets: [] },
    )

    expect(r.role?.pins.map((item) => [item.noteId, item.loaded])).toEqual([
      ['role', true],
      ['shared', true],
    ])
    expect(r.pins.map((item) => [item.noteId, item.loaded])).toEqual([['project', true]])
    expect(r.personal.pins.map((item) => [item.noteId, item.loaded])).toEqual([['personal', false]])
    expect(r.personal.memory.map((item) => [item.noteId, item.loaded])).toEqual([['memory', false]])
    expect(r.loadedTokens).toBe(15)
  })

  it('keeps role order independent and applies a strict prefix', async () => {
    const role = {
      pins: [pin('first', 8), pin('second', 8)],
      sets: [set('role-set', ['set-note', 8])],
      order: [
        { kind: 'set' as const, ref: 'role-set' },
        { kind: 'pin' as const, ref: 'second' },
        { kind: 'pin' as const, ref: 'first' },
      ],
    }
    const combined = await curatePersonalScope([], [], [], 17, [], role)

    expect(combined.role?.sets[0].items[0].loaded).toBe(true)
    expect(combined.role?.pins.map((item) => [item.noteId, item.loaded])).toEqual([
      ['second', true],
      ['first', false],
    ])
  })
})

describe('order overlay (#210)', () => {
  it('default (no overlay): pins keep insertion order, THEN sets — dense 0-based positions', async () => {
    const r = await curatePersonalScope([pin('p1', 5), pin('p2', 5)], [set('s', ['a', 5])], [], BIG)
    expect(r.pins.map((p) => [p.noteId, p.order])).toEqual([
      ['p1', 0],
      ['p2', 1],
    ])
    expect(r.sets[0].order).toBe(2)
  })

  it('a set dragged ABOVE a pin loads first and carries the lower position (pins & sets share one rank space)', async () => {
    const r = await curatePersonalScope([pin('p1', 5)], [set('s', ['a', 5])], [], BIG, [
      { kind: 'set', ref: 's' },
      { kind: 'pin', ref: 'p1' },
    ])
    expect(r.sets[0].order).toBe(0)
    expect(r.pins[0].order).toBe(1)
  })

  it('order = budget PRIORITY: dragging a pin to the top saves it from a squeeze that trims the default-first one', async () => {
    // Two 10-token pins under budget 12 → only the FIRST in the sequence loads.
    const def = await curatePersonalScope([pin('p1', 10), pin('p2', 10)], [], [], 12)
    expect(def.pins.map((p) => [p.noteId, p.loaded])).toEqual([
      ['p1', true],
      ['p2', false],
    ])
    // Drag p2 to the top → p2 now loads, p1 trims. The wire array comes out in the new order.
    const r = await curatePersonalScope([pin('p1', 10), pin('p2', 10)], [], [], 12, [
      { kind: 'pin', ref: 'p2' },
      { kind: 'pin', ref: 'p1' },
    ])
    expect(r.pins.map((p) => [p.noteId, p.loaded, p.order])).toEqual([
      ['p2', true, 0],
      ['p1', false, 1],
    ])
  })

  it('an entry absent from the overlay sorts AFTER the ranked ones, in the default order (self-healing)', async () => {
    // Only p2 is ranked (dragged to front); p1 + the set fall back to their default order behind it.
    const r = await curatePersonalScope(
      [pin('p1', 5), pin('p2', 5)],
      [set('s', ['a', 5])],
      [],
      BIG,
      [{ kind: 'pin', ref: 'p2' }],
    )
    expect(r.pins.map((p) => [p.noteId, p.order])).toEqual([
      ['p2', 0],
      ['p1', 1],
    ])
    expect(r.sets[0].order).toBe(2)
  })

  it('set items carry their within-set index as `order` (a set is one draggable group)', async () => {
    const r = await curatePersonalScope([], [set('s', ['a', 5], ['b', 5], ['c', 5])], [], BIG)
    expect(r.sets[0].items.map((i) => [i.noteId, i.order])).toEqual([
      ['a', 0],
      ['b', 1],
      ['c', 2],
    ])
  })

  it('project & personal blocks are ordered INDEPENDENTLY (each its own overlay, each 0-based)', async () => {
    const r = await curateProjectScope(
      [pin('j1', 5), pin('j2', 5)],
      [],
      [pin('p1', 5), pin('p2', 5)],
      [],
      [],
      BIG,
      [
        { kind: 'pin', ref: 'j2' },
        { kind: 'pin', ref: 'j1' },
      ],
      [
        { kind: 'pin', ref: 'p2' },
        { kind: 'pin', ref: 'p1' },
      ],
    )
    expect(r.pins.map((p) => [p.noteId, p.order])).toEqual([
      ['j2', 0],
      ['j1', 1],
    ])
    expect(r.personal.pins.map((p) => [p.noteId, p.order])).toEqual([
      ['p2', 0],
      ['p1', 1],
    ])
  })
})
