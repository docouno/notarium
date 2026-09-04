import { describe, expect, it } from 'vitest'

import { loginLookupOf } from '../../packages/server/src/services/auth/loginIdentifier'

// Step 0 of login: what the free shape filter lets through, and how it normalises.
// canon: docs/auth.md#credentials
describe('loginLookupOf', () => {
  it('keeps a handle as typed and offers it as an address only lower-cased', () => {
    expect(loginLookupOf('bob.smith')).toEqual({
      username: 'bob.smith',
      email: 'bob.smith',
      key: 'bob.smith',
    })
    // Case is never folded on the handle: `Bob` must not reach `bob`. The shape test
    // is case-insensitive so a handle written past the schema still gets a lookup.
    expect(loginLookupOf(' Admin ')).toEqual({ username: 'Admin', email: 'admin', key: 'Admin' })
  })

  it('lower-cases and trims an address, and offers it as a handle untouched', () => {
    expect(loginLookupOf('  Bob@Example.COM ')).toEqual({
      username: 'Bob@Example.COM',
      email: 'bob@example.com',
      key: 'bob@example.com',
    })
  })

  it.each(['', ' ', 'bob@', '@example.com', 'bob smith', '.bob', 'a'.repeat(33), '?'.repeat(320)])(
    'refuses %j — neither a handle nor an address',
    (typed) => {
      expect(loginLookupOf(typed)).toBeNull()
    },
  )
})
