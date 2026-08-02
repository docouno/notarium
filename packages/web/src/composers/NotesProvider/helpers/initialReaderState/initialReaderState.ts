import { parseAppPath } from '../../../../libs/routing/routePaths'
import type { NavScope, ReaderMode } from '../../types'

/** The reader/scope state the URL implies, computed synchronously at mount so the
 *  FIRST paint already matches the destination — a /n/<id> reload shows the note
 *  skeleton immediately, never a flash of the home Splash. The boot used to render
 *  the empty default and only load the real target in an effect; seeding from the
 *  URL (which we always have synchronously) removes that flash (#65 no-flicker).
 *  The fetch still happens in the boot effect — this only shapes the shell. */
export const initialReaderState = (
  pathname: string,
): {
  mode: ReaderMode
  activeId: string | null
  loading: boolean
  nav: NavScope
} => {
  const r = parseAppPath(pathname)

  if (r.kind === 'note' || r.kind === 'memoryNote') {
    return { mode: 'read', activeId: r.id, loading: true, nav: { type: 'folder', folder: '' } }
  }
  if (r.kind === 'feed') {
    return { mode: 'empty', activeId: null, loading: false, nav: { type: 'feed', folder: '' } }
  }
  if (r.kind === 'files') {
    return {
      mode: 'empty',
      activeId: null,
      loading: false,
      nav: { type: 'folder', folder: r.path },
    }
  }

  return { mode: 'empty', activeId: null, loading: false, nav: { type: 'all', folder: '' } }
}
