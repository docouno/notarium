import type { ProjectRow } from '@notarium/contract'

/** Compact token count for a chip/label: 820 → "820", 1234 → "1.2k", 12345 → "12k". */
export const formatTokens = (n: number): string => {
  if (n < 1000) {
    return `${Math.round(n)}`
  }
  const k = n / 1000
  return `${k < 10 ? k.toFixed(1) : Math.round(k)}k`
}

export const projectLabel = (project: ProjectRow) => {
  if (!project.path) {
    return 'Space root'
  }

  return project.displayName || project.path.split('/').filter(Boolean).at(-1) || project.slug
}

/** Projects read by their human name; the handle joins in only when two of them
 *  (or a project and its Space root) would otherwise show the same words. Every
 *  surface that lists projects to CHOOSE from uses this — an ambiguous menu is a
 *  menu the user cannot answer. */
export const projectChoiceLabels = <T extends { displayName: string; handle: string }>(
  projects: readonly T[],
): Array<T & { label: string }> =>
  projects.map((entry) => ({
    ...entry,
    label:
      projects.filter((other) => other.displayName === entry.displayName).length > 1
        ? `${entry.displayName} · ${entry.handle}`
        : entry.displayName,
  }))
