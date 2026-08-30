import { isIP } from 'node:net'

import { ADDRESS_CLASS, type AddressClass } from './consts'

const RAW_ORIGIN = /^[a-z][a-z\d+.-]*:\/\/[^/?#]+$/i
// eslint-disable-next-line no-control-regex -- raw operator input must not be normalized first
const CONTROL_OR_SPACE = /[\u0000-\u0020\u007f-\u009f]/u

const ipv6ToBytes = (input: string): number[] | null => {
  let value = input.toLowerCase()
  const embedded = /^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(value)

  if (embedded) {
    const ipv4 = embedded[2].split('.').map(Number)

    if (ipv4.some((part) => part > 255)) {
      return null
    }
    value = `${embedded[1]}${((ipv4[0] << 8) | ipv4[1]).toString(16)}:${(
      (ipv4[2] << 8) |
      ipv4[3]
    ).toString(16)}`
  }

  const halves = value.split('::')

  if (halves.length > 2) {
    return null
  }
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const missing = 8 - head.length - tail.length

  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) {
    return null
  }
  const groups = halves.length === 2 ? [...head, ...Array(missing).fill('0'), ...tail] : head

  if (groups.length !== 8) {
    return null
  }
  const bytes: number[] = []

  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) {
      return null
    }
    const number = Number.parseInt(group, 16)
    bytes.push((number >> 8) & 0xff, number & 0xff)
  }

  return bytes
}

const ipv6FromBytes = (bytes: readonly number[]): string => {
  const groups = Array.from({ length: 8 }, (_, index) =>
    ((bytes[index * 2] << 8) | bytes[index * 2 + 1]).toString(16),
  )
  let bestStart = -1
  let bestLength = 0

  for (let start = 0; start < groups.length;) {
    if (groups[start] !== '0') {
      start += 1
      continue
    }
    let end = start + 1

    while (end < groups.length && groups[end] === '0') {
      end += 1
    }
    if (end - start > bestLength && end - start >= 2) {
      bestStart = start
      bestLength = end - start
    }
    start = end
  }

  if (bestStart < 0) {
    return groups.join(':')
  }
  const head = groups.slice(0, bestStart).join(':')
  const tail = groups.slice(bestStart + bestLength).join(':')

  return `${head}::${tail}`
}

const embeddedIpv4 = (bytes: readonly number[]): string =>
  `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`

/** One semantic spelling for every address before any policy comparison. */
export const normalizeIpAddress = (input: string): string | null => {
  const version = isIP(input)

  if (version === 4) {
    return input
      .split('.')
      .map((part) => String(Number(part)))
      .join('.')
  }
  if (version !== 6) {
    return null
  }
  const bytes = ipv6ToBytes(input)

  if (!bytes) {
    return null
  }
  const mapped =
    bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff
  const unspecified = bytes.every((byte) => byte === 0)
  const loopback = bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1
  const compatible = bytes.slice(0, 12).every((byte) => byte === 0) && !unspecified && !loopback
  const nat64 = bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b

  if (mapped || compatible || nat64) {
    return embeddedIpv4(bytes)
  }

  return ipv6FromBytes(bytes)
}

const ipv4Parts = (address: string): number[] => address.split('.').map(Number)

const isAlwaysDeniedCanonical = (address: string): boolean => {
  if (isIP(address) === 4) {
    const [a, b] = ipv4Parts(address)

    return (
      a === 0 ||
      (a === 169 && b === 254) ||
      a >= 224 ||
      address === '168.63.129.16' ||
      address === '100.100.100.200'
    )
  }
  const bytes = ipv6ToBytes(address)

  if (!bytes) {
    return true
  }

  return (
    bytes.every((byte) => byte === 0) ||
    (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) ||
    bytes[0] === 0xff ||
    address === 'fd00:ec2::254'
  )
}

export const classifyIpAddress = (input: string): AddressClass => {
  const address = normalizeIpAddress(input)

  if (!address || isAlwaysDeniedCanonical(address)) {
    return ADDRESS_CLASS.alwaysDenied
  }
  if (isIP(address) === 4) {
    const [a, b] = ipv4Parts(address)

    if (a === 127) {
      return ADDRESS_CLASS.loopback
    }
    if (
      a === 0 ||
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 100 && b >= 64 && b <= 127)
    ) {
      return ADDRESS_CLASS.private
    }

    return ADDRESS_CLASS.public
  }
  const bytes = ipv6ToBytes(address)!

  if (bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1) {
    return ADDRESS_CLASS.loopback
  }
  if (
    (bytes[0] & 0xfe) === 0xfc ||
    // fec0::/10 is the deprecated site-local range. Deprecated does not mean
    // globally routable: deployments still route it inside a site, so it belongs
    // behind the same exact operator admission as ULA/RFC1918.
    (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0xc0)
  ) {
    return ADDRESS_CLASS.private
  }

  return ADDRESS_CLASS.public
}

export const isAlwaysDeniedAddress = (input: string): boolean =>
  classifyIpAddress(input) === ADDRESS_CLASS.alwaysDenied

export const isPrivateAddress = (input: string): boolean => {
  const addressClass = classifyIpAddress(input)

  return addressClass === ADDRESS_CLASS.private || addressClass === ADDRESS_CLASS.loopback
}

const canonicalOriginFromUrl = (url: URL): string => {
  const hostname = url.hostname.startsWith('[')
    ? url.hostname.toLowerCase()
    : url.hostname.toLowerCase().replace(/\.$/, '')

  return `${url.protocol}//${hostname}${url.port ? `:${url.port}` : ''}`
}

/** Parse an exact HTTP(S) origin. Paths and credentials are deliberately not accepted. */
export const canonicalOriginOf = (raw: string): string => {
  if (CONTROL_OR_SPACE.test(raw) || !RAW_ORIGIN.test(raw)) {
    throw new Error('expected an exact HTTP(S) origin')
  }
  let url: URL

  try {
    url = new URL(raw)
  } catch {
    throw new Error('expected an exact HTTP(S) origin')
  }

  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== '' ||
    url.hostname.includes('*')
  ) {
    throw new Error('expected an exact HTTP(S) origin')
  }

  return canonicalOriginFromUrl(url)
}

export const targetOriginOf = (url: URL): string => canonicalOriginFromUrl(url)

/** The only host classes a save path can decide without performing DNS. */
export const literalAddressClassOf = (hostname: string): AddressClass | null => {
  const unbracketed = hostname
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase()

  if (unbracketed === 'localhost') {
    return ADDRESS_CLASS.loopback
  }

  return isIP(unbracketed) ? classifyIpAddress(unbracketed) : null
}
