import { describe, expect, it } from 'vitest'

import { EmailSchema, MePatchRequestSchema, UsernameSchema } from './auth'

// The handle rule is a superset of the earlier `[a-z0-9-]` one — every existing
// handle must stay valid — and it only constrains the EDGES: separators may run
// inside in any number and combination. Case is refused, never folded.
describe('UsernameSchema', () => {
  it.each(['bob.smith', 'bob_smith', 'bob-smith', 'bob..smith', 'a', 'a--b', 'a'.repeat(32)])(
    'accepts %s',
    (value) => {
      expect(UsernameSchema.safeParse(value).success).toBe(true)
    },
  )

  it.each(['.bob', 'bob.', '-bob', 'bob_', 'Bob', 'bo b', 'bob@smith', 'a'.repeat(33), ''])(
    'rejects %j',
    (value) => {
      expect(UsernameSchema.safeParse(value).success).toBe(false)
    },
  )
})

// The address is normalised on the way in — the stored, compared and shown value
// is one and the same — and bounded by the RFC maximum.
describe('EmailSchema', () => {
  it('trims and lower-cases', () => {
    expect(EmailSchema.parse('  Sergey@Padurets.com  ')).toBe('sergey@padurets.com')
  })

  it.each(['bob', 'bob@', '@example.com', `${'a'.repeat(250)}@example.com`])(
    'rejects %j',
    (value) => {
      expect(EmailSchema.safeParse(value).success).toBe(false)
    },
  )
})

describe('MePatchRequestSchema', () => {
  it('tells "clear the address" (null) apart from "leave it" (absent)', () => {
    expect(MePatchRequestSchema.parse({ email: null })).toEqual({ email: null })
    expect(MePatchRequestSchema.parse({})).toEqual({})
    expect(MePatchRequestSchema.parse({ username: 'bob.smith' })).toEqual({
      username: 'bob.smith',
    })
  })
})
