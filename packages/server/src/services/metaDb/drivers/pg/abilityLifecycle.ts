import type { PoolClient } from 'pg'

import { abilityTargetLivePgQuery, abilityTargetPurged } from '../../abilityLifecycle'
import { lockRevisionKeys } from './revisionLocks'

/** The shared ability fence, taken the PostgreSQL way: the stripes first, the question
 *  after. Both keys are known before the first lock and are therefore sortable — which
 *  is the whole criterion the wide-scan mutex exists for (`lockOrder`, L3m), and the
 *  reason neither ability facet takes it. The stripes are what make the answer hold to
 *  COMMIT: a whole-Space purge holds `L3s` across its entire tier-3 pass, so a writer
 *  that has passed this point cannot be running while a purge decides, and one that
 *  arrives after it waits and then reads the fence the purge left.
 *
 *  A caller with no registry note (a host with no read-model barrier to ask) takes the
 *  Space stripe alone; L3n is simply not entered, and a register entry is a level list
 *  a run may be a SUBSEQUENCE of. */
export const assertAbilityTargetLive = async (
  client: PoolClient,
  spaceId: string,
  registryNoteId: string | null,
): Promise<void> => {
  await lockRevisionKeys(client, 'space', [spaceId])

  if (registryNoteId != null) {
    await lockRevisionKeys(client, 'note', [registryNoteId])
  }
  const { text, params } = abilityTargetLivePgQuery(spaceId, registryNoteId)
  const live = await client.query(text, [...params])

  if (!live.rows.length) {
    throw abilityTargetPurged(spaceId, registryNoteId)
  }
}
