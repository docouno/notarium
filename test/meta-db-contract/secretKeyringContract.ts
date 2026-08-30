import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CREDENTIAL_KEY_STATE } from '../../packages/server/src/services/credentialKeyring'
import type {
  SecretKeyringPersistence,
  SecretKeyringRecord,
} from '../../packages/server/src/services/metaDb'

const record = (
  keyId: string,
  generation: number,
  over: Partial<SecretKeyringRecord> = {},
): SecretKeyringRecord => ({
  keyId,
  canary: `v1.${keyId}.Y2lwaGVydGV4dA`,
  state: CREDENTIAL_KEY_STATE.readable,
  generation,
  createdAt: `2026-08-22T00:00:0${generation}.000Z`,
  retiredAt: null,
  ...over,
})

export const describeSecretKeyringContract = (
  name: string,
  factory: () => Promise<{
    persistence: SecretKeyringPersistence
    teardown?: () => Promise<void>
  }>,
): void => {
  describe(`Secret keyring contract — ${name}`, () => {
    let persistence: SecretKeyringPersistence
    let teardown: (() => Promise<void>) | undefined

    beforeEach(async () => {
      ;({ persistence, teardown } = await factory())
      await persistence.init()
    })

    afterEach(async () => teardown?.())

    it('admits one immutable readable witness idempotently', async () => {
      const first = record('ck_111111111111111111111111', 1)

      await expect(persistence.admitReadable(first)).resolves.toMatchObject({
        status: 'inserted',
        record: first,
      })
      await expect(persistence.admitReadable(first)).resolves.toMatchObject({
        status: 'present',
        record: first,
      })
      expect(await persistence.list()).toEqual([first])
      expect(await persistence.active()).toEqual([])
    })

    it('refuses a reused key id or generation with a different witness', async () => {
      const first = record('ck_111111111111111111111111', 1)
      await persistence.admitReadable(first)

      await expect(
        persistence.admitReadable({ ...first, canary: `${first.canary}x` }),
      ).resolves.toEqual({ status: 'conflict' })
      await expect(
        persistence.admitReadable(record('ck_222222222222222222222222', 1)),
      ).resolves.toEqual({ status: 'conflict' })
      expect(await persistence.list()).toEqual([first])
    })

    it('projects the pointer target and demotes the previous active row atomically', async () => {
      const first = record('ck_111111111111111111111111', 1)
      const second = record('ck_222222222222222222222222', 2)
      await persistence.admitReadable(first)
      await persistence.projectActive({ keyId: first.keyId, generation: 1 })
      await persistence.admitReadable(second)

      await expect(
        persistence.projectActive({ keyId: second.keyId, generation: 2 }),
      ).resolves.toMatchObject({
        status: 'projected',
        record: { ...second, state: CREDENTIAL_KEY_STATE.active },
      })
      expect(await persistence.list()).toEqual([
        { ...first, state: CREDENTIAL_KEY_STATE.readable },
        { ...second, state: CREDENTIAL_KEY_STATE.active },
      ])
      expect(await persistence.active()).toEqual([
        { ...second, state: CREDENTIAL_KEY_STATE.active },
      ])
    })

    it('distinguishes a missing target from a generation mismatch', async () => {
      const first = record('ck_111111111111111111111111', 1)
      await persistence.admitReadable(first)

      await expect(
        persistence.projectActive({
          keyId: 'ck_222222222222222222222222',
          generation: 2,
        }),
      ).resolves.toEqual({ status: 'missing' })
      await expect(
        persistence.projectActive({ keyId: first.keyId, generation: 2 }),
      ).resolves.toMatchObject({ status: 'generation-conflict', record: first })
    })

    it('publishes a rotation pointer only while the expected active row is fenced', async () => {
      const first = record('ck_111111111111111111111111', 1)
      const second = record('ck_222222222222222222222222', 2)
      await persistence.admitReadable(first)
      await persistence.projectActive({ keyId: first.keyId, generation: 1 })
      await persistence.admitReadable(second)
      let publications = 0

      await expect(
        persistence.projectRotationActive(
          { expectedKeyId: 'ck_333333333333333333333333', keyId: second.keyId, generation: 2 },
          async () => void (publications += 1),
        ),
      ).resolves.toEqual({ status: 'active-changed', activeKeyId: first.keyId })
      expect(publications).toBe(0)
      await expect(
        persistence.projectRotationActive(
          { expectedKeyId: first.keyId, keyId: second.keyId, generation: 2 },
          async () => void (publications += 1),
        ),
      ).resolves.toMatchObject({
        status: 'projected',
        record: { keyId: second.keyId, state: CREDENTIAL_KEY_STATE.active },
      })
      expect(publications).toBe(1)
    })

    it('reissues only the live projection when no ciphertext survives', async () => {
      const first = record('ck_111111111111111111111111', 1)
      const second = record('ck_222222222222222222222222', 2)
      await persistence.admitReadable(first)
      await persistence.projectActive({ keyId: first.keyId, generation: 1 })

      await persistence.replaceNonRetiredWith(second)

      expect(await persistence.list()).toEqual([{ ...second, state: CREDENTIAL_KEY_STATE.active }])
    })
  })
}
