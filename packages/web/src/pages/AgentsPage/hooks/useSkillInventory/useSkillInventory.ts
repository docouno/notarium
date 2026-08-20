import { useCallback, useRef, useState } from 'react'
import type { AgentAbilitySummary, MeAgentSkillsResponse } from '@notarium/contract'
import { loadSkillInventory, type SkillInventory } from '../../helpers/skillInventory'

export type SkillInventoryState = {
  /** The listing facts of the Space last read — `projects` above all, which name the
   *  destinations the aside and the Catalog dialog offer. */
  inventory: MeAgentSkillsResponse | null
  /** Every skill the drain reached, for resolving a role's exact attachments. */
  skills: AgentAbilitySummary[]
  read: (targetSpaceId?: string | null) => Promise<SkillInventory>
}

/** The ability page's inventory, read per Space and guarded like every other reader
 *  in the app. It is the page's LONGEST request — the drain walks up to twenty pages
 *  — so it is the one most likely to land after the reader has already walked on:
 *  open role A of one Space, then B of another, and A's answer arriving second used
 *  to name B's "Belongs to" with A's ids, offer A's Space's projects under "Add
 *  version" and send "Configure context" into the wrong Space. The guard lives HERE,
 *  with the only writer of this state, so it cannot be forgotten at a call site — the
 *  page reads the inventory from three of them. */
export const useSkillInventory = (defaultSpaceId: string | null): SkillInventoryState => {
  const [inventory, setInventory] = useState<MeAgentSkillsResponse | null>(null)
  const [skills, setSkills] = useState<AgentAbilitySummary[]>([])
  const seq = useRef(0)

  const read = useCallback(
    async (targetSpaceId: string | null = defaultSpaceId) => {
      const request = ++seq.current
      const loaded = await loadSkillInventory(targetSpaceId)

      // Superseded: a later read is already addressing a different Space, and this
      // answer would put that Space's page back on the previous one's inventory.
      if (request === seq.current) {
        setInventory(loaded.first)
        setSkills(loaded.all)
      }

      return loaded
    },
    [defaultSpaceId],
  )

  return { inventory, skills, read }
}
