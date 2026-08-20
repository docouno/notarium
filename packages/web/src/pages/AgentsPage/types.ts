import type { ContextPin, ContextSetView, MemoryCategory } from '@notarium/contract'

/** A pin as a context PANEL renders it (#309). `loaded` is optional because it is a
 *  claim about a budget, and not every source of a pin weighs one: the scope previews
 *  do (they mirror what the agent loads), the role identity door does not (it hands
 *  back the layer that is edited, whether or not the agent loads it here). Absent
 *  therefore means "nobody said", which is why every reader below asks `=== false`
 *  rather than `!loaded` — the two differ exactly on the layer no one weighed. */
export type ContextPinView = Omit<ContextPin, 'loaded'> & { loaded?: boolean }
export type ContextSetItemView = Omit<ContextSetView['items'][number], 'loaded'> & {
  loaded?: boolean
}
export type ContextSetRowView = Omit<ContextSetView, 'items'> & { items: ContextSetItemView[] }

// The scale's TWO scopes (#208). Colour encodes SELECTION, not identity (heatmap
// ramp, #33): the ACTIVE band is the bright top step (toward white), every other band
// the full accent — the selected part reads as "lit", the rest as background. The
// bands keep a fixed order so selecting one never reshuffles the bar.
export type ScopeKey = 'personal' | 'project' | 'role'
export type ProjectScope = {
  id: string
  slug: string
  handle: string
  label: string
  path: string
  aliases: string[]
  canonicalScope: string
}
export type LoadState = 'loaded' | 'trimmed' | 'muted'
export type MemoryItem = { cat: MemoryCategory; state: LoadState }
/** One scope's contribution to the aggregate scale (#208): its eager loaded tokens and
 *  the weight it trimmed (shown per-item, not as a band on the strictly-budget bar). */
export type ScopeCard = { key: ScopeKey; label: string; loaded: number; trimmed: number }

/** What the picker saves for a set (#209): an existing set (`setId`) OR a new one
 *  (`setId:null` + `name`), plus the cross-space refs to add. Removal is per-item from the
 *  set row's own menu, so the picker only ever ADDS. */
export type SetSave = { setId: string | null; name: string; items: PickedNote[]; home?: string }

/** A cross-space note ref the picker returns (#209): the note's home space slug + its
 *  globally-unique id. Used for both pinning (same-space → tag, foreign → scope ref) and
 *  set items. */
export type PickedNote = { space: string; noteId: string }
