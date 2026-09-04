// Renaming a space is a sequence, not one write: the config-pinned guard, the registry
// row with its alias history and marker heal, the in-memory slug index and the SSE
// `rename` nudge. Skip any step and the process lies until a restart. One operation
// serves both the manual PATCH and the personal space that follows its owner's
// handle. canon: docs/spaces.md#model

import type { SpacesPersistence } from '../metaDb'
import type { MarkerStore } from '../projects/markerStore'
import { recordSpaceRename, type RenameSpaceResult } from '../projects/spaceIdentity'
import type { SpaceManager } from './spaceManager'

export type RenameSpaceDeps = {
  spaces: Pick<SpaceManager, 'isConfigPinned' | 'applyRename'>
  spacesPersistence: SpacesPersistence
  markerStore?: MarkerStore
  /** SSE `rename` to every live viewer of the space, so tabs follow the new slug. */
  notifyRenamed: (id: string) => void
  now?: () => Date
}

export type RenameSpaceOutcome = RenameSpaceResult | { code: 'config_pinned' }

/** The unique key on `spaces.slug` is the arbiter under the race the pre-check in
 *  recordSpaceRename cannot see — two writers claiming one slug at once, which a
 *  handle-derived slug makes likely. Either dialect's violation is the collision. */
const isSlugTaken = (err: unknown): boolean => {
  const e = err as { code?: string; constraint?: string; message?: string }

  return (
    (e.code === '23505' && (e.constraint ?? '').includes('slug')) ||
    /UNIQUE constraint failed: spaces\.slug/.test(e.message ?? String(err))
  )
}

export const renameSpace = async (
  deps: RenameSpaceDeps,
  input: { id: string; slug?: string; displayName?: string },
): Promise<RenameSpaceOutcome> => {
  // A config-pinned space (env-frozen slug) would be re-asserted at boot: refuse.
  if (input.slug !== undefined && deps.spaces.isConfigPinned(input.id)) {
    return { code: 'config_pinned' }
  }
  let result: RenameSpaceResult

  try {
    result = await recordSpaceRename(
      {
        spaces: deps.spacesPersistence,
        markerStore: deps.markerStore,
        now: deps.now ?? (() => new Date()),
      },
      input,
    )
  } catch (err) {
    if (isSlugTaken(err)) {
      return { code: 'collision' }
    }
    throw err
  }
  if (result.code !== 'ok') {
    return result
  }
  // Re-key the in-memory slug→id index so the new slug resolves at once; the store and
  // engine are untouched (the id and notes_dir never changed).
  deps.spaces.applyRename(result.record)
  deps.notifyRenamed(input.id)

  return result
}
