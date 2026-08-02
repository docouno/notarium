import { type ReactNode } from 'react'

// Highlight query-token matches in a result row (#31). The hybrid backend returns
// plain-text snippets with NO match offsets (docs/search.md — the FTS snippet()
// fragment isn't carried as ranges), so the spotlight recomputes matches on the
// client: tokenise the query, case-insensitively split the text, wrap the hits.
// Returns React nodes (never dangerouslySetInnerHTML) — React escapes the text, so
// arbitrary note content can't inject markup. Longest tokens first so a query like
// "graph search" prefers the longer alternative when tokens overlap.

export const highlightMatch = (text: string, query: string): ReactNode => {
  const tokens = query.trim().split(/\s+/).filter(Boolean)

  if (!text || tokens.length === 0) {
    return text
  }
  const alternation = tokens
    .map(escapeRegExp)
    .sort((a, b) => b.length - a.length)
    .join('|')
  // One capturing group → String.split keeps matches at the ODD indices.
  const re = new RegExp(`(${alternation})`, 'ig')
  const parts = text.split(re)

  if (parts.length === 1) {
    return text
  } // no match — avoid a needless node array

  return parts.map((part, i) => (i % 2 === 1 ? <mark key={i}>{part}</mark> : part))
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
