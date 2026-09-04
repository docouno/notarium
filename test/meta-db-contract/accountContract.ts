// The account facet contract, composed over both dialects: the unique keys on
// `users.username` and `users.email` are the arbiter of a collision — a competing
// writer learns WHICH attribute collided instead of a driver error — and a rename
// touches nothing but the account row, because every other carrier keys the person
// by the stable id. canon: docs/auth.md#model

import { describe, expect, it } from 'vitest'

import type { AuthPersistence, UserRecord } from '@notarium/server'

export type AccountContractTarget = {
  auth: AuthPersistence
  teardown: () => Promise<void> | void
}

const AT = '2026-09-03T00:00:00.000Z'

const user = (id: string, username: string, email: string | null = null): UserRecord => ({
  id,
  username,
  email,
  displayName: username,
  passwordHash: null,
  admin: false,
  disabledAt: null,
  createdAt: AT,
  personalSpace: null,
})

export const describeAccountContract = (
  dialect: string,
  setup: () => Promise<AccountContractTarget>,
): void => {
  describe(`AuthPersistence account contract — ${dialect}`, () => {
    const withTarget = async (run: (target: AccountContractTarget) => Promise<void>) => {
      const target = await setup()

      try {
        await run(target)
      } finally {
        await target.teardown()
      }
    }

    it('reports a colliding handle or address as the conflict outcome, never as an error', () =>
      withTarget(async ({ auth }) => {
        expect(await auth.createUser(user('u1', 'alice', 'alice@example.com'))).toEqual({
          status: 'written',
        })
        expect(await auth.createUser(user('u2', 'alice'))).toEqual({
          status: 'conflict',
          field: 'username',
        })
        expect(await auth.createUser(user('u2', 'bob', 'alice@example.com'))).toEqual({
          status: 'conflict',
          field: 'email',
        })
        // Nothing of the refused rows landed.
        expect(await auth.getUserById('u2')).toBeNull()
        expect(await auth.userCount()).toBe(1)
      }))

    it('lets any number of accounts have no address', () =>
      withTarget(async ({ auth }) => {
        expect(await auth.createUser(user('u1', 'alice'))).toEqual({ status: 'written' })
        expect(await auth.createUser(user('u2', 'bob'))).toEqual({ status: 'written' })
        expect((await auth.getUserById('u2'))?.email).toBeNull()
      }))

    it('renames and re-addresses the account row only, and frees the old handle at once', () =>
      withTarget(async ({ auth }) => {
        await auth.createUser(user('u1', 'alice', 'alice@example.com'))
        await auth.insertPat({
          id: 'k1',
          userId: 'u1',
          name: 'Laptop',
          secretHash: 'h',
          scope: 'write',
          spaces: null,
          expiresAt: null,
          lastUsedAt: null,
          revokedAt: null,
          createdAt: AT,
        })
        await auth.upsertMember('space-a', 'u1', 'owner', AT)

        expect(
          await auth.updateUserIdentity('u1', { username: 'alice.smith', email: 'a@example.com' }),
        ).toEqual({ status: 'written' })
        expect(await auth.getUser('alice')).toBeNull()
        expect(await auth.getUser('alice.smith')).toMatchObject({
          id: 'u1',
          username: 'alice.smith',
          email: 'a@example.com',
        })
        // Every carrier still points at the person.
        expect((await auth.listPats('u1')).map((pat) => pat.id)).toEqual(['k1'])
        expect(await auth.grantsFor('u1')).toEqual([{ space: 'space-a', role: 'owner' }])
        expect(await auth.membersOf('space-a')).toEqual([
          { userId: 'u1', username: 'alice.smith', displayName: 'alice', role: 'owner' },
        ])
        // The freed handle is available to the next account immediately.
        expect(await auth.createUser(user('u2', 'alice'))).toEqual({ status: 'written' })
        // Clearing the address is a write of null, distinct from leaving it alone.
        expect(await auth.updateUserIdentity('u1', { email: null })).toEqual({
          status: 'written',
        })
        expect((await auth.getUserById('u1'))?.email).toBeNull()
        expect(await auth.updateUserIdentity('u1', {})).toEqual({ status: 'written' })
        expect((await auth.getUserById('u1'))?.username).toBe('alice.smith')
      }))

    it('refuses a rename onto a live handle or address and keeps the row as it was', () =>
      withTarget(async ({ auth }) => {
        await auth.createUser(user('u1', 'alice', 'alice@example.com'))
        await auth.createUser(user('u2', 'bob', 'bob@example.com'))

        expect(await auth.updateUserIdentity('u2', { username: 'alice' })).toEqual({
          status: 'conflict',
          field: 'username',
        })
        expect(await auth.updateUserIdentity('u2', { email: 'alice@example.com' })).toEqual({
          status: 'conflict',
          field: 'email',
        })
        expect(await auth.getUserById('u2')).toMatchObject({
          username: 'bob',
          email: 'bob@example.com',
        })
      }))

    it('resolves a login by the exact handle or the lower-cased address in one read, handle first', () =>
      withTarget(async ({ auth }) => {
        await auth.createUser(user('u1', 'alice', 'alice@example.com'))
        // A handle written past the schema (admin CLI, before the rule) that is ALSO
        // address-shaped — the only kind of off-schema handle the login shape filter
        // still admits, down its address branch, which is what makes this row reachable
        // from the route at all — and an account whose ADDRESS spells that handle: the
        // handle match wins.
        await auth.createUser(user('u2', 'ops@host.dev'))
        await auth.createUser(user('u3', 'carol', 'ops@host.dev'))

        const lookup = (typed: string) => ({ username: typed, email: typed.toLowerCase() })

        expect((await auth.getUserByLogin(lookup('alice')))?.id).toBe('u1')
        expect((await auth.getUserByLogin(lookup('alice@example.com')))?.id).toBe('u1')
        expect((await auth.getUserByLogin(lookup('Alice@Example.com')))?.id).toBe('u1')
        // The handle is never case-folded; the address arrives already lower-cased,
        // which is the only reason the byte-exact column matches it.
        expect(await auth.getUserByLogin(lookup('Alice'))).toBeNull()
        expect(await auth.getUserByLogin(lookup('nobody'))).toBeNull()
        expect((await auth.getUserByLogin(lookup('ops@host.dev')))?.id).toBe('u2')
      }))

    it('lets exactly one of two concurrent renames onto the same handle win', () =>
      withTarget(async ({ auth }) => {
        await auth.createUser(user('u1', 'alice'))
        await auth.createUser(user('u2', 'bob'))

        const outcomes = await Promise.all([
          auth.updateUserIdentity('u1', { username: 'carol' }),
          auth.updateUserIdentity('u2', { username: 'carol' }),
        ])
        const statuses = outcomes.map((outcome) => outcome.status).sort()

        expect(statuses).toEqual(['conflict', 'written'])
        expect(outcomes.find((outcome) => outcome.status === 'conflict')).toEqual({
          status: 'conflict',
          field: 'username',
        })
        expect((await auth.getUser('carol'))?.id).toMatch(/^u[12]$/)
      }))
  })
}
