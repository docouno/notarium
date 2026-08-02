export type SpaFallbackDecision = 'serve-spa' | 'not-found' | 'bad-request'
export type SpaRequestDecision = 'continue' | 'not-found' | 'bad-request'

const RESERVED_NAMESPACES = new Set(['api', 'mcp', 'oauth', '.well-known'])
const MAX_DECODE_PASSES = 8

const pathnameOf = (url: string): string => url.split('?', 1)[0]

type CanonicalPath = {
  decoded: string
  segments: string[]
}

// Canonicalise only enough to make a security decision. This is deliberately
// stricter than any one router/static decoder: the SPA shell must never become
// the answer merely because two HTTP layers disagree about encoded separators
// or dot segments.
const canonicalPathOf = (url: string): CanonicalPath | null => {
  let pathname = pathnameOf(url)

  // Fragments never belong in an HTTP request target. Node accepts a raw `#`,
  // while the router and static plugin disagree about how to split it, so reject
  // that ambiguity before either layer sees it.
  if (!pathname.startsWith('/') || pathname.includes('#')) {
    return null
  }

  let decoded = false

  for (let pass = 0; pass < MAX_DECODE_PASSES; pass += 1) {
    let next: string

    try {
      next = decodeURIComponent(pathname)
    } catch {
      // `%25` legitimately becomes a literal `%` after one pass. A malformed
      // escape in the wire URL itself is different: no layer can canonicalise it
      // consistently, so fail closed instead of serving the public shell.
      if (!decoded) {
        return null
      }
      break
    }

    if (next === pathname) {
      break
    }
    decoded = true
    pathname = next

    if (pass === MAX_DECODE_PASSES - 1) {
      return null
    }
  }

  if (
    [...pathname].some((character) => {
      const code = character.charCodeAt(0)
      return code <= 0x1f || code === 0x7f
    })
  ) {
    return null
  }

  const canonical: string[] = []

  for (const segment of pathname.replaceAll('\\', '/').split('/')) {
    if (!segment || segment === '.') {
      continue
    }
    if (segment === '..') {
      canonical.pop()
      continue
    }
    canonical.push(segment)
  }

  return { decoded: pathname, segments: canonical }
}

const isReserved = (segments: string[]): boolean => RESERVED_NAMESPACES.has(segments[0])

const isDirectReservedPath = (url: string): boolean => {
  const [first = ''] = pathnameOf(url).slice(1).split('/', 1)

  return RESERVED_NAMESPACES.has(first)
}

const hasStructuralDotSegment = (pathname: string): boolean =>
  pathname
    .replaceAll('\\', '/')
    .split('/')
    .some((segment) => segment === '.' || segment === '..')

/** Runs before the static plugin. Direct server paths must continue into the
 * router, but a disguised server namespace or structurally ambiguous traversal
 * must be answered before the static layer can turn it into a Forbidden error
 * (or a SPA shell). */
export const spaRequestDecision = (url: string): SpaRequestDecision => {
  const canonical = canonicalPathOf(url)

  if (!canonical) {
    return 'bad-request'
  }
  if (isReserved(canonical.segments) && !isDirectReservedPath(url)) {
    return 'not-found'
  }
  if (canonical.decoded.includes('\\') || hasStructuralDotSegment(canonical.decoded)) {
    return 'bad-request'
  }

  return 'continue'
}

/** The static plugin only runs after the application router misses. Unknown
 * server namespaces still belong to the server and must stay JSON/404; only
 * ordinary browser routes are allowed to receive index.html. */
export const spaFallbackDecision = (url: string): SpaFallbackDecision => {
  const canonical = canonicalPathOf(url)

  if (!canonical) {
    return 'bad-request'
  }

  return isReserved(canonical.segments) ? 'not-found' : 'serve-spa'
}
