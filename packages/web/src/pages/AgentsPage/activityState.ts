import type { AgentRetrievalTool } from '@notarium/contract'
import { AGENT_RETRIEVAL_TOOL } from '@notarium/contract/enums'
import { AGENT_ACTIVITY_URL_PARAMS } from '../../libs/routing/routePaths'

export type ActivityGroup = 'none' | 'session'
export type ActivityShow = 'all' | 'reads' | 'writes'

export type ActivityState = {
  group: ActivityGroup
  show: ActivityShow
  agent: string | null
  tool: AgentRetrievalTool | null
  q: string | null
}

const retrievalTools = new Set<string>(Object.values(AGENT_RETRIEVAL_TOOL))

export const readActivityState = (params: URLSearchParams): ActivityState => {
  const agent = params.get(AGENT_ACTIVITY_URL_PARAMS.agent)?.trim() || null
  const toolParam = params.get(AGENT_ACTIVITY_URL_PARAMS.tool)
  const qParam = params.get(AGENT_ACTIVITY_URL_PARAMS.q)?.trim() || null
  const tool = toolParam && retrievalTools.has(toolParam) ? (toolParam as AgentRetrievalTool) : null
  const showParam = params.get(AGENT_ACTIVITY_URL_PARAMS.show)
  const requestedShow: ActivityShow =
    showParam === 'reads' || showParam === 'writes' ? showParam : 'all'
  const show: ActivityShow = qParam && requestedShow !== 'writes' ? 'reads' : requestedShow
  const q = show !== 'writes' ? qParam : null
  const group =
    params.get(AGENT_ACTIVITY_URL_PARAMS.group) === 'session' && !agent && !q ? 'session' : 'none'

  return { group, show, agent, tool: q ? tool : null, q }
}

export type ActivityPatch = Partial<{
  group: ActivityGroup
  show: ActivityShow
  agent: string | null
  tool: AgentRetrievalTool | null
  q: string | null
}>

/** One interaction produces one URL mutation while preserving unrelated keys. */
export const patchActivityState = (
  current: URLSearchParams,
  patch: ActivityPatch,
): URLSearchParams => {
  const next = new URLSearchParams(current)

  const set = (key: string, value: string | null | undefined, defaultValue?: string) => {
    if (!value || value === defaultValue) {
      next.delete(key)
    } else {
      next.set(key, value)
    }
  }

  if ('group' in patch) {
    set(AGENT_ACTIVITY_URL_PARAMS.group, patch.group, 'none')
  }
  if ('show' in patch) {
    set(AGENT_ACTIVITY_URL_PARAMS.show, patch.show, 'all')
  }
  if ('agent' in patch) {
    set(AGENT_ACTIVITY_URL_PARAMS.agent, patch.agent)
  }
  if ('tool' in patch) {
    set(AGENT_ACTIVITY_URL_PARAMS.tool, patch.tool)
  }
  if ('q' in patch) {
    set(AGENT_ACTIVITY_URL_PARAMS.q, patch.q)
  }

  if (patch.show === 'writes') {
    next.delete(AGENT_ACTIVITY_URL_PARAMS.tool)
    next.delete(AGENT_ACTIVITY_URL_PARAMS.q)
  }

  const agent = next.get(AGENT_ACTIVITY_URL_PARAMS.agent)?.trim()
  const q = next.get(AGENT_ACTIVITY_URL_PARAMS.q)?.trim()
  const tool = next.get(AGENT_ACTIVITY_URL_PARAMS.tool)

  if (!q) {
    next.delete(AGENT_ACTIVITY_URL_PARAMS.q)
    next.delete(AGENT_ACTIVITY_URL_PARAMS.tool)
  } else if (tool && !retrievalTools.has(tool)) {
    next.delete(AGENT_ACTIVITY_URL_PARAMS.tool)
  }
  if (
    next.has(AGENT_ACTIVITY_URL_PARAMS.q) &&
    next.get(AGENT_ACTIVITY_URL_PARAMS.show) !== 'writes'
  ) {
    next.set(AGENT_ACTIVITY_URL_PARAMS.show, 'reads')
  }
  if (agent || next.has(AGENT_ACTIVITY_URL_PARAMS.q)) {
    next.delete(AGENT_ACTIVITY_URL_PARAMS.group)
  }

  return next
}

/** Remove defaults and invalid combinations from a hand-authored/deprecated URL
 *  without touching neighboring parameters owned by another concern. */
export const canonicalActivityParams = (current: URLSearchParams): URLSearchParams => {
  const next = patchActivityState(current, {})
  const rawAgent = next.get(AGENT_ACTIVITY_URL_PARAMS.agent)
  const agent = rawAgent?.trim()

  if (!agent) {
    next.delete(AGENT_ACTIVITY_URL_PARAMS.agent)
  } else if (agent !== rawAgent) {
    next.set(AGENT_ACTIVITY_URL_PARAMS.agent, agent)
  }

  const rawQuery = next.get(AGENT_ACTIVITY_URL_PARAMS.q)
  const query = rawQuery?.trim()
  const show = next.get(AGENT_ACTIVITY_URL_PARAMS.show)

  if (show === 'writes') {
    next.delete(AGENT_ACTIVITY_URL_PARAMS.q)
    next.delete(AGENT_ACTIVITY_URL_PARAMS.tool)
  } else if (!query) {
    next.delete(AGENT_ACTIVITY_URL_PARAMS.q)
    next.delete(AGENT_ACTIVITY_URL_PARAMS.tool)
  } else {
    next.set(AGENT_ACTIVITY_URL_PARAMS.q, query)
    next.set(AGENT_ACTIVITY_URL_PARAMS.show, 'reads')
  }

  if (!next.has(AGENT_ACTIVITY_URL_PARAMS.q) && show !== 'reads' && show !== 'writes') {
    next.delete(AGENT_ACTIVITY_URL_PARAMS.show)
  }
  if (next.get(AGENT_ACTIVITY_URL_PARAMS.group) !== 'session') {
    next.delete(AGENT_ACTIVITY_URL_PARAMS.group)
  }
  if (next.has(AGENT_ACTIVITY_URL_PARAMS.agent) || next.has(AGENT_ACTIVITY_URL_PARAMS.q)) {
    next.delete(AGENT_ACTIVITY_URL_PARAMS.group)
  }

  return next
}
