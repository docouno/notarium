import type { MeAgentContext, ProjectAgentContext } from '@notarium/contract'
import { STORAGE_KEYS } from '../../libs/storageKeys'

export const CONTEXT_SCOPE_SPACE_KEY = STORAGE_KEYS.contextScopeSpacePrefix

export const EMPTY_PERSONAL: MeAgentContext = {
  pins: [],
  memory: [],
  sets: [],
  loadedTokens: 0,
  totalTokens: 0,
  budgetTokens: 0,
}
// A failed fetch commits an EMPTY (not null) scope so the panel degrades to the empty
// state under the error notice — null is the LOADING sentinel (skeleton), so returning
// null on error would strand the pane on a perpetual skeleton (#208 review).
export const EMPTY_PROJECT: ProjectAgentContext = {
  pins: [],
  sets: [],
  projectLoadedTokens: 0,
  personal: { pins: [], sets: [], memory: [], loadedTokens: 0 },
  loadedTokens: 0,
  totalTokens: 0,
  budgetTokens: 0,
  index: { noteCount: 0, folderCount: 0 },
}

// ── Audit (#243) ─────────────────────────────────────────────────────────────
// Module-scope constants for the Agents → Audit surface (see AuditPage).

export const PAGE_SIZE = 50
// The aggregate panels cap each list at this many rows (mirrors the server's aggregates()
// default limit). The Frequent panel is practically always full → a KNOWN fixed height the
// first-load skeleton reserves EXACTLY, so nothing below it shifts when the data lands.
export const AGGREGATE_ROWS = 8

// Deterministic per-index widths so the shimmer reads as varied query lengths without any
// run-to-run jitter (a fixed cycle, indexed).
export const STAT_WIDTHS = ['58%', '46%', '62%', '40%', '54%', '50%', '44%', '60%']
