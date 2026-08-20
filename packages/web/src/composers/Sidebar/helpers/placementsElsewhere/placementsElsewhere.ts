/** Whether the Space-scoped tree can be hiding placements, i.e. whether the way out
 *  to the owner-global library is worth offering. `truncated` alone was the wrong
 *  question: it means the server's bounded scan hit its cap, which a scoped listing of
 *  one or two locations essentially never does — so the exit built for placements in
 *  OTHER Spaces was shown exactly when there were too many in THIS one. What actually
 *  hides a placement is the scope itself: the tree lists the active Space (Personal
 *  rides along), so any further Space the user belongs to is out of view. */
export const hasPlacementsElsewhere = ({
  truncated,
  activeSpaceId,
  personalSpaceId,
  spaces,
}: {
  truncated: boolean
  activeSpaceId: string | null
  personalSpaceId: string | null
  spaces: readonly { id: string }[]
}): boolean =>
  truncated ||
  (activeSpaceId != null &&
    spaces.some((space) => space.id !== activeSpaceId && space.id !== personalSpaceId))
