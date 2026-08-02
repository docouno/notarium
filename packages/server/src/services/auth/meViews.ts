// Auth service author-view: resolve a journal attribution string to a
// privacy-filtered Author. canon: docs/auth.md#model

import { AUTHOR_KIND } from '@notarium/contract'
import type { Author } from '@notarium/contract'

import { type AuthCtx } from './authService'

export const createMeViews = (ctx: AuthCtx) => ({
  /** Attribution string → display-ready Author, privacy-filtered relative to
   *  `viewer` (requesting username; null in mode 'none'). */
  describeAuthor: async (principal: string | null, viewer: string | null): Promise<Author> => {
    if (!principal) {
      return { kind: AUTHOR_KIND.external, name: null, mine: false }
    }
    // mode-none / legacy UI writes: the lone principal is whoever is looking.
    if (principal === 'ui') {
      return { kind: AUTHOR_KIND.user, name: null, mine: true }
    }
    const sep = principal.indexOf(':')
    const scheme = sep === -1 ? principal : principal.slice(0, sep)
    const rest = sep === -1 ? '' : principal.slice(sep + 1)

    if (scheme === 'user') {
      const name = rest || null
      return { kind: AUTHOR_KIND.user, name, mine: name != null && name === viewer }
    }
    if (scheme === 'pat') {
      // `pat:<owner>:<patId>` — the id is the last segment (no colons in it).
      const lastColon = rest.lastIndexOf(':')
      const owner = lastColon === -1 ? rest : rest.slice(0, lastColon)
      const patId = lastColon === -1 ? '' : rest.slice(lastColon + 1)
      const mine = owner !== '' && owner === viewer

      if (mine) {
        const pat = patId ? await ctx.db.getPat(patId) : null
        return { kind: AUTHOR_KIND.agent, name: pat?.name ?? null, mine: true }
      }

      // Privacy: another user's key — attribute to the owner, never the key name.
      return { kind: AUTHOR_KIND.agent, name: owner || null, mine: false }
    }
    if (scheme === 'oauth') {
      // `oauth:<owner>:<tokenId>` — connected app (agent). Token carries no friendly
      // name → own-token shows generic (null); another user's → owner (privacy).
      const lastColon = rest.lastIndexOf(':')
      const owner = lastColon === -1 ? rest : rest.slice(0, lastColon)
      const mine = owner !== '' && owner === viewer
      return { kind: AUTHOR_KIND.agent, name: mine ? null : owner || null, mine }
    }

    return { kind: AUTHOR_KIND.system, name: null, mine: false }
  },
})
