import type { IncomingHttpHeaders } from 'node:http'

/** The request shape the origin check reads. FastifyRequest satisfies it
 *  structurally, so callers pass the raw request; a unit test builds a literal.
 *  Taking the whole request (not three plucked fields) keeps header selection
 *  from being re-tigered at every call site. */
export type OriginCheckable = {
  method: string
  headers: IncomingHttpHeaders
}

/** Same-origin guard for cookie-auth mutations (the second line after SameSite=Lax):
 *  the browser-set `Origin` must match the host the request addressed. A missing
 *  `Origin` passes on purpose — non-browser clients omit it, and an agent e2e path
 *  depends on that. The host is derived exactly as the REST perimeter does it, so
 *  all three cookie surfaces share one behaviour. canon: docs/auth.md#csrf-and-proxy */
export const isCrossOrigin = (req: OriginCheckable): boolean => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    return false
  }
  const origin = req.headers.origin

  if (!origin) {
    return false
  }
  const forwarded = req.headers['x-forwarded-host']
  const host =
    (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0].trim() || req.headers.host

  try {
    return new URL(origin).host !== host
  } catch {
    return true
  }
}
