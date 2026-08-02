import { STORAGE_KEYS } from '../../storageKeys'

// The two side-panel geometry presets fed to usePanelWidth (#56). Extracted so a
// panel's dimensions live in one place instead of being duplicated at each call
// site — the right aside in particular is mounted by two components (Aside and
// AsideGroups) that must stay pixel-for-pixel identical. Storage keys come from
// STORAGE_KEYS so the persisted-width handle has a single source too.

/** Right-aside geometry — shared VERBATIM by both aside variants (Aside and the
 *  tabbed-groups AsideGroups), which persist ONE width under the same key so it
 *  carries across them. No maxPx: the aside may take up to 45% of the viewport,
 *  uncapped. */
export const ASIDE_PANEL = {
  storageKey: STORAGE_KEYS.asideWidth,
  min: 240,
  maxVw: 0.45,
  def: 340,
  edge: 'left',
} as const

/** Left-rail geometry — narrower than the aside and hard-capped at 520px so it
 *  stays sane on ultra-wide monitors (neither panel may hog the window). */
export const RAIL_PANEL = {
  storageKey: STORAGE_KEYS.railWidth,
  min: 200,
  maxVw: 0.25,
  maxPx: 520,
  def: 236,
  edge: 'right',
} as const
