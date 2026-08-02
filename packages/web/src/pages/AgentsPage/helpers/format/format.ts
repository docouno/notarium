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
