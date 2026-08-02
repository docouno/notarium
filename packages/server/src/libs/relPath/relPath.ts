// Fail-closed untrusted-path guard on OUR boundary, before a path reaches an
// engine. An engine may reject traversal too, but that is version behaviour not
// a contract — this guard is what stops an engine swap (P8) opening a hole.

/** Normalise an untrusted engine-relative path to canonical relative form
 *  ('' = space root), or null if it tries to leave the space. `..` is rejected
 *  outright, never resolved. Dot-prefixed segments are rejected too: they are
 *  reserved engine-managed mounts (agent-memory at `.notarium/memory`) — a user
 *  write there would vanish on rescan or poison another mount's class.
 *  canon: docs/note-model.md#agent-memory */
export const safeRelPath = (input: string): string | null => {
  if (input.includes('\0')) {
    return null
  }
  const raw = input.replaceAll('\\', '/')

  if (raw.startsWith('/')) {
    return null
  }
  const parts: string[] = []

  for (const seg of raw.split('/')) {
    if (!seg || seg === '.') {
      continue
    }
    if (seg === '..') {
      return null
    }
    if (seg.startsWith('.')) {
      return null
    }
    parts.push(seg)
  }

  return parts.join('/')
}
