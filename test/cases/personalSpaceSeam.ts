/** "Which space is the CALLER's own?" — the question every production seam that
 *  places, addresses or resolves an owned package asks, because Personal IS the root
 *  directory of that space: a role placed in a project of it takes PERSONAL skills,
 *  and a locator that calls that space a `space` addresses a place that does not
 *  exist (`ownedPlacementOf`, `homeOf`). Production answers with
 *  `peekPersonalSpace(...)` on every such call.
 *
 *  A seeded world knows the same fact from `personalFor`, and it needs only the
 *  placement to answer: a personal space admits no second member, so the only login
 *  that can publish into one — or into a project of one — is its owner, whose personal
 *  space is that very space. Anywhere else the caller's personal space is a different
 *  space than the placement's, which every consumer of this answer treats exactly as
 *  `null`.
 *
 *  Both appliers (real and fake) ask HERE, so the two cannot disagree with each other
 *  or with the service. Answering `null` unconditionally is what made a seeded role in
 *  a project of a personal space publish a dependency link nothing could resolve — the
 *  defect closed at the producer as IMPL-79 and left standing in the seeders. */
export const personalSpaceForPlacement = (
  personalSpaceIds: ReadonlySet<string>,
  space: string,
): string | null => (personalSpaceIds.has(space) ? space : null)
