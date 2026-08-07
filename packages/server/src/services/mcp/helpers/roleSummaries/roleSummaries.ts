import type { RoleSummary } from '@notarium/contract'

import { sanitizeText } from '../../sanitize'

const SUMMARY_OVERHEAD_CHARS = 64
const DESCRIPTION_CHARS = 256

/** Curate compact effective-role discovery into its own bootstrap budget. A
 *  selected role's full prompt has a separate `budgetTokens` channel. */
export const curateRoleSummaries = (
  summaries: readonly RoleSummary[],
  budgetTokens: number,
): { roles: RoleSummary[]; truncated: boolean } => {
  let remaining = Math.max(0, budgetTokens) * 4
  // Provenance is irrelevant to agent discovery. The bootstrap is a compact
  // first page; list_roles is the bounded continuation for every omitted role.
  let truncated = false
  const safe = summaries.map((source) => {
    const description = sanitizeText(source.description)

    if (description.length > DESCRIPTION_CHARS) {
      truncated = true
    }

    return {
      name: sanitizeText(source.name),
      description:
        description.length > DESCRIPTION_CHARS
          ? `${description.slice(0, DESCRIPTION_CHARS - 1).trimEnd()}…`
          : description,
      scope: source.scope,
    }
  })
  const roles: RoleSummary[] = []

  for (const role of safe) {
    const cost =
      SUMMARY_OVERHEAD_CHARS + role.name.length + role.scope.length + role.description.length

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
