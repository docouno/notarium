import type { NoteView } from '../../../../libs/wire'

/** A live detail/list observation may publish only if it started after the last
 * authoritative removal. A deleted detail is renderable only while no newer
 * truth epoch has superseded the request that observed its tombstone. */
export const isSeenObservationAccepted = (
  id: string,
  deleted: boolean,
  removedAt: ReadonlyMap<string, number>,
  observedAt: number,
  currentEpoch = observedAt,
): boolean => {
  if (deleted) {
    // A deleted response started after removal is renderable, but a later
    // upsert/reconnect may already have restored the id. Any intervening truth
    // epoch makes the tombstone stale and forces one authoritative retry.
    return observedAt === currentEpoch
  }
  const removalEpoch = removedAt.get(id)

  return removalEpoch === undefined || removalEpoch < observedAt
}

/** Apply authoritative stable-id removals from the shared change stream. */
export const removeSeenIds = (
  seen: ReadonlyMap<string, NoteView>,
  ids: readonly string[],
): Map<string, NoteView> => {
  const next = new Map(seen)

  for (const id of ids) {
    next.delete(id)
  }

  return next
}

/** Merge observations without resurrecting identities an authoritative change
 * event removed. `replaces` atomically evicts a provisional/requested id when a
 * detail response canonicalises it to another id. */
export const rememberSeenNotes = (
  seen: ReadonlyMap<string, NoteView>,
  notes: readonly NoteView[],
  removedAt: ReadonlyMap<string, number>,
  replaces: readonly string[] = [],
  observedAt = 0,
): { seen: Map<string, NoteView>; accepted: NoteView[] } => {
  const next = new Map(seen)
  const accepted: NoteView[] = []

  for (const id of replaces) {
    next.delete(id)
  }
  for (const note of notes) {
    if (!note.id) {
      continue
    }
    // Older observations may have started before the removal frame. A response
    // started after an upsert or reconnect has a newer truth epoch and can
    // reconcile the identity; the barrier stays so late old responses stay out.
    if (!isSeenObservationAccepted(note.id, false, removedAt, observedAt)) {
      continue
    }
    next.set(note.id, note)
    accepted.push(note)
  }

  return { seen: next, accepted }
}

/** Replace one authoritative folder window in the cross-window resolution
 * registry. Only rows previously learned from this folder are candidates for
 * eviction. If another operation already moved or renamed one of them, its
 * filePath no longer matches the stale row and that fresher observation wins. */
export const replaceSeenFolder = (
  seen: ReadonlyMap<string, NoteView>,
  previous: readonly NoteView[],
  current: readonly NoteView[],
): Map<string, NoteView> => {
  const next = new Map(seen)
  const currentIds = new Set(current.map((note) => note.id))

  for (const stale of previous) {
    if (!currentIds.has(stale.id) && next.get(stale.id)?.filePath === stale.filePath) {
      next.delete(stale.id)
    }
  }
  for (const note of current) {
    if (note.id) {
      next.set(note.id, note)
    }
  }

  return next
}
