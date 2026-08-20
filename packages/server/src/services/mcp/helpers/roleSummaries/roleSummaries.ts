import type { EffectiveRoleSummary } from '@notarium/contract'

import { sanitizeText } from '../../sanitize'

const SUMMARY_OVERHEAD_CHARS = 64
const DESCRIPTION_CHARS = 256

/** Curate compact effective-role discovery into its own bootstrap budget. A
 *  selected role's full prompt has a separate `budgetTokens` channel. */
export const curateRoleSummaries = (
  summaries: readonly EffectiveRoleSummary[],
  budgetTokens: number,
): { roles: EffectiveRoleSummary[]; truncated: boolean } => {
  let remaining = Math.max(0, budgetTokens) * 4
  // Provenance is irrelevant to agent discovery. The bootstrap is a compact
  // first page; list_roles is the bounded continuation for every omitted role.
  let truncated = false
  const safe = summaries.map((source) => {
    const description = sanitizeText(source.description)

    if (description.length > DESCRIPTION_CHARS) {
      truncated = true
    }

    const curated = {
      name: sanitizeText(source.name),
      title: sanitizeText(source.title),
      description:
        description.length > DESCRIPTION_CHARS
          ? `${description.slice(0, DESCRIPTION_CHARS - 1).trimEnd()}…`
          : description,
    }

    // The source arm is preserved as it came: a System role has no scope to carry,
    // and inventing one here is exactly what made the resolver unable to name it.
    return source.source === 'system'
      ? ({ ...curated, source: source.source } as const)
      : ({ ...curated, source: source.source, scope: source.scope } as const)
  })
  const roles: EffectiveRoleSummary[] = []

  for (const role of safe) {
    const cost =
      SUMMARY_OVERHEAD_CHARS +
      role.name.length +
      role.title.length +
      ('scope' in role ? role.scope.length : role.source.length) +
      role.description.length

    if (cost > remaining) {
      truncated = true
      break
    }
    remaining -= cost
    roles.push(role)
  }

  truncated ||= roles.length < summaries.length
  return { roles, truncated }
}
