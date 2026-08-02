import { useFeed } from '../../composers/FeedProvider'
import { FeedView } from '../../composers/FeedView'
import { useNotes } from '../../composers/NotesProvider'

// `/feed` — the documents feed. State lives in FeedProvider so the aside facets
// (rendered by DocumentLayout) share the same instance.
export const FeedPage = () => {
  const feed = useFeed()
  const { openNote } = useNotes()
  return <FeedView feed={feed} onOpen={openNote} />
}
