import { AUTHOR_KIND } from '@notarium/contract'
import type { Author } from '@notarium/contract'
import type { AuthorFilter } from '@notarium/core'

type Describe = (principal: string | null, viewer: string | null) => Promise<Author>

/** Principal predicate for "my activity": the AuthorFilter twin of describeAuthor's
 *  `mine` test (keep in sync). Prefix (not exact) match on the key id → a since-deleted
 *  PAT's old revisions still count as mine. Usernames are `[a-z0-9-]` (no `:` / LIKE
 *  wildcard), so a prefix matches one owner unambiguously.
 *  canon: docs/auth.md#model */
export const minePrincipalFilter = (viewer: string | null): AuthorFilter => {
  const exact = viewer ? ['ui', `user:${viewer}`] : ['ui']
  const prefixes = viewer ? [`pat:${viewer}:`, `oauth:${viewer}:`] : []
  return { exact, prefixes }
}

/** Redact the raw `principal` from this viewer? True only for another user's agent —
 *  its `pat:<owner>:<patId>` carries an opaque cross-user key id (anti-enumeration). */
export const redactsKeyId = (a: Author): boolean => a.kind === AUTHOR_KIND.agent && !a.mine

/** Resolve a privacy-filtered `author` for each row's journal `principal`, per `viewer`.
 *  Callers get a null `principal` for a foreign agent's rows: its opaque key id must not
 *  ship to other members (anti-enumeration). */
export const withAuthors = async <T extends { principal: string | null }>(
  items: readonly T[],
  viewer: string | null,
  describe: Describe,
): Promise<Array<T & { author: Author }>> => {
  const cache = new Map<string | null, Author>()
  const out: Array<T & { author: Author }> = []

  for (const it of items) {
    let author = cache.get(it.principal)

    if (author === undefined) {
      author = await describe(it.principal, viewer)
      cache.set(it.principal, author)
    }
    out.push({ ...it, principal: redactsKeyId(author) ? null : it.principal, author })
  }

  return out
}
