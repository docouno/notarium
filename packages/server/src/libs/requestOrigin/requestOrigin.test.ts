import type { IncomingHttpHeaders } from 'node:http'
import { describe, expect, it } from 'vitest'

import { isCrossOrigin } from './requestOrigin'

const req = (method: string, headers: IncomingHttpHeaders) => ({ method, headers })

describe('isCrossOrigin', () => {
  it.each([
    // safe methods never guard — Origin is irrelevant
    ['GET', 'https://evil.example', 'app.local', undefined, false],
    ['HEAD', 'https://evil.example', 'app.local', undefined, false],
    ['OPTIONS', 'https://evil.example', 'app.local', undefined, false],
    // a missing Origin passes (non-browser clients omit it)
    ['POST', undefined, 'app.local', undefined, false],
    // same-origin, direct and behind a forwarding proxy
    ['POST', 'https://app.local', 'app.local', undefined, false],
    ['POST', 'https://app.local', 'internal:3000', 'app.local', false],
    ['POST', 'https://app.local', 'internal:3000', 'app.local, proxy.local', false],
    ['POST', 'https://app.local', 'internal:3000', ['app.local', 'proxy.local'], false],
    // pins .split(',') INSIDE the array branch, not only the string one
    ['POST', 'https://app.local', 'internal:3000', ['app.local, proxy.local', 'x'], false],
    // genuine cross-origin
    ['POST', 'https://evil.example', 'app.local', undefined, true],
    // a port is part of URL.host — a mismatched port is cross-origin
    ['POST', 'https://app.local:8443', 'app.local', undefined, true],
    // an unparseable Origin fails closed
    ['POST', 'not-a-url', 'app.local', undefined, true],
  ] as const)('%s origin=%s host=%s xfh=%s → %s', (method, origin, host, xfh, expected) => {
    const headers: IncomingHttpHeaders = { host }

    if (origin !== undefined) {
      headers.origin = origin
    }
    if (xfh !== undefined) {
      headers['x-forwarded-host'] = xfh as string | string[]
    }
    expect(isCrossOrigin(req(method, headers))).toBe(expected)
  })
})
