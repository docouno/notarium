/** Merge authored order with observed keys while keeping the first occurrence.
 * Kept separate because a valid capped detail may carry thousands of key names. */
export const orderedFieldKeys = (
  ordered: readonly string[],
  present: ReadonlySet<string>,
): string[] => {
  const seen = new Set<string>()
  const result: string[] = []

  for (const key of [...ordered, ...present]) {
    if (!seen.has(key)) {
      seen.add(key)
      result.push(key)
    }
  }

  return result
}
