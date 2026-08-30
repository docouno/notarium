import type { ProviderInventoryQueryInput } from '@notarium/contract'

/** Provider pages have a fixed server-owned size; the only client-controlled
 * continuation value is the opaque cursor returned by the previous page. */
export const providerInventoryQuery = (query: ProviderInventoryQueryInput = {}): string => {
  const params = new URLSearchParams()

  if (query.cursor) {
    params.set('cursor', query.cursor)
  }
  const encoded = params.toString()
  return encoded ? `?${encoded}` : ''
}
