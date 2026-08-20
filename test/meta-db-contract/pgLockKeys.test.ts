/**
 * The two lock helpers that take MORE than one key, held to the order they promise —
 * portable, because a fake client is enough to see the order and no database is needed
 * to have an opinion about it.
 *
 * WHY: a helper that names two keys is a deadlock waiting for its mirror image. Both of
 * these say so in their own docblocks ("sorted, because a move names TWO of them: two
 * moves with mirrored pairs would otherwise each hold the other's first key and
 * Postgres would answer `40P01`"), and neither sort was observed by anything: the pair
 * matrix in `pgLockPairs.test.ts` runs ONE `run` per transaction, so both sides of a
 * pair always name the same two keys in the same two positions — a mirrored pair is
 * not expressible in it at all. Removing `.sort()` from either helper left every gate
 * of this repository green.
 *
 * What a fake client can see is exactly what matters here: which keys were asked for,
 * in which order, and how many times.
 */
import type { PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'

import { abilityPackageOfLocator } from '../../packages/server/src/services/metaDb/abilityAddress'
import {
  lockAbilityPreferencePackages,
  lockScopePinTargets,
} from '../../packages/server/src/services/metaDb/drivers/pg/lockOrder'

/** A client that answers nothing and remembers everything: these two helpers only
 *  ever take advisory locks, and an advisory lock returns no rows worth having. */
const recordingClient = (): { client: PoolClient; keys: () => unknown[] } => {
  const taken: unknown[] = []

  return {
    client: {
      query: async (_text: string, values: readonly unknown[] = []) => {
        taken.push(values[1])

        return { rows: [] }
      },
    } as unknown as PoolClient,
    keys: () => taken,
  }
}

const locatorAt = (location: Record<string, string>, packageId: string): string =>
  JSON.stringify({ source: 'owned', kind: 'role', packageId, location })

describe('Postgres advisory helpers that name two keys', () => {
  it('takes ability preference packages in one order, whichever order it is given', async () => {
    // Two DIFFERENT packages, because the pair a move names collapses to one key when
    // both of its addresses belong to the same package — which is the ordinary case
    // and the reason this order is never exercised by a move today. The mirror image
    // is what the sort is for, and it has to hold before the case exists.
    const left = locatorAt({ scope: 'space', spaceId: 'space-main' }, 'AbCdefGhij_1')
    const right = locatorAt({ scope: 'space', spaceId: 'space-main' }, 'ZbCdefGhij_9')
    const forward = recordingClient()
    const mirrored = recordingClient()

    await lockAbilityPreferencePackages(forward.client, [left, right])
    await lockAbilityPreferencePackages(mirrored.client, [right, left])

    expect(forward.keys()).toEqual(mirrored.keys())
    expect(forward.keys()).toEqual(
      [abilityPackageOfLocator(left), abilityPackageOfLocator(right)].sort(),
    )
  })

  it('takes one key per package, however many addresses of it are named', async () => {
    // The two addresses of a real move: one package, one stripe. A helper that took
    // two would make the move wait on a key nothing else can be holding.
    const from = locatorAt(
      { scope: 'project', spaceId: 'space-main', projectId: 'project-a' },
      'AbCdefGhij_1',
    )
    const to = locatorAt({ scope: 'space', spaceId: 'space-main' }, 'AbCdefGhij_1')
    const recorded = recordingClient()

    await lockAbilityPreferencePackages(recorded.client, [from, to])

    expect(recorded.keys()).toEqual([abilityPackageOfLocator(from)])
  })

  it('takes scope pin targets in one order, whichever order it is given', async () => {
    const from = { targetKind: 'role', targetId: 'project:project-a:AbCdefGhij_1' }
    const to = { targetKind: 'role', targetId: 'space:space-main:AbCdefGhij_1' }
    const forward = recordingClient()
    const mirrored = recordingClient()

    await lockScopePinTargets(forward.client, [from, to])
    await lockScopePinTargets(mirrored.client, [to, from])

    // Sorted by the numeric KEY, which is what Postgres queues on — so the assertion
    // is that the two agree, not what the hashes happen to be.
    expect(forward.keys()).toEqual(mirrored.keys())
    expect(forward.keys()).toHaveLength(2)
  })

  it('takes one key per target, however often a target is named', async () => {
    const target = { targetKind: 'role', targetId: 'space:space-main:AbCdefGhij_1' }
    const recorded = recordingClient()

    await lockScopePinTargets(recorded.client, [target, target])

    expect(recorded.keys()).toHaveLength(1)
  })
})
