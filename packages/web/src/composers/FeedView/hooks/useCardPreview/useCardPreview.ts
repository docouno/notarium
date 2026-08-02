import { useRef } from 'react'
import { noteRoute } from '../../../../libs/routing/routePaths'
import type { NoteView } from '../../../../libs/wire'
import { useInView, usePreview } from '../../../../services/previews'

// Lazily resolve a note's preview (snippet + tags + first image) once it scrolls
// into view, shared by the grid card and the timeline row. Warm previews arrive
// with the notes window itself (primed by useFeedState); cold ones resolve via
// the shared viewport batches (services/previews).
export const useCardPreview = (note: NoteView) => {
  const ref = useRef<HTMLAnchorElement>(null)
  const inView = useInView(ref)
  const meta = usePreview(note.id, inView)
  return {
    ref,
    meta,
    // `meta` is null until the lazy fetch resolves (it resolves even on error,
    // so this never sticks). Drives the loading skeleton.
    loading: !meta,
    href: noteRoute(note.id),
    tags: meta?.tags || [],
  }
}
