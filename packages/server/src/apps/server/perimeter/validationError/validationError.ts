export type ValidationIssue = {
  path: string
  message: string
}

/** Zod errors can cross workspace/package boundaries where two physical copies
 * of the same Zod major exist. `instanceof` is false across that boundary, so
 * recognise only the stable public error shape and validate every issue before
 * treating an exception as caller input. */
export const validationIssuesOf = (error: unknown): ValidationIssue[] | null => {
  if (!error || typeof error !== 'object') {
    return null
  }

  const candidate = error as { name?: unknown; issues?: unknown }

  if (candidate.name !== 'ZodError' || !Array.isArray(candidate.issues)) {
    return null
  }

  const issues: ValidationIssue[] = []

  for (const issue of candidate.issues) {
    if (!issue || typeof issue !== 'object') {
      return null
    }

    const value = issue as { path?: unknown; message?: unknown }

    if (
      !Array.isArray(value.path) ||
      value.path.some((segment) => !['string', 'number', 'symbol'].includes(typeof segment)) ||
      typeof value.message !== 'string'
    ) {
      return null
    }

    issues.push({
      path: value.path.map((segment) => String(segment)).join('.'),
      message: value.message,
    })
  }

  return issues
}
