import type { LayoutSpec } from '../../core/AsideGroups'

// The Feed aside is a single "Filter" panel — rendered through AsideGroups (not a
// title) so it wears the same tab as the note inspector. Ephemeral (no storageKey:
// one panel has nothing to rearrange or persist).
export const FEED_LAYOUT: LayoutSpec = [{ panels: ['filter'] }]
