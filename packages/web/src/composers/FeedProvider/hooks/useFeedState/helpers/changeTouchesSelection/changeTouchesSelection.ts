import { folderShown } from '../../../../../../libs/tree/tree'

/** Tests cached old and server-truth current locations. Optional `folders`
 *  tolerates raw legacy SSE frames. @see docs/feed-page.md#data-flow */
export const changeTouchesSelection = (
  selected: ReadonlySet<string>,
  ids: string[],
  dirOfId: (id: string) => string | null,
  folders?: readonly string[],
): boolean =>
  ids.some((id) => {
    const dir = dirOfId(id)

    // null = an id the session can't place — assume it may be visible.
    return dir === null || folderShown(selected, dir)
  }) || (folders ?? []).some((dir) => folderShown(selected, dir))
