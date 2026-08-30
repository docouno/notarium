import { PROVIDER_LIST_PAGE_SIZE } from '@notarium/contract'

import type { ProviderPagePosition } from '../../../../services/metaDb'

type CursorKey = readonly [string, string]

type ProviderInventoryPage<T> = {
  items: T[]
  total: number
  nextCursor: string | null
}

/** One look-ahead row is the only materialization beyond the public page. */
export const PROVIDER_INVENTORY_FETCH_LIMIT = PROVIDER_LIST_PAGE_SIZE + 1

const encode = (key: CursorKey): string =>
  Buffer.from(JSON.stringify({ v: 1, key }), 'utf8').toString('base64url')

const decode = (value: string | undefined): CursorKey | null | 'invalid' => {
  if (!value) {
    return null
  }

  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown

    if (
      typeof decoded !== 'object' ||
      decoded === null ||
      Array.isArray(decoded) ||
      (decoded as { v?: unknown }).v !== 1
    ) {
      return 'invalid'
    }
    const key = (decoded as { key?: unknown }).key

    return Array.isArray(key) && key.length === 2 && key.every((part) => typeof part === 'string')
      ? [key[0], key[1]]
      : 'invalid'
  } catch {
    return 'invalid'
  }
}

export const providerInventoryAfter = (
  cursor: string | undefined,
): ProviderPagePosition | null | 'invalid' => {
  const key = decode(cursor)
  return key === null || key === 'invalid' ? key : { sort: key[0], id: key[1] }
}

/** Stable keyset page over an already-authorized inventory. Cursors can move
 *  inside that set but never carry identity or authority of their own. */
export const providerInventoryPage = <T>(
  values: readonly T[],
  total: number,
  keyOf: (value: T) => CursorKey,
): ProviderInventoryPage<T> => {
  const window = values.slice(0, PROVIDER_INVENTORY_FETCH_LIMIT)
  const hasMore = window.length > PROVIDER_LIST_PAGE_SIZE
  const items = hasMore ? window.slice(0, PROVIDER_LIST_PAGE_SIZE) : window
  const last = items.at(-1)

  return {
    items,
    total,
    nextCursor: hasMore && last ? encode(keyOf(last)) : null,
  }
}
