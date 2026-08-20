import { describe, expect, it } from 'vitest'
import { drainPages } from './paging'

type Page = { items: string[]; nextCursor: string | null }

const server = (pages: Record<string, Page>) => {
  const asked: string[] = []

  return {
    asked,
    read: async (cursor: string): Promise<Page> => {
      asked.push(cursor)
      return pages[cursor] ?? { items: [], nextCursor: null }
    },
  }
}

describe('cursor drain', () => {
  it('reads to the end of the cursor chain', async () => {
    const seen: string[] = []
    const { asked, read } = server({
      c1: { items: ['b'], nextCursor: 'c2' },
      c2: { items: ['c'], nextCursor: null },
    })
    const drained = await drainPages(read, {
      from: 'c1',
      pages: 10,
      cursorOf: (page) => page.nextCursor,
      onPage: (page) => {
        seen.push(...page.items)
      },
    })

    expect(asked).toEqual(['c1', 'c2'])
    expect(seen).toEqual(['b', 'c'])
    expect(drained).toEqual({ read: 2, nextCursor: null, stopped: false })
  })

  it('stops on a cursor the server did not move — a repeat is not a page', async () => {
    const { asked, read } = server({ c1: { items: ['b'], nextCursor: 'c1' } })
    const drained = await drainPages(read, {
      from: 'c1',
      pages: 1000,
      cursorOf: (page) => page.nextCursor,
    })

    expect(asked).toEqual(['c1'])
    expect(drained).toEqual({ read: 1, nextCursor: null, stopped: false })
  })

  it('honours the page cap and reports where it stopped', async () => {
    const { asked, read } = server({
      c1: { items: [], nextCursor: 'c2' },
      c2: { items: [], nextCursor: 'c3' },
    })
    const drained = await drainPages(read, {
      from: 'c1',
      pages: 2,
      cursorOf: (page) => page.nextCursor,
    })

    expect(asked).toEqual(['c1', 'c2'])
    expect(drained).toEqual({ read: 2, nextCursor: 'c3', stopped: false })
  })

  it('reads nothing without a cursor to continue from', async () => {
    const { asked, read } = server({})
    expect(
      await drainPages(read, { from: null, pages: 5, cursorOf: (page) => page.nextCursor }),
    ).toEqual({ read: 0, nextCursor: null, stopped: false })
    expect(asked).toEqual([])
  })

  it('abandons the drain when the caller says its request went stale', async () => {
    const { asked, read } = server({
      c1: { items: [], nextCursor: 'c2' },
      c2: { items: [], nextCursor: 'c3' },
    })
    const drained = await drainPages(read, {
      from: 'c1',
      pages: 10,
      cursorOf: (page) => page.nextCursor,
      onPage: () => false,
    })

    expect(asked).toEqual(['c1'])
    expect(drained.stopped).toBe(true)
  })
})
