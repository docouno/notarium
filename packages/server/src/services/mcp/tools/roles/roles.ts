import type { EffectiveRoleSummary } from '@notarium/contract'
import type {
  ListRolesInput,
  ListRolesOutput,
  UseRoleInput,
  UseRoleOutput,
} from '@notarium/contract/tools'

import type { ProjectRecord } from '../../../metaDb'
import { type EffectiveRoleContext, type LoadedEffectiveRole } from '../../../roles'
import { type Ctx, type Handler, ToolFailure } from '../../gateway'
import { renderRole } from '../../helpers/render'
import { sanitizeText } from '../../sanitize'
import { curateAgentContext, useRoleContextFrom } from '../session/agentContext'

const selectorOf = (input: { role?: string; name?: string }, tool: string): string => {
  const count = Number(input.role !== undefined) + Number(input.name !== undefined)

  if (count !== 1) {
    throw new ToolFailure('provide exactly one of role or name')
  }
  const field = input.role !== undefined ? 'role' : 'name'
  console.info(`[mcp] ${tool} selector=${field}`)
  return input.role ?? input.name!
}

export const roleContext = async (
  ctx: Ctx,
  project?: ProjectRecord,
): Promise<EffectiveRoleContext> => ({
  personalSpace: await ctx.personalSpace(),
  ...(project ? { project } : {}),
})

const safeSummary = <T extends { name: string; description: string }>(summary: T): T => ({
  ...summary,
  name: sanitizeText(summary.name),
  description: sanitizeText(summary.description),
  ...('origin' in summary && typeof summary.origin === 'string'
    ? { origin: sanitizeText(summary.origin) }
    : {}),
  ...('originRevision' in summary && typeof summary.originRevision === 'string'
    ? { originRevision: sanitizeText(summary.originRevision) }
    : {}),
})

export const assertRoleAvailable = <T extends { name: string; description: string }>(
  available: readonly T[],
  name: string,
  inventoryTruncated = false,
): T => {
  const summary = available.find((role) => role.name === name)

  if (!summary) {
    const names = available.slice(0, 20).map((role) => role.name)
    const pageIncomplete = available.length > names.length
    const tail = pageIncomplete ? `, … (${available.length} visible)` : ''
    const boundedHint =
      inventoryTruncated || pageIncomplete
        ? '; the inventory is bounded — call list_roles to inspect the available window'
        : ''
    throw new ToolFailure(
      names.length
        ? `role "${name}" is not effective in this scope — available roles: ${names.join(', ')}${tail}${boundedHint}`
        : inventoryTruncated
          ? `role "${name}" is not visible in the bounded inventory — call list_roles to inspect the available window`
          : `role "${name}" is not effective in this scope — add one from the Notarium catalog, or re-enable a System role the owner turned off`,
    )
  }

  return summary
}

export const activateRole = async (
  ctx: Ctx,
  context: EffectiveRoleContext,
  name: string,
  budgetTokens: number,
  preloaded?: LoadedEffectiveRole,
  knownListing?: { roles: EffectiveRoleSummary[]; truncated: boolean },
  precuratedContext?: UseRoleOutput['context'],
): Promise<UseRoleOutput> => {
  if (!ctx.roles) {
    throw new ToolFailure('roles are unavailable on this host')
  }
  const loaded =
    preloaded ?? (await ctx.roles.loadEffective(context, ctx.principal, name, budgetTokens))

  if (!loaded) {
    const listing = knownListing ?? (await ctx.roles.listEffective(context, ctx.principal))
    assertRoleAvailable(listing.roles, name, listing.truncated)
    throw new ToolFailure(`role "${name}" is not available in this scope`)
  }
  const contextBundle =
    precuratedContext ?? useRoleContextFrom(await curateAgentContext(ctx, context.project, loaded))
  let status: UseRoleOutput['status'] = 'activated'

  // Resolve every fallible package/context dependency before changing durable episode
  // state. A failed activation must never reappear as active on the next resume.
  if (ctx.agentSessions && ctx.session) {
    // The address the resolver landed on, not one rebuilt from its placement: a System
    // role has no placement to rebuild from, and every rebuild was a second producer.
    const set = await ctx.agentSessions.setRole(ctx.session, {
      name: loaded.role.name,
      locator: loaded.locator,
      contextProjectId: context.project?.id ?? null,
    })
    status = set.changed ? 'activated' : 'already_active'
  }

  // The loaded role carries its body; the body travels as its OWN field. Spreading the
  // whole thing put `instructions` inside the summary too, which the wire shape simply
  // stripped until its arms became strict.
  const { instructions, ...summary } = loaded.role

  return {
    status,
    role: safeSummary(summary),
    instructions: sanitizeText(instructions),
    skills: loaded.skills.map((skill) => ({
      name: sanitizeText(skill.name),
      description: sanitizeText(skill.description),
      instructions: sanitizeText(skill.instructions),
    })),
    context: contextBundle,
    ...(loaded.truncated ? { truncated: true } : {}),
  }
}

export const handleUseRole: Handler = async (ctx, rawArgs) => {
  const input = rawArgs as UseRoleInput
  const name = selectorOf(input, 'use_role')
  const project = input.project ? await ctx.resolveProject(input.project) : undefined
  const structured = await activateRole(
    ctx,
    await roleContext(ctx, project),
    name,
    input.budgetTokens,
  )
  return { markdown: renderRole(structured), structured }
}

export const handleListRoles: Handler = async (ctx, rawArgs) => {
  const input = rawArgs as ListRolesInput
  const project = input.project ? await ctx.resolveProject(input.project) : undefined
  const listing = ctx.roles
    ? await ctx.roles.listEffective(await roleContext(ctx, project), ctx.principal)
    : { roles: [], truncated: false }
  const available = listing.roles
  const offset = Number(input.cursor ?? 0)
  const roles = available.slice(offset, offset + input.limit).map(safeSummary)
  const next = offset + roles.length
  const structured: ListRolesOutput = {
    roles,
    total: available.length,
    ...(next < available.length ? { nextCursor: String(next) } : {}),
    ...(listing.truncated ? { truncated: true } : {}),
  }
  const lines = roles.length
    ? [
        `**Effective roles ${offset + 1}-${next} of ${available.length}:**`,
        // A System role has no placement to name, so its SOURCE is what the line states.
        ...roles.map(
          (role) =>
            `- \`${role.name}\` (${role.source === 'system' ? 'system' : role.scope}) — ${role.description}`,
        ),
      ]
    : ['No effective roles in this page.']

  if (structured.nextCursor) {
    lines.push(`Continue with cursor \`${structured.nextCursor}\`.`)
  }
  if (structured.truncated) {
    lines.push(
      'Warning: the owned role library exceeded host bounds; this total and page are not exhaustive.',
    )
  }

  return { markdown: lines.join('\n'), structured }
}

export const startSessionRoleSelector = (input: {
  role?: string
  name?: string
}): string | null => {
  if (input.role === undefined && input.name === undefined) {
    return null
  }

  return selectorOf(input, 'start_session')
}
