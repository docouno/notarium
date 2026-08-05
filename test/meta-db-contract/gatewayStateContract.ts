// One executable contract for the MCP gateway persistence port. The in-memory
// fake is the reference twin; SQLite and Postgres must expose the same observable
// write-retry idempotency semantics.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type {
  DedupResult,
  GatewayStatePersistence,
} from '../../packages/server/src/services/metaDb/types'

export type GatewayStateContractFactory = () => Promise<{
  persistence: GatewayStatePersistence
  teardown?: () => Promise<void>
}>

export const describeGatewayStateContract = (
  name: string,
  factory: GatewayStateContractFactory,
): void => {
  describe(`GatewayStatePersistence contract — ${name}`, { timeout: 15_000 }, () => {
    let persistence: GatewayStatePersistence
    let teardown: (() => Promise<void>) | undefined

    beforeEach(async () => {
      ;({ persistence, teardown } = await factory())
    })

    afterEach(async () => {
      await teardown?.()
    })

    it('uses strict dedup window/prune boundaries and upserts one scope+key in place', async () => {
      const first: DedupResult = { noteId: 'note-first', versionToken: 'v1:first' }
      const replacement: DedupResult = {
        noteId: 'note-replacement',
        versionToken: 'v1:replacement',
      }
      const otherScope: DedupResult = {
        noteId: 'note-other-scope',
        versionToken: 'v1:other-scope',
      }
      const exact: DedupResult = { noteId: 'note-exact', versionToken: 'v1:exact' }
      const newer: DedupResult = { noteId: 'note-newer', versionToken: 'v1:newer' }
      const expired: DedupResult = { noteId: 'note-expired', versionToken: 'v1:expired' }

      await persistence.dedupPut('idem:alice:create', 'same-key', first, '2026-06-12T10:00:00.000Z')
      expect(
        await persistence.dedupGet('idem:alice:create', 'same-key', '2026-06-12T09:59:59.999Z'),
      ).toEqual(first)
      // The window is deliberately strict: created_at > since, never >=.
      expect(
        await persistence.dedupGet('idem:alice:create', 'same-key', '2026-06-12T10:00:00.000Z'),
      ).toBeNull()

      await persistence.dedupPut(
        'idem:alice:create',
        'same-key',
        replacement,
        '2026-06-12T10:02:00.000Z',
      )
      await persistence.dedupPut(
        'idem:bob:create',
        'same-key',
        otherScope,
        '2026-06-12T10:04:00.000Z',
      )
      await persistence.dedupPut(
        'idem:alice:create',
        'exact-boundary',
        exact,
        '2026-06-12T10:01:00.000Z',
      )
      await persistence.dedupPut('idem:alice:create', 'newer', newer, '2026-06-12T10:03:00.000Z')
      await persistence.dedupPut(
        'idem:alice:create',
        'expired',
        expired,
        '2026-06-12T10:00:59.999Z',
      )

      expect(
        await persistence.dedupGet('idem:alice:create', 'same-key', '2026-06-12T10:01:59.999Z'),
      ).toEqual(replacement)
      expect(
        await persistence.dedupGet('idem:bob:create', 'same-key', '2026-06-12T00:00:00.000Z'),
      ).toEqual(otherScope)

      // Pruning is also strict: created_at < before. A row exactly on the
      // boundary survives until the next pass.
      expect(
        await persistence.dedupGet('idem:alice:create', 'expired', '2026-06-12T00:00:00.000Z'),
      ).toEqual(expired)
      await persistence.dedupPrune('2026-06-12T10:01:00.000Z')
      expect(
        await persistence.dedupGet('idem:alice:create', 'expired', '2026-06-12T00:00:00.000Z'),
      ).toBeNull()
      expect(
        await persistence.dedupGet(
          'idem:alice:create',
          'exact-boundary',
          '2026-06-12T00:00:00.000Z',
        ),
      ).toEqual(exact)
      expect(
        await persistence.dedupGet('idem:alice:create', 'newer', '2026-06-12T00:00:00.000Z'),
      ).toEqual(newer)
      expect(
        await persistence.dedupGet('idem:alice:create', 'same-key', '2026-06-12T00:00:00.000Z'),
      ).toEqual(replacement)
      expect(
        await persistence.dedupGet('idem:bob:create', 'same-key', '2026-06-12T00:00:00.000Z'),
      ).toEqual(otherScope)
    })
  })
}
