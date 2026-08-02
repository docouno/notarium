import { afterAll, beforeAll, expect, it } from 'vitest'

import { PgMetaDb } from '../../packages/server/src/services/metaDb/pgMetaDb'
import type { OAuthClientRecord } from '../../packages/server/src/services/metaDb/types'
import {
  createPostgresTestSchema,
  describePostgres,
  type PostgresTestSchema,
} from '../meta-db-contract/postgresHarness'

describePostgres('Postgres OAuth client lifecycle', () => {
  let db: PgMetaDb
  let scopedUrl: string
  let testSchema: PostgresTestSchema | undefined

  const client = (id: string, over: Partial<OAuthClientRecord> = {}): OAuthClientRecord => ({
    clientId: id,
    kind: 'dcr',
    redirectUris: [`https://client.example/${id}`],
    clientName: id,
    createdAt: '2026-07-22T00:00:00.000Z',
    lastSeen: '2026-07-22T00:00:00.000Z',
    activatedAt: null,
    ...over,
  })

  beforeAll(async () => {
    testSchema = await createPostgresTestSchema('oauth_lifecycle')
    ;({ db, scopedUrl } = testSchema)
    await db.oauth.upsertClient(
      client('ntcli_existing', {
        clientName: 'Existing integration',
        createdAt: '2026-01-01T00:00:00Z',
        lastSeen: '2026-01-01T00:00:00Z',
        activatedAt: '2026-01-01T00:00:00Z',
      }),
    )
  }, 30_000)

  afterAll(async () => {
    await testSchema?.teardown()
  })

  it('preserves activated clients and serializes quota across independent pools', async () => {
    expect((await db.oauth.getClient('ntcli_existing'))?.activatedAt).toBe('2026-01-01T00:00:00Z')

    const secondDb = new PgMetaDb(scopedUrl)

    try {
      const cutoff = '2026-07-21T00:00:00.000Z'
      const results = await Promise.all([
        db.oauth.upsertPendingClient(client('one'), 1, cutoff),
        secondDb.oauth.upsertPendingClient(client('two'), 1, cutoff),
      ])
      expect(results.filter(Boolean)).toHaveLength(1)
      const accepted = results[0] ? 'one' : 'two'
      const rejected = accepted === 'one' ? 'two' : 'one'

      expect(
        await db.oauth.activateClient(
          accepted,
          '2026-07-22T00:01:00.000Z',
          '2026-07-21T00:01:00.000Z',
        ),
      ).toBe(true)
      expect(await secondDb.oauth.upsertPendingClient(client(rejected), 1, cutoff)).toBe(true)
      expect((await db.oauth.getClient(accepted))?.activatedAt).toBe('2026-07-22T00:01:00.000Z')
      expect((await db.oauth.getClient(accepted))?.lastSeen).toBe('2026-07-22T00:00:00.000Z')
    } finally {
      await secondDb.close()
    }
  })
})
