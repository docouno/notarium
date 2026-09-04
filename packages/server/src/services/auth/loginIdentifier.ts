// Step 0 of login: the free shape filter, and the one lookup it yields. An input
// that is neither handle-shaped nor address-shaped names no account, so it is
// refused before any read, any hash and any counter entry — indistinguishably
// from a wrong pair. canon: docs/auth.md#credentials

import { EmailSchema, UsernameSchema } from '@notarium/contract'

export type LoginLookup = {
  /** The handle as typed — never case-folded, so `Bob` does not sign in as `bob` and a
   *  handle whose only deviation from the schema is its case (an admin-CLI account from
   *  before the rule) keeps signing in by its exact spelling. The shape filter below is
   *  case-insensitive but not otherwise loosened, so an off-schema legacy handle reaches
   *  the read only when it is ALSO address-shaped (`ops@host.dev`) — down the address
   *  branch, where it is still resolved by its exact spelling and wins over anyone who
   *  owns that address. Anything else is refused before any read. */
  username: string
  /** The address lower-cased, the way the column stores it. */
  email: string
  /** What the failure counter keys on when the lookup resolves to nobody. */
  key: string
}

/** The handle shape is the REST schema's, tested case-insensitively — a superset,
 *  so no existing handle is locked out; the address shape is the e-mail schema. */
export const loginLookupOf = (identifier: string): LoginLookup | null => {
  const typed = identifier.trim()

  if (UsernameSchema.safeParse(typed.toLowerCase()).success) {
    return { username: typed, email: typed.toLowerCase(), key: typed }
  }
  const address = EmailSchema.safeParse(typed)

  if (address.success) {
    return { username: typed, email: address.data, key: address.data }
  }

  return null
}
