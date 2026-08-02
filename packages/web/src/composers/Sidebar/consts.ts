import { DND_ATTRS } from '../../libs/dnd/dnd'
import { STORAGE_KEYS } from '../../libs/storageKeys'

// Sentinel drop target for "move to the project root" (no folder).
export const ROOT = ' root'

// The explorer scope (#164) is remembered per space in localStorage — survives a
// reload, scoped to the active space (a project belongs to one space, #16). A
// malformed/blocked store degrades to Files. Keyed by the space SLUG (like the
// other per-space rail prefs, e.g. bm-rail-w): a space rename (#123) thus resets
// the view to Files + drops that space's recents — an accepted, self-correcting
// cost (no wrong-space leak; recents rebuild on next focus).
export const SCOPE_KEY = STORAGE_KEYS.explorerScopePrefix

// Recently-focused projects (#164), per space — a client-side MRU of project IDs
// (stable across rename/move, unlike the path) behind the dropdown's quick-jumps.
export const RECENT_KEY = STORAGE_KEYS.recentProjectsPrefix

// Drop targeting (#64 virtualization → #94 fast-drop fix): every row carries its
// target folder in `data-drop-folder` (a note row → its parent, a folder row →
// itself, a skeleton → its folder; '' = root). The drag/drop EVENTS are handled
// once at the folders section, not per row — rows just declare their target.
//
// Why moved up: native HTML5 DnD only fires `drop` on an element whose latest
// `dragover` called preventDefault, and the browser throttles dragover. With
// per-row handlers a fast drag could release a frame after crossing into the
// target row before that row's dragover fired — the drop silently failed and you
// had to slow down and hover precisely (#94 follow-up). One section-level surface
// stays "accepting" under the pointer the whole time; the precise folder is read
// from the row under the cursor at the moment of the event.
export const DROP_FOLDER_ATTR = DND_ATTRS.dropFolder
