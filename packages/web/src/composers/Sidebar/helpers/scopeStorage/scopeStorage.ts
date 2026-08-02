import type { ExplorerScope } from '../../../../libs/tree/tree'
import { RECENT_KEY, SCOPE_KEY } from '../../consts'

export const loadScope = (space: string): ExplorerScope => {
  try {
    const raw = localStorage.getItem(SCOPE_KEY + space)

    if (raw) {
      const s = JSON.parse(raw) as Partial<ExplorerScope>

      if (s?.kind === 'files' || s?.kind === 'projects' || s?.kind === 'favorites') {
        return { kind: s.kind }
      }
      if (s?.kind === 'project' && typeof s.path === 'string' && s.path) {
        return { kind: 'project', path: s.path }
      }
    }
  } catch {
    /* malformed or storage blocked — fall through to Files */
  }

  return { kind: 'files' }
}

export const loadRecent = (space: string): string[] => {
  try {
    const raw = localStorage.getItem(RECENT_KEY + space)

    if (raw) {
      const a = JSON.parse(raw) as unknown

      if (Array.isArray(a)) {
        return a.filter((x): x is string => typeof x === 'string').slice(0, 5)
      }
    }
  } catch {
    /* malformed or storage blocked — no recents */
  }

  return []
}
