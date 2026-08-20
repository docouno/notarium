import {
  type AbilityPreferenceTarget,
  ownedRoleLocator,
  ownedSkillLocator,
  type RoleLocation,
  type RolesService,
  SYSTEM_PRINCIPAL,
} from '@notarium/server'

import type { AppliedAgentRole } from './applyAgentRoles'
import type { AppliedAgentSkill } from './applyAgentSkills'
import type { AgentAbilityPreferenceDecl, AgentRoleTargetDecl, AgentSkillHomeDecl } from './types'

/** Two placements are the same one only if all three coordinates agree — a Space and
 *  a project of it share the space id, and same-name Personal/Space/Project presets
 *  are the state this whole facet exists to keep apart. */
const samePlacement = (
  a: { scope: string; space: string; projectId?: string },
  b: { scope: string; space: string; projectId?: string },
): boolean => a.scope === b.scope && a.space === b.space && a.projectId === b.projectId

/** Owner Enable/Disable overrides, written LAST against the ids the role and skill
 *  appliers just minted. The facet is sparse — an absent row already means enabled —
 *  so only declared rows are written, and they are written for the OWNER, because two
 *  people may disagree about the same shared ability.
 *
 *  Both seeders (the real `scripts/seed.ts` and the fake `test/fake-server/app.ts`)
 *  resolve a declaration HERE, the way both already share the role, skill and
 *  availability appliers. The copy this replaces was 60 lines duplicated verbatim, and
 *  only the fake half was reachable by any test: a change made in one and forgotten in
 *  the other produced a stand whose disabled abilities were enabled, with the browser
 *  gate reading the other stand and calling it green.
 *
 *  A declaration that names a package nobody published is a broken world, not a row to
 *  skip: swallowing it would leave a stand serving an ENABLED ability while the other
 *  stand refused to boot at all. */
export const applyAgentAbilityPreferences = async ({
  declarations,
  roles,
  publishedRoles,
  publishedSkills,
  resolvePlacement,
  ownerOf,
  setEnabled,
}: {
  declarations: readonly AgentAbilityPreferenceDecl[]
  roles: RolesService
  publishedRoles: readonly AppliedAgentRole[]
  publishedSkills: readonly AppliedAgentSkill[]
  /** The host's one answer to "where did this declaration land?" — the same seam the
   *  role and skill appliers were given. */
  resolvePlacement: (target: AgentRoleTargetDecl | AgentSkillHomeDecl) => Promise<RoleLocation>
  /** The declared owner, mapped to whatever this host calls that login. */
  ownerOf: (declaration: AgentAbilityPreferenceDecl) => string
  /** The host's preference facet, already carrying its own clock. */
  setEnabled: (owner: string, target: AbilityPreferenceTarget, enabled: boolean) => Promise<void>
}): Promise<number> => {
  if (!declarations.length) {
    return 0
  }
  const bundled = await roles.listBundledAbilities(SYSTEM_PRINCIPAL)
  let written = 0

  for (const preference of declarations) {
    const ability = preference.ability
    const owner = ownerOf(preference)
    const subject = `${ability.source} ${ability.kind} ${ability.name}`
    let target: AbilityPreferenceTarget

    if (ability.source === 'system') {
      const bundledAbility = bundled.find(
        (candidate) =>
          candidate.source === 'system' &&
          candidate.locator.kind === ability.kind &&
          candidate.name === ability.name,
      )

      if (!bundledAbility || bundledAbility.locator.source !== 'system') {
        throw new Error(`ability preference references an unknown ${subject}`)
      }
      target = { locator: bundledAbility.locator }
    } else {
      const placement = await resolvePlacement(
        ability.kind === 'role' ? ability.target : ability.home,
      )
      // Declarations name each other by the name in the case file, which a
      // `renameTo` deliberately does not change.
      const published =
        ability.kind === 'role'
          ? publishedRoles.find(
              (entry) =>
                entry.declaration.name === ability.name && samePlacement(entry.location, placement),
            )
          : publishedSkills.find(
              (entry) =>
                entry.declaration.name === ability.name && samePlacement(entry.location, placement),
            )

      if (!published) {
        throw new Error(`ability preference references an unpublished ${subject}`)
      }

      if (placement.scope === 'project') {
        // A project holds roles only, so a skill declared there names a home that
        // cannot exist rather than one that happens to be empty.
        if (ability.kind === 'skill') {
          throw new Error(`ability preference ${subject} names a project, which is no skill home`)
        }
        if (!placement.projectId) {
          throw new Error(`ability preference ${subject} names a project with no id`)
        }
        target = {
          // Minted by the service, so a stand cannot be seeded at an address the
          // service would not answer to.
          locator: ownedRoleLocator(placement, published.packageId),
          registryNoteId: published.packageId,
        }
      } else {
        // Not a project, so this placement IS a skill home — the narrowing the minter
        // asks for, stated once here instead of inside a hand-written address.
        const home = { scope: placement.scope, space: placement.space }

        target = {
          locator:
            ability.kind === 'role'
              ? ownedRoleLocator(home, published.packageId)
              : ownedSkillLocator(home, published.packageId),
          registryNoteId: published.packageId,
        }
      }
    }
    await setEnabled(owner, target, preference.enabled)
    written++
  }

  return written
}
