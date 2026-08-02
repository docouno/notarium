import type { ContextMemory, ContextPin, ContextSetView } from '@notarium/contract'
import type { LoadState } from '../../types'

/** The eager loaded/trimmed/muted state of a memory category as the SERVER curated it
 *  (#208): muted first (dropped from the budget), else the server's `loaded` verdict. */
export const memoryState = (cat: ContextMemory): LoadState =>
  cat.muted ? 'muted' : cat.loaded ? 'loaded' : 'trimmed'

/** Sum the token weight the SERVER trimmed (over the scope budget) across pins. */
export const pinsTrimmed = (pins: ContextPin[]): number =>
  pins.filter((p) => !p.loaded).reduce((sum, p) => sum + p.tokens, 0)
/** Sum the token weight trimmed across the ITEMS of a scope's context sets (#209) — set
 *  items ride the same one budget as pins, so a trimmed set item must count toward the
 *  scope's aggregate trim total, else the tab reads "nothing dropped" while an item's meter
 *  shows red (the "budget-free-yet-trimmed" contradiction the single scale forbids). */
export const setsTrimmed = (sets: ContextSetView[]): number =>
  sets
    .flatMap((s) => s.items)
    .filter((i) => !i.loaded)
    .reduce((sum, i) => sum + i.tokens, 0)
/** Sum the token weight trimmed across the eager (non-muted) memory categories. */
export const memoryTrimmed = (memory: ContextMemory[]): number =>
  memory.filter((m) => !m.muted && !m.loaded).reduce((sum, m) => sum + m.tokens, 0)
