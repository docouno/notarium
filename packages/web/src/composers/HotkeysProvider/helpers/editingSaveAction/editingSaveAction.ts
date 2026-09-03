export type EditingSaveDecision = 'save' | 'finish' | 'remain'

type EditingSaveState = {
  active: boolean
  saving: boolean
  canSave: boolean
  isNew: boolean
  dirty: boolean
}

/** One action-level decision shared by every binding of editing.save. Ordering is
 * load-bearing: valid new drafts save before the new-session guard, while clean
 * existing sessions finish without entering the mutation path. */
export const editingSaveAction = ({
  active,
  saving,
  canSave,
  isNew,
  dirty,
}: EditingSaveState): EditingSaveDecision => {
  if (!active || saving) {
    return 'remain'
  }
  if (canSave) {
    return 'save'
  }
  if (isNew || dirty) {
    return 'remain'
  }

  return 'finish'
}
