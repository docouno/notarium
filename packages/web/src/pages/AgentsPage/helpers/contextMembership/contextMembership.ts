type SetIds = string | ReadonlySet<string>
export type ContextMembershipIndex = ReadonlyMap<string, SetIds>

type SetMembership = {
  id: string
  items: readonly { noteId: string }[]
}

/** Index only rows the Context surface currently displays/caches. Raw manager
 * membership can be arbitrarily larger and must never be copied on the main thread. */
export const buildContextMembershipIndex = (
  sets: readonly SetMembership[],
): ContextMembershipIndex => {
  const mutable = new Map<string, string | Set<string>>()

  for (const set of sets) {
    for (const item of set.items) {
      const memberships = mutable.get(item.noteId)

      if (!memberships) {
        // The overwhelmingly common case pays no per-note Set/array allocation.
        mutable.set(item.noteId, set.id)
      } else if (typeof memberships === 'string') {
        if (memberships !== set.id) {
          mutable.set(item.noteId, new Set([memberships, set.id]))
        }
      } else {
        memberships.add(set.id)
      }
    }
  }

  return mutable
}

export const contextSetIdsForNotes = (
  index: ContextMembershipIndex,
  noteIds: Iterable<string>,
  candidates?: ReadonlySet<string>,
): Set<string> => {
  const result = new Set<string>()

  for (const noteId of noteIds) {
    const memberships = index.get(noteId)

    if (!memberships) {
      continue
    } else if (typeof memberships === 'string') {
      if (!candidates || candidates.has(memberships)) {
        result.add(memberships)
      }
    } else if (candidates && candidates.size < memberships.size) {
      candidates.forEach((setId) => {
        if (memberships.has(setId)) {
          result.add(setId)
        }
      })
    } else {
      memberships?.forEach((setId) => {
        if (!candidates || candidates.has(setId)) {
          result.add(setId)
        }
      })
    }
  }

  return result
}

export const contextMembershipHasAny = (
  index: ContextMembershipIndex,
  noteIds: Iterable<string>,
): boolean => {
  for (const noteId of noteIds) {
    if (index.has(noteId)) {
      return true
    }
  }

  return false
}
