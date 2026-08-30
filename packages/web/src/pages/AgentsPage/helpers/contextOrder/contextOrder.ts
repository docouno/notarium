import type { ContextOrderEntry } from '@notarium/contract'

/** The stable reorder key of a context entry (#210) — matches the server's order-overlay
 *  ref: a pin by its note id, a set by its id. Ids are [A-Za-z0-9_-] (no colon), so the
 *  `kind:ref` split is unambiguous. */
export const pinKey = (noteId: string) => `pin:${noteId}`
export const setKey = (setId: string) => `set:${setId}`

export const parseEntryKey = (key: string): ContextOrderEntry => {
  const i = key.indexOf(':')
  return { kind: key.slice(0, i) as 'pin' | 'set', ref: key.slice(i + 1) }
}

/** Reorder the named subset exactly like the server's slot-preserving `orderItems`:
 * unnamed current items keep their slots while named slots refill in request order. */
export const orderItemsBy = <T extends { noteId: string }>(
  items: readonly T[],
  noteIds: readonly string[],
): T[] => {
  const byId = new Map(items.map((it) => [it.noteId, it]))
  const seen = new Set<string>()
  const queue: T[] = []

  for (const id of noteIds) {
    const it = byId.get(id)

    if (it && !seen.has(id)) {
      queue.push(it)
      seen.add(id)
    }
  }
  let index = 0

  return items.map((item) => (seen.has(item.noteId) ? queue[index++] : item))
}

/** Apply a set's new ITEM order to every copy of that set in a scope's list (#210). A set
 *  is shared across the scopes it attaches to, so the same drag lands on several lists —
 *  and those lists no longer have one row shape: a scope preview weighs its items, the
 *  role's own layer does not (#309). Generic over the row so the rule stays written once. */
export const orderSetItemsIn = <I extends { noteId: string }, S extends { id: string; items: I[] }>(
  sets: S[],
  setId: string,
  noteIds: readonly string[],
): S[] => sets.map((s) => (s.id === setId ? { ...s, items: orderItemsBy(s.items, noteIds) } : s))

/** Optimistically stamp pins + sets with the `order` implied by a new entry sequence (#210),
 *  so the merged list re-sorts instantly on drop instead of snapping back until the reload. */
export const reRankByEntries = <
  P extends { noteId: string; order: number },
  S extends { id: string; order: number },
>(
  pins: P[],
  sets: S[],
  entries: ContextOrderEntry[],
): { pins: P[]; sets: S[] } => {
  const rank = new Map(entries.map((e, i) => [`${e.kind}:${e.ref}`, i]))
  return {
    pins: pins.map((p) => ({ ...p, order: rank.get(pinKey(p.noteId)) ?? p.order })),
    sets: sets.map((s) => ({ ...s, order: rank.get(setKey(s.id)) ?? s.order })),
  }
}
