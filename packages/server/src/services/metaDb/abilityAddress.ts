// What a durable ability ADDRESS is asked, outside the facet that stores it: which
// package does it name, and whose Space is that package in? Both are read out of the
// locator itself, because a locator is the only thing the writers of these tables share
// — a placement move carries no owner and no registry note, only two addresses.
//
// It lives here rather than in either driver for the same reason `abilityLifecycle`
// does: two dialects and a twin ask the same question, and a question re-derived per
// implementation is how they come to disagree.
// canon: docs/meta-db.md#source-of-truth

import { parseAbilityLocator } from '@notarium/core'

/** The PACKAGE an address names — everything about the locator except where the
 *  package currently stands.
 *
 *  It is the key the L4p advisory is taken on, and the placement is left out on
 *  purpose: a move changes the placement, so a key that included it would put the two
 *  writers of a moving package on two different stripes at the exact moment they have
 *  to meet — the move on both spellings, an owner's `setEnabled` on whichever one its
 *  caller still holds. The package is the one thing both name in either order.
 *
 *  A locator this host cannot parse is its own key: an address nothing can read is an
 *  address nothing can move, so serializing it as itself serializes it with itself. */
export const abilityPackageOfLocator = (locator: string): string => {
  const parsed = parseAbilityLocator(locator)

  if (!parsed) {
    return locator
  }

  return parsed.source === 'owned'
    ? `owned:${parsed.kind}:${parsed.location.spaceId}:${parsed.packageId}`
    : `${parsed.source}:${parsed.kind}:${parsed.packageId}`
}

/** The Space an OWNED address belongs to, and null for anything else — a System
 *  package has no Space to be purged with, and neither has an address this host cannot
 *  read. The lifecycle key of a row keyed by an address, in other words: the sweeps of
 *  these tables are by Space, and a row nobody can attribute to one cannot be swept. */
export const abilitySpaceOfLocator = (locator: string): string | null => {
  const parsed = parseAbilityLocator(locator)

  return parsed?.source === 'owned' ? parsed.location.spaceId : null
}
