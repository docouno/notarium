import type { NoteView } from '../../../../../../libs/wire'

export type FeedWindowRequest = { queryKey: string; revision: number }

/** A query can stay textually identical while an SSE change makes its held
 * window obsolete. Both axes must still match before a response may land. */
export const isCurrentFeedWindow = (
  request: FeedWindowRequest,
  queryKey: string,
  revision: number,
): boolean => request.queryKey === queryKey && request.revision === revision

/** Pages whose invalidated requests must be restarted after the coalescing
 * window. Page zero is the liveness floor: before the first response there are
 * no held pages yet, but invalidating that request must not strand the Feed on
 * its loading skeleton. */
export const invalidatedFeedPages = (
  pages: ReadonlyMap<number, readonly NoteView[]>,
  inFlight: ReadonlySet<number>,
): Set<number> => {
  const pending = new Set([...pages.keys(), ...inFlight])

  if (!pending.size) {
    pending.add(0)
  }

  return pending
}

/** Coalesced refresh consumes every page invalidated by an event plus pages
 * learned while its timer was waiting. Kept as one transition so the empty
 * first-window interleaving is executable without a React timer harness. */
export const feedPagesToRefresh = (
  pending: ReadonlySet<number>,
  pages: ReadonlyMap<number, readonly NoteView[]>,
): number[] => [...new Set([...pending, ...pages.keys()])]

/** Remove server-deleted rows immediately, before the coalesced replacement
 * window arrives. */
export const filterRemovedFeedRows = (
  pages: ReadonlyMap<number, readonly NoteView[]>,
  removedIds: readonly string[],
): Map<number, NoteView[]> => {
  const removed = new Set(removedIds)
  const next = new Map<number, NoteView[]>()

  for (const [page, notes] of pages) {
    next.set(
      page,
      notes.filter((note) => !removed.has(note.id)),
    )
  }

  return next
}
