export type SkillCounts = { count: number; truncated: boolean }
export type RoleCounts = SkillCounts & { activeRole: string | null }

const rolesOf = (roles: RoleCounts): string =>
  roles.truncated
    ? roles.count
      ? `${roles.count}+ roles`
      : 'partial role count'
    : `${roles.count} ${roles.count === 1 ? 'role' : 'roles'}${roles.count ? '' : ' added'}`

const skillsOf = (skills: SkillCounts): string =>
  `${skills.count}${skills.truncated ? '+' : ''} skill${skills.count === 1 ? '' : 's'}`

/** The Abilities pill's identity line, or undefined while nothing has been read.
 *
 *  The counts ride the listing scoped to the active Space — one row, read for its facets —
 *  while the library page under the pill lists what is available AROUND that Space,
 *  owner-wide. The line does not spell that scope out: it sits in the first of three pills
 *  and a fourth clause pushed the bar wider than the two beside it. */
export const abilitiesMetric = (
  roles: RoleCounts | null,
  skills: SkillCounts | null,
): string | undefined =>
  roles || skills
    ? [
        roles
          ? `${rolesOf(roles)}${roles.activeRole ? ` · ${roles.activeRole} active` : ''}`
          : null,
        skills ? skillsOf(skills) : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : undefined
