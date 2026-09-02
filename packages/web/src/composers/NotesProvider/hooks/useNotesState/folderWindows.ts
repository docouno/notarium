import type { NoteView } from '../../../../libs/wire'

type MembershipPatch = {
  remove: Array<{ folder: string; id: string }>
  upsert: Array<{ folder: string; id: string }>
}

/** Publish one authoritative folder window while keeping stable note identities
 * unique across every held window. The reverse membership index bounds work to
 * the replaced window and actual relocation sources; unchanged sibling arrays
 * retain their identity so the checkpoint adds no avoidable row allocation. */
export const replaceFolderWindow = (
  windows: ReadonlyMap<string, NoteView[]>,
  membership: ReadonlyMap<string, string>,
  folder: string,
  current: NoteView[],
): { membership: MembershipPatch; windows: Map<string, NoteView[]> } => {
  const next = new Map(windows)
  const currentIds = new Set(current.map((note) => note.id))
  const patch: MembershipPatch = { remove: [], upsert: [] }
  const pruneByFolder = new Map<string, Set<string>>()

  for (const previous of windows.get(folder) ?? []) {
    if (!currentIds.has(previous.id) && membership.get(previous.id) === folder) {
      patch.remove.push({ folder, id: previous.id })
    }
  }
  for (const note of current) {
    const previousFolder = membership.get(note.id)

    if (previousFolder !== undefined && previousFolder !== folder) {
      const ids = pruneByFolder.get(previousFolder) ?? new Set<string>()

      ids.add(note.id)
      pruneByFolder.set(previousFolder, ids)
    }
    patch.upsert.push({ folder, id: note.id })
  }
  for (const [path, ids] of pruneByFolder) {
    const notes = windows.get(path)

    if (!notes) {
      continue
    }
    let filtered: NoteView[] | null = null

    for (let index = 0; index < notes.length; index += 1) {
      const note = notes[index]

      if (ids.has(note.id)) {
        filtered ??= notes.slice(0, index)
      } else {
        filtered?.push(note)
      }
    }
    if (filtered) {
      next.set(path, filtered)
    }
  }
  next.set(folder, current)
  return { membership: patch, windows: next }
}
