// CIMD client-metadata fetcher: client_id is an https URL we fetch + validate; caller caches it.
// canon: docs/mcp-oauth.md#client-registration-cimd-first-dcr · docs/mcp-oauth.md#security

import { Resolver } from 'node:dns/promises'
import { isIP } from 'node:net'

const FETCH_TIMEOUT_MS = 8_000
const MAX_BYTES = 64 * 1024

/** Expand an IPv6 literal to its 16 bytes. */
const ipv6ToBytes = (ip: string): number[] | null => {
  let s = ip.toLowerCase()
  // Normalize a trailing embedded IPv4 to two hextets so dotted and hex forms collapse to one path.
  const m = /^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(s)

  if (m) {
    const v4 = m[2].split('.').map(Number)

    if (v4.some((n) => n > 255)) {
      return null
    }
    s = `${m[1]}${(((v4[0] << 8) | v4[1]) >>> 0).toString(16)}:${(((v4[2] << 8) | v4[3]) >>> 0).toString(16)}`
  }
  const halves = s.split('::')

  if (halves.length > 2) {
    return null
  }
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : null
  const groups = tail ? [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail] : head

  if (groups.length !== 8) {
    return null
  }
  const bytes: number[] = []

  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) {
      return null
    }
    const n = parseInt(g, 16)
    bytes.push((n >> 8) & 0xff, n & 0xff)
  }

  return bytes
}

/** True if `ip` is a loopback/private/link-local/metadata address. */
const isPrivateAddress = (ip: string): boolean => {
  const v = isIP(ip)

  if (v === 4) {
    const [a, b] = ip.split('.').map(Number)
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) || // link-local (incl. 169.254.169.254 metadata)
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) // CGNAT
    )
  }
  if (v === 6) {
    const by = ipv6ToBytes(ip)

    if (!by) {
      return true
    } // unparseable → fail closed
    if (by.every((x) => x === 0)) {
      return true
    } // :: unspecified
    if (by.slice(0, 15).every((x) => x === 0) && by[15] === 1) {
      return true
    } // ::1 loopback
    if (by[0] === 0xfe && (by[1] & 0xc0) === 0x80) {
      return true
    } // fe80::/10 link-local
    if ((by[0] & 0xfe) === 0xfc) {
      return true
    } // fc00::/7 unique-local
    // Mapped/compatible/NAT64: re-check the embedded IPv4 in the trailing 4 bytes.
    const mapped = by.slice(0, 10).every((x) => x === 0) && by[10] === 0xff && by[11] === 0xff
    const compat = by.slice(0, 12).every((x) => x === 0)
    const nat64 = by[0] === 0x00 && by[1] === 0x64 && by[2] === 0xff && by[3] === 0x9b

    if (mapped || compat || nat64) {
      return isPrivateAddress(`${by[12]}.${by[13]}.${by[14]}.${by[15]}`)
    }

    return false
  }

  return false
}

/** Fetch + parse a CIMD document at `url`. Throws on any guard failure. */
export const fetchClientMetadataDocument = async (url: string): Promise<unknown> => {
  let u: URL

  try {
    u = new URL(url)
  } catch {
    throw new Error('client_id is not a valid URL')
  }
  if (u.protocol !== 'https:') {
    throw new Error('client metadata URL must be https')
  }
  if (u.hostname === 'localhost') {
    throw new Error('client metadata host is not allowed')
  }

  const resolver = new Resolver()

  return withTimeout(
    async (signal) => {
      // URL.hostname keeps the brackets on an IPv6 literal (`[::1]`); strip them so isIP recognises it.
      const host = u.hostname.replace(/^\[|\]$/g, '')

      // Reject private targets BEFORE fetching.
      // RESIDUAL: DNS-rebinding TOCTOU (`fetch` re-resolves) — production control is egress filtering.
      if (isIP(host)) {
        if (isPrivateAddress(host)) {
          throw new Error('client metadata host is not allowed')
        }
      } else {
        const answers = await Promise.allSettled([resolver.resolve4(host), resolver.resolve6(host)])
        const addrs = answers.flatMap((answer) =>
          answer.status === 'fulfilled' ? answer.value : [],
        )

        if (!addrs.length) {
          throw new Error('client metadata host did not resolve')
        }
        if (addrs.some(isPrivateAddress)) {
          throw new Error('client metadata host is not allowed')
        }
      }

      const res = await fetch(u.toString(), {
        method: 'GET',
        redirect: 'error', // a redirect could dodge the host guard
        headers: { accept: 'application/json' },
        signal,
      })

      if (!res.ok) {
        throw new Error(`client metadata fetch returned ${res.status}`)
      }
      const text = await readCapped(res, MAX_BYTES)
      return JSON.parse(text)
    },
    () => resolver.cancel(),
  )
}

/** One wall-clock budget covers DNS validation and the HTTP fetch. The dedicated
 *  Resolver cancels preflight DNS; AbortController stops fetch/body work. */
const withTimeout = async <T>(
  work: (signal: AbortSignal) => Promise<T>,
  cancel: () => void,
): Promise<T> => {
  const ctrl = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      cancel()
      ctrl.abort()
      reject(new Error('client metadata fetch timed out'))
    }, FETCH_TIMEOUT_MS)
  })

  try {
    return await Promise.race([work(ctrl.signal), timeout])
  } finally {
    clearTimeout(timer)
  }
}

/** Read at most `max` bytes of the body, then abort — a hostile/runaway document can't exhaust memory. */
const readCapped = async (res: Response, max: number): Promise<string> => {
  const reader = res.body?.getReader()

  if (!reader) {
    return res.text()
  }
  const chunks: Uint8Array[] = []
  let total = 0

  for (;;) {
    const { done, value } = await reader.read()

    if (done) {
      break
    }
    if (value) {
      total += value.byteLength
      if (total > max) {
        await reader.cancel().catch(() => {})
        throw new Error('client metadata document is too large')
      }
      chunks.push(value)
    }
  }

  return Buffer.concat(chunks).toString('utf8')
}
