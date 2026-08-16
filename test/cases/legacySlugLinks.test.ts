import { describe, expect, it } from 'vitest'
import { deterministicNoteId, InMemoryStore } from '@notarium/engine-memory'

import { buildCaseWorld, DEFAULT_NOW } from './build'
import { caseToFixture } from './toFixture'

describe('legacy-slug-links seed case', () => {
  it('keeps the initial identity and evidence after path edits, delete and restore', () => {
    const fixture = caseToFixture(buildCaseWorld('legacy-slug-links', { now: DEFAULT_NOW }))
    const main = fixture.spaces.find(({ slug }) => slug === 'main')!
    const unique = main.notes.find(({ title }) => title === 'Қазақстан жоспары')!

    expect(unique).toMatchObject({
      id: deterministicNoteId('old/aza-stan-zhospary.md'),
      filePath: 'current/қazaқstan-zhospary.md',
      legacyNameAliases: ['aza-stan-zhospary'],
    })
    expect(
      main.activity?.filter(({ noteId }) => noteId === unique.id).map(({ kind }) => kind),
    ).toEqual(['created', 'edited', 'deleted', 'restored'])
    expect(main.notes.filter(({ filePath }) => filePath.endsWith('/a-b.md'))).toEqual([])
    expect(
      main.notes
        .filter(({ title }) => title === 'AҚB' || title === 'AҒB')
        .map(({ legacyNameAliases }) => legacyNameAliases),
    ).toEqual([['a-b'], ['a-b']])
  })

  it('projects the unique link and leaves the multi-owner claim as a ghost', async () => {
    const fixture = caseToFixture(buildCaseWorld('legacy-slug-links', { now: DEFAULT_NOW }))
    const main = fixture.spaces.find(({ slug }) => slug === 'main')!
    const store = new InMemoryStore({ space: 'main', notes: main.notes })
    const unique = main.notes.find(({ title }) => title === 'Қазақстан жоспары')!
    const source = main.notes.find(({ title }) => title === 'Legacy link source')!

    expect((await store.read('aza-stan-zhospary')).id).toBe(unique.id)
    await expect(store.read('a-b')).rejects.toMatchObject({ isNotFound: true })
    const graph = await store.graph()

    expect(graph.links).toContainEqual(
      expect.objectContaining({ source: source.id, target: unique.id }),
    )
    expect(
      graph.links.some(
        ({ source: sourceId, target }) =>
          sourceId === source.id &&
          main.notes
            .filter(({ title }) => title === 'AҚB' || title === 'AҒB')
            .some(({ id }) => id === target),
      ),
    ).toBe(false)
    expect(graph.nodes).toContainEqual(expect.objectContaining({ ghost: true, target: 'a-b' }))
  })
})
