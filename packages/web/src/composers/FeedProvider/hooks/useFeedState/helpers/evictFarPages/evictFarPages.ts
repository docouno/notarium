import type { NoteView } from '../../../../../../libs/wire'
import { MAX_PAGES } from '../../../../consts'

/** Drop the page farthest from `anchor` (mutating `pages`) until the window
 *  cache is back within MAX_PAGES — the freshest page always survives. */
export const evictFarPages = (pages: Map<number, NoteView[]>, anchor: number): void => {
  while (pages.size > MAX_PAGES) {
    let evict = anchor
    let dist = -1

    for (const k of pages.keys()) {
      const d = Math.abs(k - anchor)

      if (d > dist) {
        dist = d
        evict = k
      }
    }
    pages.delete(evict)
  }
}
