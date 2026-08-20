import type { AgentAbilitySummary, MeAgentSkillsResponse } from '@notarium/contract'
import { drainPages } from '../../../../libs/paging'
import { api } from '../../../../services/api'

const PAGE_SIZE = 100
// The role editor offers whole inventories, so it drains the cursor — and a drain
// needs a floor, which `drainPages` owns for every cursor reader.
const MAX_PAGES = 20

export type SkillInventory = {
  /** The first page — the response carrying `projects` and the other listing facts. */
  first: MeAgentSkillsResponse
  /** Every skill the drain reached, across pages. */
  all: AgentAbilitySummary[]
}

/** Read the whole skill inventory a role may attach from, for one Space. */
export const loadSkillInventory = async (spaceId?: string | null): Promise<SkillInventory> => {
  const scope = spaceId ? { spaceId } : {}
  const first = await api.agentSkillsGet({ ...scope, limit: PAGE_SIZE })
  const all: AgentAbilitySummary[] = [...first.items]

  await drainPages((cursor) => api.agentSkillsGet({ ...scope, limit: PAGE_SIZE, cursor }), {
    from: first.nextCursor,
    pages: MAX_PAGES - 1,
    cursorOf: (page) => page.nextCursor,
    onPage: (page) => {
      all.push(...page.items)
    },
  })

  return { first, all }
}
