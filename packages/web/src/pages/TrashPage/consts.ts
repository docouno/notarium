// One fixed row height for EVERY deleted item — virtualization needs it. It hugs the body
// exactly: title 16 + 2 gap + meta 14 = 32, plus the body's top/bottom padding of $pill-pad
// each (TrashPage.module.scss). So the hover pill's vertical breathing IS that padding —
// the same inset it breathes horizontally. Keep this = 32 + 2×$pill-pad; any slack would
// read as more padding top/bottom than left/right.
export const ROW_H = 56

/** Window size per fetch — infinite-scroll appends one page at a time. */
export const PAGE = 100

/** Fallback top-chrome height (px) used before the glass band is first measured —
 *  the resting topbar height, so the list pads clear of it on the very first frame. */
export const DEFAULT_TOP_CHROME_H = 52

export const RESTORE_REASONS = {
  revision_has_no_content: 'The deleted content was never captured, so there’s nothing to restore.',
  note_not_in_trash: 'This item is no longer in the trash.',
  note_already_exists: 'A note already lives at that path, so this one can’t be restored there.',
  not_found: 'This item is no longer available.',
} as const
