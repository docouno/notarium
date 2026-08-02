import { folderShown } from '../../../../../../libs/tree/tree'

/** Does any changed id (upserted/removed) fall under the selected-folder scope?
 *  The "does this SSE change concern me" filter for the current inclusion set. */
export const changeTouchesSelection = (
  selected: ReadonlySet<string>,
  ids: string[],
  dirOfId: (id: string) => string | null,
): boolean =>
  ids.some((id) => {
    const dir = dirOfId(id)

    // null = an id the session can't place — assume it may be visible.
    if (dir === null) {
      return true
    }

    return folderShown(selected, dir)
  })
