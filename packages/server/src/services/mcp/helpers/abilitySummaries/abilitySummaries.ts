import type { RuntimeAbilitySummary } from '@notarium/contract/tools'

import { sanitizeText } from '../../sanitize'

const SUMMARY_OVERHEAD_CHARS = 64
const DESCRIPTION_CHARS = 256

export const curateAbilitySummaries = (
  summaries: readonly RuntimeAbilitySummary[],
  budgetTokens: number,
): { abilities: RuntimeAbilitySummary[]; truncated: boolean } => {
  let remaining = Math.max(0, budgetTokens) * 4
  let truncated = false
  const safe = summaries
    .map((source): RuntimeAbilitySummary => {
      const description = sanitizeText(source.description)
      const curated = {
        name: sanitizeText(source.name),
        title: sanitizeText(source.title),
        description:
          description.length > DESCRIPTION_CHARS
            ? `${description.slice(0, DESCRIPTION_CHARS - 1).trimEnd()}…`
            : description,
      }

      truncated ||= description.length > DESCRIPTION_CHARS
      if (source.source === 'system') {
        return { ...curated, source: 'system', kind: source.kind }
      }

      return source.kind === 'skill'
        ? { ...curated, source: 'owned', kind: 'skill', scope: source.scope }
        : { ...curated, source: 'owned', kind: 'role', scope: source.scope }
    })
    .sort(
      (left, right) => left.kind.localeCompare(right.kind) || left.name.localeCompare(right.name),
    )
  const abilities: RuntimeAbilitySummary[] = []

  for (const ability of safe) {
    const cost =
      SUMMARY_OVERHEAD_CHARS +
      ability.name.length +
      ability.title.length +
      ability.description.length +
      ability.kind.length +
      ability.source.length +
      ('scope' in ability ? ability.scope.length : 0)

    if (cost > remaining) {
      truncated = true
      break
    }
    remaining -= cost
    abilities.push(ability)
  }

  truncated ||= abilities.length < safe.length
  return { abilities, truncated }
}
