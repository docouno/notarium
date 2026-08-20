export type SkillCounts = { count: number; truncated: boolean }
export type RoleCounts = SkillCounts & { activeRole: string | null }

/** What the section rollup is a rollup OF. The counts ride the listing scoped to the
 *  active Space — one row, read for its facets — while the library page under the
 *  pill lists what is available AROUND that Space, owner-wide. So "2 roles" over
 *  seven cards is not a wrong count, it is an unnamed scope; the pill names it rather
 *  than paying for an unbounded global scan on every entry into the section. */
const SCOPE = 'in this Space'

const rolesOf = (roles: RoleCounts): string =>
  roles.truncated
    ? roles.count
      ? `${roles.count}+ roles`
      : 'partial role count'
    : `${roles.count} ${roles.count === 1 ? 'role' : 'roles'}${roles.count ? '' : ' added'}`

const skillsOf = (skills: SkillCounts): string =>
  `${skills.count}${skills.truncated ? '+' : ''} skill${skills.count === 1 ? '' : 's'}`

/** The Abilities pill's identity line, or undefined while nothing has been read. */
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
        SCOPE,
      ]
        .filter(Boolean)
        .join(' · ')
    : undefined
