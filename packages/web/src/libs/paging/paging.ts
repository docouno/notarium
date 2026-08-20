/** Continue a cursor: read up to `pages` MORE pages after the one already in hand.
 *  A drain needs a floor — a server answering with an UNCHANGED cursor (a bug, a proxy
 *  replaying a response) would otherwise spin the caller until the tab dies, so both
 *  the page cap and the repeat check turn that into a truncated list instead of a hang. */
export const drainPages = async <P>(
  read: (cursor: string) => Promise<P>,
  {
    from,
    pages,
    cursorOf,
    onPage,
  }: {
    /** The cursor the page already in hand answered with. */
    from: string | null | undefined
    /** How many more pages this drain may read. */
    pages: number
    cursorOf: (page: P) => string | null | undefined
    /** Each landed page, in order; returning false stops the drain (a stale request). */
    onPage?: (page: P) => boolean | void
  },
): Promise<{ read: number; nextCursor: string | null; stopped: boolean }> => {
  let cursor = from ?? null
  let count = 0

  while (cursor && count < pages) {
    const page = await read(cursor)
    count += 1

    if (onPage?.(page) === false) {
      return { read: count, nextCursor: cursor, stopped: true }
    }
    const next = cursorOf(page) ?? null
    cursor = next === cursor ? null : next
  }

  return { read: count, nextCursor: cursor, stopped: false }
}
