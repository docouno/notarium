import { drainPages } from '../../../../libs/paging'

export type ActivityWindow<P> = {
  pages: P[]
  first: P
  last: P
  depth: number
  nextCursor: string | null
}

export type ActivityContinuation<P> = {
  page: P
  nextCursor: string | null
}

/** Stable keyset pages may overlap at a source boundary. Keep the first (newest)
 * occurrence so a bounded reread never renders duplicates or lets an older page
 * replace the projection already supplied by a newer one. */
export const flattenActivityWindow = <P, I>(
  pages: readonly P[],
  itemsOf: (page: P) => readonly I[],
  keyOf: (item: I) => string,
): I[] => {
  const seen = new Set<string>()
  const items: I[] = []

  for (const page of pages) {
    for (const item of itemsOf(page)) {
      const key = keyOf(item)

      if (!seen.has(key)) {
        seen.add(key)
        items.push(item)
      }
    }
  }

  return items
}

/** Rebuild a bounded cursor window from page one. Nothing is exposed until the
 * requested depth has landed, so a failed or superseded read cannot partially
 * replace the snapshot the user is still looking at. */
export const collectActivityWindow = async <P>(
  read: (cursor?: string) => Promise<P>,
  {
    requestedDepth,
    cursorOf,
    current = () => true,
  }: {
    requestedDepth: number
    cursorOf: (page: P) => string | null | undefined
    current?: () => boolean
  },
): Promise<ActivityWindow<P> | null> => {
  const wanted = Math.max(1, Math.floor(requestedDepth))
  const first = (await read()) as P

  if (!current()) {
    return null
  }
  const pages: P[] = [first]
  const drained = await drainPages((cursor) => read(cursor), {
    from: cursorOf(first),
    pages: wanted - 1,
    cursorOf,
    onPage: (page) => {
      if (!current()) {
        return false
      }
      pages.push(page)
    },
  })

  if (drained.stopped || !current()) {
    return null
  }

  return {
    pages,
    first,
    last: pages[pages.length - 1],
    depth: pages.length,
    nextCursor: drained.nextCursor,
  }
}

/** Fetch exactly the committed window's terminal continuation. A live revision
 * may supersede this read and rebuild the requested depth from page one, but an
 * uncontended Load older must not reread pages the user already has. */
export const continueActivityWindow = async <P>(
  read: (cursor: string) => Promise<P>,
  {
    cursor,
    cursorOf,
    current = () => true,
  }: {
    cursor: string
    cursorOf: (page: P) => string | null | undefined
    current?: () => boolean
  },
): Promise<ActivityContinuation<P> | null> => {
  const page = await read(cursor)

  if (!current()) {
    return null
  }
  const nextCursor = cursorOf(page) ?? null

  return { page, nextCursor: nextCursor === cursor ? null : nextCursor }
}
