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

/** Reorder a set's items to a note-id sequence (client mirror of the server's `orderItems`):
 *  named ids first, any unnamed current item appended (an optimistic reorder never drops one). */
export const orderItemsBy = <T extends { noteId: string }>(
  items: readonly T[],
  noteIds: readonly string[],
): T[] => {
  const byId = new Map(items.map((it) => [it.noteId, it]))
  const seen = new Set<string>()
  const out: T[] = []

  for (const id of noteIds) {
    const it = byId.get(id)

    if (it && !seen.has(id)) {
      out.push(it)
      seen.add(id)
    }
  }
  for (const it of items) {
    if (!seen.has(it.noteId)) {
      out.push(it)
    }
  }

  return out
}

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
