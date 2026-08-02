const LOCAL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export const isLocalDate = (v: string): boolean => {
  if (!LOCAL_DATE_RE.test(v)) {
    return false
  }
  const [y, m, d] = v.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}
