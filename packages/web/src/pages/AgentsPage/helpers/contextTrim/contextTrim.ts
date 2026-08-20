import type { ContextMemory } from '@notarium/contract'
import type { ContextPinView, ContextSetRowView, LoadState } from '../../types'

/** The eager loaded/trimmed/muted state of a memory category as the SERVER curated it
 *  (#208): muted first (dropped from the budget), else the server's `loaded` verdict. */
export const memoryState = (cat: ContextMemory): LoadState =>
  cat.muted ? 'muted' : cat.loaded ? 'loaded' : 'trimmed'

/** Sum the token weight the SERVER trimmed (over the scope budget) across pins. Only an
 *  explicit `loaded:false` counts: a row nobody weighed (a role layer read from the
 *  identity door, which makes no budget claim, #309) is not a dropped row. */
export const pinsTrimmed = (pins: ContextPinView[]): number =>
  pins.filter((p) => p.loaded === false).reduce((sum, p) => sum + p.tokens, 0)
/** Sum the token weight trimmed across the ITEMS of a scope's context sets (#209) — set
 *  items ride the same one budget as pins, so a trimmed set item must count toward the
 *  scope's aggregate trim total, else the tab reads "nothing dropped" while an item's meter
 *  shows red (the "budget-free-yet-trimmed" contradiction the single scale forbids). */
export const setsTrimmed = (sets: ContextSetRowView[]): number =>
  sets
    .flatMap((s) => s.items)
    .filter((i) => i.loaded === false)
    .reduce((sum, i) => sum + i.tokens, 0)
/** Sum the token weight trimmed across the eager (non-muted) memory categories. */
export const memoryTrimmed = (memory: ContextMemory[]): number =>
  memory.filter((m) => !m.muted && !m.loaded).reduce((sum, m) => sum + m.tokens, 0)
