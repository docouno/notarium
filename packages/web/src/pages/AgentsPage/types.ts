import type { AgentRetrievalTool, MemoryCategory } from '@notarium/contract'

// The scale's TWO scopes (#208). Colour encodes SELECTION, not identity (heatmap
// ramp, #33): the ACTIVE band is the bright top step (toward white), every other band
// the full accent — the selected part reads as "lit", the rest as background. The
// bands keep a fixed order so selecting one never reshuffles the bar.
export type ScopeKey = 'personal' | 'project'
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

// ── Audit (#243): AuditPage-local types ──────────────────────────────────────
export type ToolFilter = 'all' | AgentRetrievalTool
