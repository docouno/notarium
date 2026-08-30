import type { RoleContextIdentity, RoleContextView } from '@notarium/contract'
import type { ContextPinView, ContextSetItemView, ContextSetRowView } from '../../types'

/** The role panel's rows, assembled from the TWO doors that each own half the answer
 *  (#309).
 *
 *  WHAT the layer is — which notes, which sets, in which order, and whether it may be
 *  changed — comes from the identity door: a question about the space, answered the
 *  same way whether or not the agent loads this role here. WHAT IT COSTS comes from the
 *  preview, and only when the agent does load it: `loaded` is a verdict of the joint
 *  session budget, so only the door that weighed that budget may state it.
 *
 *  Which is why an unweighed row keeps `loaded` ABSENT rather than defaulting it. A
 *  default is a claim, and both defaults are false claims about a layer nobody weighed:
 *  `true` would promise a load that is not happening, `false` would badge a pin the
 *  reader can plainly see as dropped. Absent says the honest thing — no one asked. */
export const roleLayerRows = (
  layer: Pick<RoleContextIdentity, 'pins' | 'sets'>,
  weighed: Pick<RoleContextView, 'pins' | 'sets'> | undefined,
): { pins: ContextPinView[]; sets: ContextSetRowView[] } => {
  const pinVerdict = new Map((weighed?.pins ?? []).map((pin) => [pin.noteId, pin.loaded]))
  const loadedIds = new Set([
    ...(weighed?.pins ?? []).filter((pin) => pin.loaded).map((pin) => pin.noteId),
    ...(weighed?.sets ?? []).flatMap((set) =>
      set.items.filter((item) => item.loaded).map((item) => item.noteId),
    ),
  ])
  // A note can sit in two sets of the same layer, and the budget trims a SET ITEM, not
  // a note — so the verdict is keyed by the pair, never by the note alone.
  const itemVerdict = new Map(
    (weighed?.sets ?? []).flatMap((set) =>
      set.items.map((item) => [`${set.id}\u0000${item.noteId}`, item.loaded] as const),
    ),
  )
  const weighedSetById = new Map((weighed?.sets ?? []).map((set) => [set.id, set]))
  const weigh = <T extends object>(row: T, verdict: boolean | undefined): T =>
    verdict === undefined ? row : { ...row, loaded: verdict }

  return {
    pins: layer.pins.map((pin) =>
      weigh<ContextPinView>(
        pin,
        pinVerdict.get(pin.noteId) ?? (weighed ? loadedIds.has(pin.noteId) : undefined),
      ),
    ),
    sets: layer.sets.map((set) => {
      const weighedSet = weighedSetById.get(set.id)
      const items = set.items.map((item) =>
        weigh<ContextSetItemView>(
          item,
          itemVerdict.get(`${set.id}\u0000${item.noteId}`) ??
            (weighed ? loadedIds.has(item.noteId) : undefined),
        ),
      )

      return {
        ...set,
        items,
        ...(weighedSet
          ? {
              trimmed: weighedSet.trimmed,
              itemsLoaded: items.filter((item) => item.loaded === true).length,
              hasBudgetVerdict: true,
            }
          : {}),
      }
    }),
  }
}
