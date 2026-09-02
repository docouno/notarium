import { describe, expect, it } from 'vitest'
import {
  collectActivityWindow,
  continueActivityWindow,
  flattenActivityWindow,
} from './activityWindow'

type Page = { items: string[]; nextCursor: string | null }

const pageReader = (pages: Record<string, Page>) => {
  const asked: Array<string | undefined> = []

  const read = async (cursor?: string): Promise<Page> => {
    asked.push(cursor)
    return pages[cursor ?? 'first'] ?? { items: [], nextCursor: null }
  }

  return { asked, read }
}

describe('the Activity page window', () => {
  it('keeps the newest occurrence when adjacent pages overlap', () => {
    const items = flattenActivityWindow(
      [{ items: ['new', 'boundary'] }, { items: ['boundary', 'old'] }],
      (page) => page.items,
      (item) => item,
    )

    expect(items).toEqual(['new', 'boundary', 'old'])
  })

  it('reads one page without following its continuation', async () => {
    const { asked, read } = pageReader({
      first: { items: ['new'], nextCursor: 'c1' },
      c1: { items: ['old'], nextCursor: null },
    })

    const window = await collectActivityWindow(read, {
      requestedDepth: 1,
      cursorOf: (page) => page.nextCursor,
    })

    expect(asked).toEqual([undefined])
    expect(window?.pages.flatMap((page) => page.items)).toEqual(['new'])
    expect(window?.depth).toBe(1)
    expect(window?.nextCursor).toBe('c1')
  })

  it('atomically rebuilds the requested depth from the new first page', async () => {
    const { asked, read } = pageReader({
      first: { items: ['prepended'], nextCursor: 'fresh-2' },
      'fresh-2': { items: ['middle'], nextCursor: 'fresh-3' },
      'fresh-3': { items: ['new-bottom'], nextCursor: 'fresh-4' },
    })

    const window = await collectActivityWindow(read, {
      requestedDepth: 3,
      cursorOf: (page) => page.nextCursor,
    })

    expect(asked).toEqual([undefined, 'fresh-2', 'fresh-3'])
    expect(window?.pages.flatMap((page) => page.items)).toEqual([
      'prepended',
      'middle',
      'new-bottom',
    ])
    expect(window?.depth).toBe(3)
    expect(window?.nextCursor).toBe('fresh-4')
  })

  it('reaches depth ten with one initial read and nine terminal continuations', async () => {
    const asked: string[] = []

    const read = async (cursor?: string): Promise<Page> => {
      const currentDepth = cursor == null ? 1 : Number(cursor.slice(1))
      asked.push(cursor ?? 'first')
      return {
        items: [`page-${currentDepth}`],
        nextCursor: currentDepth < 10 ? `c${currentDepth + 1}` : null,
      }
    }
    const first = await collectActivityWindow(read, {
      requestedDepth: 1,
      cursorOf: (page) => page.nextCursor,
    })
    expect(first).not.toBeNull()
    let cursor = first!.nextCursor

    while (cursor) {
      const continuation = await continueActivityWindow(read, {
        cursor,
        cursorOf: (page) => page.nextCursor,
      })
      expect(continuation).not.toBeNull()
      cursor = continuation!.nextCursor
    }

    expect(asked).toEqual(['first', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9', 'c10'])
  })

  it('rejects a stale continuation and bounds a repeated terminal cursor', async () => {
    let current = false
    const stale = await continueActivityWindow(
      async () => ({ items: ['old'], nextCursor: 'next' }),
      { cursor: 'cursor', cursorOf: (page) => page.nextCursor, current: () => current },
    )
    expect(stale).toBeNull()

    current = true
    const repeated = await continueActivityWindow(
      async () => ({ items: ['last'], nextCursor: 'cursor' }),
      { cursor: 'cursor', cursorOf: (page) => page.nextCursor, current: () => current },
    )
    expect(repeated?.nextCursor).toBeNull()
  })

  it('reports the effective depth and terminal continuation after early exhaustion', async () => {
    const { read } = pageReader({
      first: { items: ['a'], nextCursor: 'c1' },
      c1: { items: ['b'], nextCursor: null },
    })

    const window = await collectActivityWindow(read, {
      requestedDepth: 8,
      cursorOf: (page) => page.nextCursor,
    })

    expect(window?.depth).toBe(2)
    expect(window?.last.items).toEqual(['b'])
    expect(window?.nextCursor).toBeNull()
  })

  it('bounds a repeated cursor and exposes no continuation that would loop', async () => {
    const { asked, read } = pageReader({
      first: { items: ['a'], nextCursor: 'same' },
      same: { items: ['b'], nextCursor: 'same' },
    })

    const window = await collectActivityWindow(read, {
      requestedDepth: 20,
      cursorOf: (page) => page.nextCursor,
    })

    expect(asked).toEqual([undefined, 'same'])
    expect(window?.depth).toBe(2)
    expect(window?.nextCursor).toBeNull()
  })

  it('returns no partial window when a newer generation supersedes the drain', async () => {
    let fresh = true
    const { read } = pageReader({
      first: { items: ['a'], nextCursor: 'c1' },
      c1: { items: ['b'], nextCursor: 'c2' },
    })

    const window = await collectActivityWindow(
      async (cursor) => {
        const page = await read(cursor)

        if (cursor === 'c1') {
          fresh = false
        }

        return page
      },
      {
        requestedDepth: 3,
        cursorOf: (page) => page.nextCursor,
        current: () => fresh,
      },
    )

    expect(window).toBeNull()
  })

  it('rejects an intermediate failure instead of returning the pages already read', async () => {
    const { read } = pageReader({ first: { items: ['a'], nextCursor: 'broken' } })

    await expect(
      collectActivityWindow(
        async (cursor) => {
          if (cursor === 'broken') {
            throw new Error('page failed')
          }

          return read(cursor)
        },
        { requestedDepth: 2, cursorOf: (page) => page.nextCursor },
      ),
    ).rejects.toThrow('page failed')
  })
})
