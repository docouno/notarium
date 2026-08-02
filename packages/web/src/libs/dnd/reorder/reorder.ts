import { type DragEvent as ReactDragEvent, useRef, useState } from 'react'

import { TEXT_PLAIN_MIME } from '../dnd'

// A small list-REORDER primitive (#210) — distinct from the tree's move-into-folder DnD
// (`../dnd/dnd.ts`, which decides drop VALIDITY into a container). Here every row is a
// draggable handle and a drop lands BETWEEN rows (before/after the hovered one), producing
// a new key order. Native HTML5 DnD (same substrate as the tree), so no dependency; the
// index math is pure and unit-tested.
//
// Two correctness rules the naive version got wrong (both the explorer's #94 family):
//
//  1. FAST-DROP. The active drag lives in a REF (`active`), set synchronously on `dragstart`
//     — NOT React state, which lags a frame. A fast drag reaches `dragover` before state
//     commits; a guard reading that state would skip `preventDefault()`, and WITHOUT a
//     dragover `preventDefault()` the browser never fires `drop` → the row "stays put" until
//     you grab it slowly and hover long enough for the state to catch up. So `dragover`
//     preventDefaults UNCONDITIONALLY while a drag is live.
//
//  2. WYSIWYG DROP. The drop commits to the SAME target the indicator shows — a `target` ref
//     updated on every `dragover` (synchronous, so it's current at release), NOT recomputed
//     from the drop event (which, at a row edge or on jitter, can disagree with the line the
//     user saw). And the whole LIST is the drop zone (`listProps`), so releasing in the
//     inter-row GAP still commits to the last-hovered target instead of the drop being lost.
//
// A separate `over`/`dragging` STATE drives only the cosmetic indicator + fade; it may lag
// without affecting where the drop lands. Each list owns its own instance, so a nested list
// (a set's items inside the pin list) never reacts to the outer list's drag — the outer
// `active` ref is null while the nested one drags, and the nested handlers stopPropagation so
// a nested drop never bubbles to the outer list.

/** Move `dragKey` to sit before/after `overKey` in `keys` (#210). A no-op when the drag
 *  lands on itself or the target is gone. Pure — the tricky splice math is unit-tested. */
export const reorderKeys = (
  keys: readonly string[],
  dragKey: string,
  overKey: string,
  after: boolean,
): string[] => {
  if (dragKey === overKey) {
    return [...keys]
  }
  const without = keys.filter((k) => k !== dragKey)
  const idx = without.indexOf(overKey)

  if (idx < 0) {
    return [...keys]
  }
  const insertAt = after ? idx + 1 : idx
  return [...without.slice(0, insertAt), dragKey, ...without.slice(insertAt)]
}

const sameOrder = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((k, i) => k === b[i])

/** Is the pointer past a row's vertical midpoint? → drop AFTER it, else before. */
const dropsAfter = (e: ReactDragEvent): boolean => {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
  return e.clientY > r.top + r.height / 2
}

/** The drag props a reorderable ROW spreads onto its draggable surface, plus its live drop
 *  indicator (a line before/after) and dragging (dimmed) state. The DROP itself lives on the
 *  list (see {@link ReorderListProps}), not the row. */
export type ReorderHandle = {
  draggable: true
  onDragStart: (e: ReactDragEvent) => void
  onDragOver: (e: ReactDragEvent) => void
  onDragEnd: (e: ReactDragEvent) => void
  dropIndicator: 'before' | 'after' | null
  dragging: boolean
}

/** The props the LIST container spreads so the whole list (rows AND the gaps between them) is
 *  one drop zone — a release anywhere in it commits to the last-hovered target (#210). */
export type ReorderListProps = {
  onDragOver: (e: ReactDragEvent) => void
  onDrop: (e: ReactDragEvent) => void
}

/** Wire a reorderable list (#210): `keys` in current order, `onReorder(next)` fired with the
 *  new order on a committed drop (never for a no-op). Returns `handleFor(key)` — a row's drag
 *  props + visual state — and `listProps` for the list container. `disabled` (a single-item
 *  list, a reader) yields inert handles, so the same render path serves the non-reorderable
 *  case. */
export const useReorder = (
  keys: readonly string[],
  onReorder: (next: string[]) => void,
  disabled = false,
): { handleFor: (key: string) => ReorderHandle | undefined; listProps: ReorderListProps } => {
  // Authoritative, synchronous drag state (fast-drop + WYSIWYG): the dragged key and the
  // last-hovered drop target. React state below is cosmetic only.
  const active = useRef<string | null>(null)
  const target = useRef<{ key: string; after: boolean } | null>(null)
  const [over, setOver] = useState<{ key: string; after: boolean } | null>(null)
  const [dragging, setDragging] = useState<string | null>(null)

  const end = () => {
    active.current = null
    target.current = null
    setOver(null)
    setDragging(null)
  }

  const commit = () => {
    const dk = active.current
    const t = target.current

    if (dk && t && t.key !== dk) {
      const next = reorderKeys(keys, dk, t.key, t.after)

      if (!sameOrder(next, keys)) {
        onReorder(next)
      }
    }
    end()
  }

  const setTarget = (key: string, after: boolean) => {
    target.current = { key, after }
    setOver((o) => (o && o.key === key && o.after === after ? o : { key, after }))
  }

  const handleFor = (key: string): ReorderHandle | undefined => {
    // A single-item (or reader) list is not reorderable → NO handle: the row isn't draggable
    // and shows no grip, so there's no dead grab affordance / no-op native drag ghost. The
    // list container's `listProps` stay inert too (its `active` ref never gets set).
    if (disabled) {
      return undefined
    }

    return {
      draggable: true,
      onDragStart: (e) => {
        e.stopPropagation()
        e.dataTransfer.effectAllowed = 'move'
        // A payload is required for Firefox to start the drag; the key rides so a drop
        // outside the app is a plain no-op.
        e.dataTransfer.setData(TEXT_PLAIN_MIME, key)
        active.current = key
        target.current = null
        setDragging(key)
        setOver(null)
      },
      onDragOver: (e) => {
        // Not THIS list's drag → bail WITHOUT preventing default, so the event bubbles to the
        // list that owns the active drag (an outer list over a nested one, or vice versa).
        if (!active.current) {
          return
        }
        e.preventDefault()
        e.stopPropagation()
        e.dataTransfer.dropEffect = 'move'
        // Over the dragged row itself: keep the last real target (don't null it).
        if (active.current === key) {
          return
        }
        setTarget(key, dropsAfter(e))
      },
      onDragEnd: end,
      dropIndicator:
        over && over.key === key && active.current !== key
          ? over.after
            ? 'after'
            : 'before'
          : null,
      dragging: dragging === key,
    }
  }

  // The LIST is the single drop ZONE: dragover keeps the whole list (incl. the inter-row gaps)
  // a valid target, and a release anywhere in it commits to the last-hovered `target` ref — so
  // the drop lands where the indicator shows, and a release in a gap is never lost.
  const listProps: ReorderListProps = {
    onDragOver: (e) => {
      if (!active.current) {
        return
      }
      e.preventDefault()
      e.stopPropagation()
      e.dataTransfer.dropEffect = 'move'
    },
    onDrop: (e) => {
      if (!active.current) {
        return
      }
      e.preventDefault()
      e.stopPropagation()
      commit()
    },
  }

  return { handleFor, listProps }
}
