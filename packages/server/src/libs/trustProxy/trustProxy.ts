import { isIP } from 'node:net'

/** Parse the explicit proxy IP/CIDR allowlist accepted by Fastify. An empty value
 *  keeps forwarded headers untrusted; booleans and hop counts are deliberately
 *  unavailable so an operator cannot accidentally trust the public Internet. */
export const trustProxyFromEnv = (raw: string | undefined): false | string[] => {
  if (!raw?.trim()) {
    return false
  }
  const entries = raw.split(',').map((entry) => entry.trim())

  if (entries.some((entry) => !entry)) {
    throw new Error('TRUST_PROXY must be a comma-separated IP/CIDR allowlist')
  }

  for (const entry of entries) {
    const slash = entry.lastIndexOf('/')
    const address = slash < 0 ? entry : entry.slice(0, slash)
    const family = isIP(address)

    if (!family) {
      throw new Error(`TRUST_PROXY contains an invalid IP/CIDR: "${entry}"`)
    }
    if (slash < 0) {
      continue
    }
    const prefix = entry.slice(slash + 1)
    const max = family === 4 ? 32 : 128

    if (!/^\d+$/.test(prefix) || Number(prefix) < 1 || Number(prefix) > max) {
      throw new Error(`TRUST_PROXY contains an invalid IP/CIDR: "${entry}"`)
    }
  }

  return entries
}
