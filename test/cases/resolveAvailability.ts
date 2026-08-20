import type { AbilityAvailability } from '@notarium/server'

import type { AgentAbilityAvailabilityDecl } from './types'

/** Declarations name a project the way a person does — space plus path — while the
 *  availability tables are keyed by stable ids. Both appliers (fake and real) and both
 *  kinds (Role and Skill) resolve it here, so the one invariant the schema enforces —
 *  a selected project belongs to the ability's home space — is stated once. */
export const resolveAvailabilityDecl = (
  declaration: AgentAbilityAvailabilityDecl | undefined,
  homeSpace: string,
  projectOf: (reference: { space: string; path: string }) => { id: string; space: string } | null,
  subject: string,
): AbilityAvailability => {
  if (!declaration || declaration.mode === 'all-projects') {
    return { mode: 'all-projects' }
  }

  return {
    mode: 'selected-projects',
    projectIds: declaration.projects.map((reference) => {
      const project = projectOf(reference)

      if (!project || project.space !== homeSpace) {
        throw new Error(`${subject} references a project outside its home space`)
      }

      return project.id
    }),
  }
}
