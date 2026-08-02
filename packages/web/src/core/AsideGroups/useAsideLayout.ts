import { useCallback, useEffect, useMemo, useState } from 'react'

// The layout model behind the right aside: an ordered stack of GROUPS, each a
// tabbed container holding one or more PANELS. COMPOSITION is fixed by the caller's
// default layout — there's no add/remove-group UI (#35 MVP: two fixed groups). The
// default is ALWAYS the source of composition, so tuning it ships to everyone at
// once; only the per-group ACTIVE TAB and HEIGHT persist (positionally), not the
// composition. A partition invariant — every AVAILABLE panel in exactly one group —
// is kept by reconcile, so a panel that comes/goes with context (History needs a
// note) lands in / leaves a group cleanly. User rearrangement (grab-a-tab DnD,
// drop-to-make-a-third-group) is #36: it will mutate this same model and extend the
// persist to carry composition then.

export type GroupState = {
  /** Runtime-only id (regenerated on load) — stable key for React + resize. */
  id: string
  panels: string[]
  activeTab: string
  /** Group height in px. Ignored for the last group, which always flexes to fill
   *  the remaining space; meaningful only for the groups above it. */
  height?: number
}

/** A default layout, before runtime ids are assigned. */
export type LayoutSpec = { panels: string[]; activeTab?: string; height?: number }[]

/** What persists per group, positionally (composition comes from the default, not
 *  here): the active tab and the height. */
type PersistedGroup = { activeTab?: string; height?: number }

let SEQ = 0
const nextId = (): string => `g${++SEQ}`

export const MIN_GROUP_HEIGHT = 120

const hydrate = (spec: LayoutSpec): GroupState[] =>
  spec
    .filter((g) => g.panels.length > 0)
    .map((g) => ({
      id: nextId(),
      panels: [...g.panels],
      activeTab: g.activeTab && g.panels.includes(g.activeTab) ? g.activeTab : g.panels[0],
      height: g.height,
    }))

// Bring a layout back into the partition invariant against the current panel
// registry: drop panels no longer available, drop empty groups, append any
// available-but-unplaced panels to the last group, and repair active tabs. Pure;
// returns the same array reference when nothing changed (so effects don't churn).
const reconcile = (
  groups: GroupState[],
  available: string[],
  fallback: LayoutSpec,
): GroupState[] => {
  const availableSet = new Set(available)
  let next = groups
    .map((g) => {
      const panels = g.panels.filter((p) => availableSet.has(p))
      return { ...g, panels, activeTab: panels.includes(g.activeTab) ? g.activeTab : panels[0] }
    })
    .filter((g) => g.panels.length > 0)

  const placed = new Set(next.flatMap((g) => g.panels))
  const orphans = available.filter((p) => !placed.has(p))

  if (orphans.length) {
    if (next.length === 0) {
      next = hydrate(fallback.length ? fallback : [{ panels: orphans }])
    } else {
      const last = next.length - 1
      next = next.map((g, i) =>
        i === last
          ? { ...g, panels: [...g.panels, ...orphans.filter((o) => !g.panels.includes(o))] }
          : g,
      )
    }
  }
  if (next.length === 0) {
    next = hydrate(fallback)
  }

  // Reference-stable no-op detection: same group ids, panels and active tabs.
  const same =
    next.length === groups.length &&
    next.every(
      (g, i) =>
        groups[i] &&
        groups[i].id === g.id &&
        groups[i].activeTab === g.activeTab &&
        groups[i].panels.length === g.panels.length &&
        groups[i].panels.every((p, j) => p === g.panels[j]),
    )
  return same ? groups : next
}

type UseAsideLayout = {
  groups: GroupState[]
  setActiveTab: (groupId: string, panelId: string) => void
  setGroupHeight: (groupId: string, height: number) => void
}

export const useAsideLayout = (
  available: string[],
  defaultLayout: LayoutSpec,
  storageKey: string | null,
): UseAsideLayout => {
  const [groups, setGroups] = useState<GroupState[]>(() => {
    // Composition is always the default; persistence only overlays the active tab
    // and height onto each group by position.
    const base = reconcile(hydrate(defaultLayout), available, defaultLayout)
    const raw = storageKey && localStorage.getItem(storageKey)

    if (!raw) {
      return base
    }
    try {
      const saved = JSON.parse(raw) as PersistedGroup[]

      if (!Array.isArray(saved)) {
        return base
      }

      return base.map((g, i) => {
        const s = saved[i]

        if (!s) {
          return g
        }

        return {
          ...g,
          activeTab: s.activeTab && g.panels.includes(s.activeTab) ? s.activeTab : g.activeTab,
          height: typeof s.height === 'number' ? s.height : g.height,
        }
      })
    } catch {
      return base
    }
  })

  // Keep the layout reconciled when the available-panel set changes (e.g. a panel
  // becomes unavailable for the current note). `available` is a fresh array each
  // render — compare by content via its join key, not identity.
  const availableKey = available.join('\u0000')
  useEffect(() => {
    setGroups((g) => reconcile(g, availableKey ? availableKey.split('\u0000') : [], defaultLayout))
    // defaultLayout is a stable literal from the caller; availableKey captures the set.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [availableKey])

  // Persist only the active tab + height per group, positionally — NOT the
  // composition (that's the default's job, so default tweaks reach everyone).
  useEffect(() => {
    if (!storageKey) {
      return
    }
    const spec: PersistedGroup[] = groups.map((g) => ({ activeTab: g.activeTab, height: g.height }))
    localStorage.setItem(storageKey, JSON.stringify(spec))
  }, [groups, storageKey])

  const setActiveTab = useCallback((groupId: string, panelId: string) => {
    setGroups((gs) =>
      gs.map((g) =>
        g.id === groupId && g.panels.includes(panelId) ? { ...g, activeTab: panelId } : g,
      ),
    )
  }, [])

  const setGroupHeight = useCallback((groupId: string, height: number) => {
    setGroups((gs) => gs.map((g) => (g.id === groupId ? { ...g, height } : g)))
  }, [])

  return useMemo(
    () => ({ groups, setActiveTab, setGroupHeight }),
    [groups, setActiveTab, setGroupHeight],
  )
}
