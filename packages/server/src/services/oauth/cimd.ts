// CIMD client-metadata fetcher: client_id is an https URL we fetch + validate; caller caches it.
// canon: docs/mcp-oauth.md#client-registration-cimd-first-dcr · docs/mcp-oauth.md#security

import { Resolver } from 'node:dns/promises'
import { isIP } from 'node:net'

import { isAlwaysDeniedAddress, isPrivateAddress } from '../../libs/originPolicy'

const FETCH_TIMEOUT_MS = 8_000
const MAX_BYTES = 64 * 1024

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
        if (isPrivateAddress(host) || isAlwaysDeniedAddress(host)) {
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
        if (addrs.some((address) => isPrivateAddress(address) || isAlwaysDeniedAddress(address))) {
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
