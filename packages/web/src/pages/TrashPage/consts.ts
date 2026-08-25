// One fixed row height for EVERY deleted item — virtualization needs it. It hugs the body
// exactly: title 16 + 2 gap + meta 14 = 32, plus the body's top/bottom padding of $pill-pad
// each (TrashPage.module.scss). So the hover pill's vertical breathing IS that padding —
// the same inset it breathes horizontally. Keep this = 32 + 2×$pill-pad; any slack would
// read as more padding top/bottom than left/right.
export const ROW_H = 56

/** Breathing between the floating chrome and the first/last trash row. The larger
 * bottom gap keeps the final row visibly separate from the conditional action bar
 * even when the bottom-edge glass is intentionally flat at the end of the list. */
export const TOP_CONTENT_GAP = 10
export const BOTTOM_CONTENT_GAP = 24

/** Window size per fetch — infinite-scroll appends one page at a time. */
export const PAGE = 100

/** Fallback top-chrome height (px) used before the glass band is first measured —
 *  the resting topbar height, so the list pads clear of it on the very first frame. */
export const DEFAULT_TOP_CHROME_H = 52

export const RESTORE_REASONS = {
  revision_has_no_content: 'The deleted content was never captured, so there’s nothing to restore.',
  revision_content_unreadable:
    'The deleted copy was saved, but this version of Notarium can no longer read it.',
  note_not_in_trash: 'This item is no longer in the trash.',
  'physical-target-changed':
    'The original path is occupied by another note. Move or rename that note, then try restoring again.',
  not_found: 'This item is no longer available.',
  'owner-provenance-conflict':
    'The saved copy’s front matter can’t be rewritten safely — its Notarium fields are duplicated or malformed.',
} as const
