import { AGENT_RETRIEVAL_TOOL } from '@notarium/contract/enums'
import type { ToolName } from '@notarium/contract/tools'
import { AGENT_ACTIVITY_URL_PARAMS } from '../../libs/routing/routePaths'

export type ActivityGroup = 'none' | 'session'
export type ActivityShow = 'all' | 'reads' | 'writes'
export type ActivityOutcome = 'all' | 'success' | 'errors'

export type ActivityState = {
  group: ActivityGroup
  show: ActivityShow
  agent: string | null
  tool: ToolName | null
  q: string | null
  outcome: ActivityOutcome
}

const retrievalTools = new Set<string>(Object.values(AGENT_RETRIEVAL_TOOL))
export const ACTIVITY_TOOL_NAMES = [
  'start_session',
  'list_abilities',
  'get_ability',
  'create_ability',
  'edit_ability',
  'delete_ability',
  'use_role',
  'use_skill',
  'whoami',
  'get_my_projects',
  'list_notes',
  'recent_activity',
  'search',
  'get_note',
  'recall',
  'remember_about_user',
  'create_note',
  'remember_about_project',
  'edit_note',
  'delete_note',
  'move_note',
  'rename_note',
  'move_folder',
  'rename_folder',
  'rename_project',
  'link',
  'create_notes',
  'link_many',
] as const satisfies readonly ToolName[]
const toolNames = new Set<string>(ACTIVITY_TOOL_NAMES)

export const readActivityState = (params: URLSearchParams): ActivityState => {
  const agent = params.get(AGENT_ACTIVITY_URL_PARAMS.agent)?.trim() || null
  const toolParam = params.get(AGENT_ACTIVITY_URL_PARAMS.tool)
  const qParam = params.get(AGENT_ACTIVITY_URL_PARAMS.q)?.trim() || null
  const tool = toolParam && toolNames.has(toolParam) ? (toolParam as ToolName) : null
  const showParam = params.get(AGENT_ACTIVITY_URL_PARAMS.show)
  const requestedShow: ActivityShow =
    showParam === 'reads' || showParam === 'writes' ? showParam : 'all'
  const show: ActivityShow = qParam && requestedShow !== 'writes' ? 'reads' : requestedShow
  const q = show !== 'writes' && (!tool || retrievalTools.has(tool)) ? qParam : null
  const group =
    params.get(AGENT_ACTIVITY_URL_PARAMS.group) === 'session' &&
    !agent &&
    !tool &&
    !q &&
    !params.has(AGENT_ACTIVITY_URL_PARAMS.outcome)
      ? 'session'
      : 'none'

  const outcomeParam = params.get(AGENT_ACTIVITY_URL_PARAMS.outcome)
  const outcome: ActivityOutcome =
    outcomeParam === 'success' || outcomeParam === 'errors' ? outcomeParam : 'all'

  return { group, show, agent, tool, q, outcome }
}

export type ActivityPatch = Partial<{
  group: ActivityGroup
  show: ActivityShow
  agent: string | null
  tool: ToolName | null
  q: string | null
  outcome: ActivityOutcome
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
    if (patch.tool) {
      next.delete(AGENT_ACTIVITY_URL_PARAMS.group)
    }
  }
  if ('q' in patch) {
    set(AGENT_ACTIVITY_URL_PARAMS.q, patch.q)
  }
  if ('outcome' in patch) {
    set(AGENT_ACTIVITY_URL_PARAMS.outcome, patch.outcome, 'all')
    if (patch.outcome && patch.outcome !== 'all') {
      next.delete(AGENT_ACTIVITY_URL_PARAMS.group)
    }
  }

  if (patch.show === 'writes') {
    next.delete(AGENT_ACTIVITY_URL_PARAMS.q)
  }

  const agent = next.get(AGENT_ACTIVITY_URL_PARAMS.agent)?.trim()
  const q = next.get(AGENT_ACTIVITY_URL_PARAMS.q)?.trim()
  const tool = next.get(AGENT_ACTIVITY_URL_PARAMS.tool)

  if (!q) {
    next.delete(AGENT_ACTIVITY_URL_PARAMS.q)
  } else if (tool && !retrievalTools.has(tool)) {
    next.delete(AGENT_ACTIVITY_URL_PARAMS.q)
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
  } else if (!query) {
    next.delete(AGENT_ACTIVITY_URL_PARAMS.q)
  } else if (
    next.has(AGENT_ACTIVITY_URL_PARAMS.tool) &&
    !retrievalTools.has(next.get(AGENT_ACTIVITY_URL_PARAMS.tool)!)
  ) {
    next.delete(AGENT_ACTIVITY_URL_PARAMS.q)
  } else {
    next.set(AGENT_ACTIVITY_URL_PARAMS.q, query)
    next.set(AGENT_ACTIVITY_URL_PARAMS.show, 'reads')
  }

  if (!next.has(AGENT_ACTIVITY_URL_PARAMS.q) && show !== 'reads' && show !== 'writes') {
    next.delete(AGENT_ACTIVITY_URL_PARAMS.show)
  }
  if (!['success', 'errors'].includes(next.get(AGENT_ACTIVITY_URL_PARAMS.outcome) ?? '')) {
    next.delete(AGENT_ACTIVITY_URL_PARAMS.outcome)
  }
  if (next.get(AGENT_ACTIVITY_URL_PARAMS.group) !== 'session') {
    next.delete(AGENT_ACTIVITY_URL_PARAMS.group)
  }
  if (
    next.has(AGENT_ACTIVITY_URL_PARAMS.agent) ||
    next.has(AGENT_ACTIVITY_URL_PARAMS.tool) ||
    next.has(AGENT_ACTIVITY_URL_PARAMS.q)
  ) {
    next.delete(AGENT_ACTIVITY_URL_PARAMS.group)
  }
  if (next.has(AGENT_ACTIVITY_URL_PARAMS.outcome)) {
    next.delete(AGENT_ACTIVITY_URL_PARAMS.group)
  }

  return next
}
