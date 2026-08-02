import type {
  NoteDetail as WireNoteDetail,
  SearchResult as WireSearchResult,
} from '@notarium/contract'
import { noteDetailView, searchResultView } from '../../libs/wire'
import { req, sp } from './client'

export const searchApi = {
  /** The wiki-link resolver channel (#16): a storage key (path/title) resolved
   *  WITHIN the space — reference resolution never crosses the boundary. The
   *  optional signal lets a superseded open abort its in-flight resolve (#68). */
  noteResolve: (space: string, ref: string, signal?: AbortSignal) =>
    req<WireNoteDetail>(`${sp(space)}/note?ref=${encodeURIComponent(ref)}`, { signal }).then(
      noteDetailView,
    ),
  /** Hybrid search (#81). The optional signal lets a superseded keystroke abort
   *  its in-flight request so out-of-order answers never clobber the live query
   *  (the Spotlight debounces into this, #31). */
  searchGet: (space: string, q: string, signal?: AbortSignal) =>
    req<{ results: WireSearchResult[] }>(`${sp(space)}/search?q=${encodeURIComponent(q)}`, {
      signal,
    }).then((d) => d.results.map(searchResultView)),
}
