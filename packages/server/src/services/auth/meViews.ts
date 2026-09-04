// Auth service author-view: resolve a journal attribution string to a
// privacy-filtered Author. The attribution carries the stable user id; the
// handle a human sees is resolved HERE, at read time, so a rename relabels
// all of history at once. canon: docs/auth.md#model

import { AUTHOR_KIND } from '@notarium/contract'
import type { Author } from '@notarium/contract'

import { parsePrincipalId, PRINCIPAL_SCHEME } from '../../libs/principalId'
import { type AuthCtx } from './authService'

export const createMeViews = (ctx: AuthCtx) => ({
  /** Attribution string → display-ready Author, privacy-filtered relative to
   *  `viewer` (the requesting user's stable id; null in mode 'none'). An id that no
   *  longer resolves — an account gone outside the product — renders as a nameless
   *  author, never as an error: the journal keeps the row, the reader keeps reading. */
  describeAuthor: async (principal: string | null, viewer: string | null): Promise<Author> => {
    if (!principal) {
      return { kind: AUTHOR_KIND.external, name: null, mine: false }
    }
    // mode-none / legacy UI writes: the lone principal is whoever is looking.
    if (principal === 'ui') {
      return { kind: AUTHOR_KIND.user, name: null, mine: true }
    }
    const parsed = parsePrincipalId(principal)

    if (!parsed) {
      return { kind: AUTHOR_KIND.system, name: null, mine: false }
    }
    const mine = viewer != null && parsed.userId === viewer
    // Read the handle only where the answer carries it: since V0 this is a directory
    // read, and the two branches below that answer from the key's own name never need
    // it.
    const ownerName = async (): Promise<string | null> =>
      (await ctx.db.getUserById(parsed.userId))?.username ?? null

    if (parsed.scheme === PRINCIPAL_SCHEME.user) {
      return { kind: AUTHOR_KIND.user, name: await ownerName(), mine }
    }
    if (parsed.scheme === PRINCIPAL_SCHEME.pat) {
      if (mine) {
        const pat = await ctx.db.getPat(parsed.keyId as string)
        return { kind: AUTHOR_KIND.agent, name: pat?.name ?? null, mine: true }
      }

      // Privacy: another user's key — attribute to the owner, never the key name.
      return { kind: AUTHOR_KIND.agent, name: await ownerName(), mine: false }
    }

    // `oauth:<owner>:<tokenId>` — connected app (agent). Token carries no friendly
    // name → own-token shows generic (null); another user's → owner (privacy).
    return { kind: AUTHOR_KIND.agent, name: mine ? null : await ownerName(), mine }
  },
})
